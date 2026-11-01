// M5 AI-13 — 실행 중인 Claude PTY 세션의 transcript(jsonl)를 꼬리 읽기로 따라가 채팅 메시지로 민다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/native-chat/session-file-resolver.ts(경로)·transcript-tail-reader.ts·
// transcript-incremental-reader.ts(끝에서 시작·이어 읽기·잘리면 처음부터) — 핵심만. 뺀 것: WSL·SSH 경로, 계정별 프로필 폴더, 취소 신호.
//
// 성능 원칙: **열린 채팅 화면만** 감시한다(open/close). 파일 변경 이벤트(fs.watch) + 스로틀. 파일이 아직 없으면 1초마다 다시 건다.
// 경로: 훅(UserPromptSubmit 등)이 주는 transcript_path 가 정답(Orca: "Hook paths are authoritative"). 탭 → 경로를 userData 에
// 남겨 앱을 다시 켜도(데몬에 산 에이전트) 바로 연다.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { createChatModel, takeLines, transcriptHint, type AgentChatEvent, type AgentChatSnapshot, type ChatMessage, type ChatModel } from '@shared/agentChat'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'

/** 처음 열 때 끝에서 이만큼만 읽는다(긴 대화 — Orca 꼬리 읽기). 잘린 첫 줄은 버린다. */
export const INITIAL_TAIL_BYTES = 2 * 1024 * 1024
/** 변경 이벤트 → 읽기까지. 이 사이 쓰기는 한 번으로 묶인다. */
export const CHAT_THROTTLE_MS = 150
const RETRY_MS = 1000

/** Claude 기록 뿌리 — CLAUDE_CONFIG_DIR 이 있으면 그것, 없으면 <home>/.claude (Orca claudeProjectsHostDirs). */
export function claudeProjectsDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [env['CLAUDE_CONFIG_DIR'] ? join(env['CLAUDE_CONFIG_DIR'], 'projects') : null, join(home, '.claude', 'projects')]
  return [...new Set(dirs.filter((d): d is string => !!d))]
}

/** 세션 id → <projects>/<아무 폴더>/<id>.jsonl. 없으면 null. */
export function resolveClaudeTranscript(sessionId: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      const p = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  }
  return null
}

type Watched = { path: string | null; offset: number; carry: string; model: ChatModel; watcher: FSWatcher | null; timer: ReturnType<typeof setTimeout> | null }

export type ChatWatcher = {
  /** 훅 본문 — transcript_path 를 기억하고, 열린 화면이면 그 파일로 옮긴다(/clear 뒤 새 세션). */
  hook(paneKey: string, payload: Record<string, unknown>): void
  open(paneKey: string): AgentChatSnapshot
  close(paneKey: string): void
  /** 탭이 끝남 — 기억한 경로도 지운다. */
  forget(paneKey: string): void
  stop(): void
}

export function createChatWatcher(deps: { push: (e: AgentChatEvent) => void; store: string; home: string; env?: NodeJS.ProcessEnv; throttleMs?: number }): ChatWatcher {
  const throttle = deps.throttleMs ?? CHAT_THROTTLE_MS
  const saved = readJsonWithBackup<unknown>(deps.store, null)
  const paths = new Map<string, string>(
    saved && typeof saved === 'object' ? Object.entries(saved as Record<string, unknown>).filter((x): x is [string, string] => typeof x[1] === 'string') : []
  )
  const save = (): void => {
    try {
      writeJsonAtomic(deps.store, Object.fromEntries(paths))
    } catch {
      /* 못 남기면 다시 켠 뒤 다음 훅까지 빈 채팅 */
    }
  }
  const open = new Map<string, Watched>()

  /** 새로 쓰인 만큼 읽어 모델에 넣는다. 바뀐 것이 없으면 null. */
  const read = (w: Watched): { messages: ChatMessage[]; reset: boolean } | null => {
    if (!w.path) return null
    let size: number
    try {
      size = statSync(w.path).size
    } catch {
      return null
    }
    let reset = false
    if (size < w.offset) {
      // 잘렸다(다시 쓴 파일) — 처음부터.
      w.offset = 0
      w.carry = ''
      w.model = createChatModel()
      reset = true
    }
    if (size === w.offset) return reset ? { messages: [], reset } : null
    let start = w.offset
    let skipFirst = false
    if (start === 0 && size > INITIAL_TAIL_BYTES) {
      start = size - INITIAL_TAIL_BYTES
      skipFirst = true
    }
    const buf = Buffer.alloc(size - start)
    const fd = openSync(w.path, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    // 끝이 덜 쓴 UTF-8 이어도 carry 가 그 줄을 통째로 미루므로 깨진 글자는 다음 읽기에서 온전해진다.
    let text = buf.toString('utf8')
    if (skipFirst) text = text.slice(text.indexOf('\n') + 1)
    w.offset = size
    const { lines, carry } = takeLines(w.carry, text)
    w.carry = carry
    return { messages: w.model.add(lines), reset }
  }

  const schedule = (id: string, w: Watched, ms = throttle): void => {
    if (w.timer) return
    w.timer = setTimeout(() => {
      w.timer = null
      if (open.get(id) !== w) return
      arm(id, w)
      const r = read(w)
      // 잘려서 처음부터 읽었으면 모델 전체를 다시 보낸다.
      if (r && (r.messages.length || r.reset)) deps.push({ sessionId: id, messages: r.reset ? w.model.messages() : r.messages, ...(r.reset ? { reset: true } : {}) })
    }, ms)
  }

  /** 파일에 감시를 건다. 아직 없으면 잠시 뒤 다시(Claude 는 첫 메시지를 쓸 때 파일을 만든다). */
  const arm = (id: string, w: Watched): void => {
    if (w.watcher || !w.path) return
    try {
      w.watcher = watch(w.path, () => schedule(id, w))
      w.watcher.on('error', () => {
        w.watcher?.close()
        w.watcher = null
        schedule(id, w, RETRY_MS)
      })
    } catch {
      schedule(id, w, RETRY_MS)
    }
  }

  const start = (id: string): Watched => {
    const w: Watched = { path: paths.get(id) ?? null, offset: 0, carry: '', model: createChatModel(), watcher: null, timer: null }
    open.set(id, w)
    arm(id, w)
    read(w) // 처음 것은 open 의 응답(스냅숏)으로 간다 — 따로 밀지 않는다
    return w
  }

  const stopOne = (id: string): void => {
    const w = open.get(id)
    if (!w) return
    w.watcher?.close()
    if (w.timer) clearTimeout(w.timer)
    open.delete(id)
  }

  return {
    hook(paneKey, payload) {
      const hint = transcriptHint(payload)
      const path = hint.path ?? (hint.sessionId ? resolveClaudeTranscript(hint.sessionId, claudeProjectsDirs(deps.home, deps.env)) : null)
      if (!path || paths.get(paneKey) === path) return
      paths.set(paneKey, path)
      save()
      if (!open.has(paneKey)) return
      stopOne(paneKey)
      deps.push({ sessionId: paneKey, messages: start(paneKey).model.messages(), reset: true })
    },
    open(paneKey) {
      stopOne(paneKey)
      const w = start(paneKey)
      return { messages: w.model.messages(), file: w.path }
    },
    close: stopOne,
    forget(paneKey) {
      stopOne(paneKey)
      if (paths.delete(paneKey)) save()
    },
    stop() {
      for (const id of [...open.keys()]) stopOne(id)
    }
  }
}
