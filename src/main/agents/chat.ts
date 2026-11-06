// M5 AI-13 — 실행 중인 Claude PTY 세션의 transcript(jsonl)를 꼬리 읽기로 따라가 채팅 메시지로 민다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/native-chat/session-file-resolver.ts(경로)·transcript-tail-reader.ts·
// transcript-incremental-reader.ts(끝에서 시작·이어 읽기·잘리면 처음부터) — 핵심만. 뺀 것: WSL·SSH 경로, 계정별 프로필 폴더, 취소 신호.
//
// 성능 원칙: **열린 채팅 화면만** 감시한다(open/close). 파일 변경 이벤트(fs.watch) + 스로틀. 파일이 아직 없으면 0.5초부터 5초까지 늘려 가며 다시 건다
// (Orca transcript-watch 해석 폴링 — Claude 는 첫 메시지를 쓸 때 파일을 만들어 훅이 준 경로가 잠깐 비어 있다).
// 경로: 훅(UserPromptSubmit 등)이 주는 transcript_path 가 정답(Orca: "Hook paths are authoritative"). 탭 → 경로를 userData 에
// 남겨 앱을 다시 켜도(데몬에 산 에이전트) 바로 연다.
// R2 Codex·Gemini: Codex 는 아라가 훅을 안 심어(신뢰 해시) 경로를 못 받는다 — $CODEX_HOME/sessions/Y/M/D/rollout-*.jsonl 중 그 탭의
// 폴더(session_meta.cwd)·띄운 시각 뒤에 생긴 것을 고른다(Orca 는 훅 session_id 로 찾는다). Gemini 는 훅(BeforeAgent 등)의 transcript_path,
// 없으면 session_id 앞 8자로 ~/.gemini/tmp/*/chats 에서. 옛 .json(통째로 다시 씀)은 바뀔 때마다 통째로 다시 읽는다.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentId } from '@shared/agents'
import { createChatModel, DECODERS, geminiDocLines, takeLines, transcriptHint, type AgentChatEvent, type AgentChatSnapshot, type ChatMessage, type ChatModel } from '@shared/agentChat'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { parseGeminiDocument, parseSessionLines } from '@shared/vault'

/** 처음 열 때 끝에서 이만큼만 읽는다(긴 대화 — Orca 꼬리 읽기). 잘린 첫 줄은 버린다. */
export const INITIAL_TAIL_BYTES = 2 * 1024 * 1024
/** 변경 이벤트 → 읽기까지. 이 사이 쓰기는 한 번으로 묶인다(Orca transcript-watch-scheduler 40ms). */
export const CHAT_THROTTLE_MS = 40
const RETRY_MS = 1000
/** 훅이 준 경로에 파일이 아직 없을 때 다시 보는 간격 — 처음 0.5초, 두 배씩 5초까지(Orca INITIAL/MAX_RESOLVE_POLL_MS). */
export const MISSING_POLL_MS = 500
export const MISSING_POLL_MAX_MS = 5000

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

/** Codex rollout 뿌리 — $CODEX_HOME/sessions, 없으면 <home>/.codex/sessions (Orca session-scanner-roots). */
export function codexSessionsDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([env['CODEX_HOME'] ? join(env['CODEX_HOME'], 'sessions') : null, join(home, '.codex', 'sessions')].filter((d): d is string => !!d))]
}

const ROLLOUT = /^rollout-.+\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1000
/** 띄운 시각과 파일 시각의 어긋남 허용. */
const SKEW_MS = 5000
/** 같은 폴더 비교 — Windows 는 대소문자를 가리지 않는다. */
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

/** 파일 첫 줄(최대 64KB). */
function firstLine(p: string): string {
  const fd = openSync(p, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8').split('\n')[0]
  } finally {
    closeSync(fd)
  }
}

/**
 * 그 탭의 Codex rollout — 오늘·어제 날짜 폴더(로컬·UTC)에서 session_meta.cwd 가 같고 since 뒤에 시작한 것 중 가장 이른 것(다른 탭이 가진 것은 뺀다).
 * ponytail: 같은 폴더에서 Codex 탭 둘을 몇 초 사이로 띄우고 늦게 띄운 쪽이 먼저 말하면 바뀔 수 있다 — Codex 훅(신뢰 해시)을 심으면 session_id 로 정확히.
 */
export function findCodexRollout(roots: readonly string[], cwd: string, since: number, taken: ReadonlySet<string>, now = Date.now()): string | null {
  const days = new Set<string>()
  const pad = (n: number): string => String(n).padStart(2, '0')
  for (const t of [now, now - DAY_MS]) {
    const d = new Date(t)
    days.add(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    days.add(join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())))
  }
  let best: { path: string; at: number } | null = null
  for (const root of roots) {
    for (const day of days) {
      let names: string[] = []
      try {
        names = readdirSync(join(root, day)).filter((n) => ROLLOUT.test(n))
      } catch {
        continue
      }
      for (const n of names) {
        const p = join(root, day, n)
        if (taken.has(p)) continue
        try {
          const mtime = statSync(p).mtimeMs
          if (mtime < since - SKEW_MS) continue
          const head = JSON.parse(firstLine(p)) as { type?: unknown; payload?: { cwd?: unknown; timestamp?: unknown } }
          if (head.type !== 'session_meta' || typeof head.payload?.cwd !== 'string' || !samePath(head.payload.cwd, cwd)) continue
          const parsed = Date.parse(String(head.payload.timestamp ?? ''))
          const at = Number.isNaN(parsed) ? mtime : parsed
          if (at < since - SKEW_MS) continue
          if (!best || at < best.at) best = { path: p, at }
        } catch {
          /* 쓰는 중·깨진 파일 — 다음 시도에서 */
        }
      }
    }
  }
  return best?.path ?? null
}

/** Gemini 세션 id → <home>/.gemini/tmp/<프로젝트>/chats/session-…-<id 앞 8자>.json(l). */
export function resolveGeminiTranscript(sessionId: string, home: string): string | null {
  const tmp = join(home, '.gemini', 'tmp')
  const tail = sessionId.slice(0, 8)
  let projects: string[] = []
  try {
    projects = readdirSync(tmp)
  } catch {
    return null
  }
  for (const p of projects) {
    try {
      const hit = readdirSync(join(tmp, p, 'chats')).find((n) => n.startsWith('session-') && (n.endsWith(`-${tail}.json`) || n.endsWith(`-${tail}.jsonl`)))
      if (hit) return join(tmp, p, 'chats', hit)
    } catch {
      /* chats 없음 */
    }
  }
  return null
}

type Watched = { agent: AgentId; path: string | null; offset: number; stamp: string; carry: string; model: ChatModel; watcher: FSWatcher | null; timer: ReturnType<typeof setTimeout> | null; poll: number }

export type ChatWatcher = {
  /** 탭이 무슨 에이전트·어느 폴더·언제 띄웠나(디코더·Codex 파일 찾기). 띄울 때·되살릴 때. */
  bind(paneKey: string, o: { agent: AgentId; cwd: string; startedAt: number }): void
  /** 훅 본문 — transcript_path 를 기억하고, 열린 화면이면 그 파일로 옮긴다(/clear 뒤 새 세션). */
  hook(paneKey: string, payload: Record<string, unknown>, agent?: AgentId): void
  open(paneKey: string): AgentChatSnapshot
  close(paneKey: string): void
  /** 탭이 끝남 — 기억한 경로도 지운다. */
  forget(paneKey: string): void
  /** M10 WS-16 재우기: 그 탭의 CLI 세션 id(깨울 때 resume) — transcript 머리에서 읽는다. 모르면 null. */
  resumeId(paneKey: string): string | null
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
  const bound = new Map<string, { agent: AgentId; cwd: string; startedAt: number }>()
  const agentOf = (id: string): AgentId => bound.get(id)?.agent ?? 'claude'
  const remember = (id: string, path: string): void => {
    paths.set(id, path)
    save()
  }
  /** 경로가 아직 없으면 — Codex 는 파일을 찾아본다(훅이 없다). */
  const findPath = (id: string): string | null => {
    const known = paths.get(id)
    const b = bound.get(id)
    if (known || b?.agent !== 'codex') return known ?? null
    const others = new Set([...paths].filter((x) => x[0] !== id).map((x) => x[1]))
    const found = findCodexRollout(codexSessionsDirs(deps.home, deps.env), b.cwd, b.startedAt, others)
    if (found) remember(id, found)
    return found
  }

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
    // Gemini 옛 .json — 통째로 다시 쓰는 한 문서. 바뀌었으면 통째로 다시 읽는다(reset).
    if (w.path.toLowerCase().endsWith('.json')) {
      let stamp = ''
      let lines: string[] | null = null
      try {
        stamp = `${size}:${statSync(w.path).mtimeMs}`
        if (stamp === w.stamp) return null
        lines = geminiDocLines(readFileSync(w.path, 'utf8'))
      } catch {
        return null
      }
      if (!lines) return null // 쓰는 중 — 다음 변경에
      w.stamp = stamp
      w.model = createChatModel(undefined, DECODERS[w.agent])
      w.model.add(lines)
      return { messages: [], reset: true }
    }
    if (size < w.offset) {
      // 잘렸다(다시 쓴 파일) — 처음부터.
      w.offset = 0
      w.carry = ''
      w.model = createChatModel(undefined, DECODERS[w.agent])
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
    if (!w.path) {
      w.path = findPath(id)
      if (!w.path) {
        if (w.agent === 'codex') schedule(id, w, RETRY_MS)
        return
      }
    }
    if (w.watcher) return
    if (!existsSync(w.path)) {
      schedule(id, w, w.poll)
      w.poll = Math.min(w.poll * 2, MISSING_POLL_MAX_MS)
      return
    }
    w.poll = MISSING_POLL_MS
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
    const agent = agentOf(id)
    const w: Watched = { agent, path: findPath(id), offset: 0, stamp: '', carry: '', model: createChatModel(undefined, DECODERS[agent]), watcher: null, timer: null, poll: MISSING_POLL_MS }
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
    bind(paneKey, o) {
      bound.set(paneKey, o)
    },
    hook(paneKey, payload, agent = 'claude') {
      const hint = transcriptHint(payload)
      const byId = (id: string): string | null => (agent === 'gemini' ? resolveGeminiTranscript(id, deps.home) : resolveClaudeTranscript(id, claudeProjectsDirs(deps.home, deps.env)))
      const path = hint.path ?? (hint.sessionId ? byId(hint.sessionId) : null)
      if (!path || paths.get(paneKey) === path) return
      if (!bound.has(paneKey)) bound.set(paneKey, { agent, cwd: '', startedAt: 0 })
      remember(paneKey, path)
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
    resumeId(paneKey) {
      const path = findPath(paneKey)
      return path ? resumeIdFromTranscript(agentOf(paneKey), path) : null
    },
    forget(paneKey) {
      stopOne(paneKey)
      bound.delete(paneKey)
      if (paths.delete(paneKey)) save()
    },
    stop() {
      for (const id of [...open.keys()]) stopOne(id)
    }
  }
}

/** transcript 머리(64KB)에서 세션 id — 지난 세션 목록(vault)과 같은 해석(Claude sessionId·Codex session_meta·Gemini 문서 sessionId). */
export function resumeIdFromTranscript(agent: AgentId, path: string): string | null {
  try {
    if (agent === 'gemini' && path.toLowerCase().endsWith('.json')) return parseGeminiDocument(readFileSync(path, 'utf8')).id
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(RESUME_HEAD_BYTES)
      const n = readSync(fd, buf, 0, buf.length, 0)
      const lines = buf.subarray(0, n).toString('utf8').split('\n')
      if (n === buf.length) lines.pop() // 잘린 끝 줄
      return parseSessionLines(agent, lines).id
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
const RESUME_HEAD_BYTES = 64 * 1024
