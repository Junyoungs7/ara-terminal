// M3 라운드 2 — 에이전트 탭 상태 원장(main). 훅(AI-04)과 화면 판정(AI-05 herdr 매니페스트)을 합쳐 렌더러로 민다.
// 화면은 헤드리스 xterm(screenText.ts 와 같은 렌더 규칙)에 그 탭 출력을 흘려 그린 결과를 읽는다 — 원시 바이트가 아니라 사람이 보는 화면이다.
// 성능 원칙: AI 작업 공간 에이전트 탭만 추적(첫 실행 때 걸림)·출력이 바뀔 때만·스로틀(EVAL_MS)·스크롤백 작게.
//
// 첫 지시(launch intent): Windows 셸(PowerShell 5.1·cmd + npm .cmd 셔임)은 인자 속 `"`·`&`·`%`·줄바꿈을 다시 읽어 깨뜨린다.
// 그래서 지시 글을 명령줄에 싣지 않고, 에이전트 입력 상자가 화면에 뜨고 출력이 잠잠해진 뒤 **입력으로** 넣는다
// (Orca promptInjectionMode 'stdin-after-start'·draft-paste-ready-scanner 의 1차). 셸에 치는 일은 없다 — 준비가 안 보이면 넣지 않는다.
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { AgentId } from '@shared/agents'
import { detectScreen, promptBoxBody, type ScreenDetection, type ScreenInput } from '@shared/agentScreen'
import { applyHookEvent, HOOK_SILENT_MS, resolveStatus, type AgentStatusView, type HookPane } from '@shared/agentHooks'
import type { Session } from '@shared/types'
import type { SessionTap } from '../sessions/MainSessionManager'
import type { HookEvent } from './hooks'
import { agentLiveTitle } from '@shared/agentTabTitle'

/** 출력 뒤 판정까지(스로틀). 이 사이 출력은 한 번으로 묶인다. */
const EVAL_MS = 250
/** 화면 판정에 넘길 줄 — 보이는 줄 + 위로 이만큼(herdr 의 "최근 화면"). */
const RECENT_SCROLLBACK = 40
/** 입력 상자가 보인 뒤 출력이 이만큼 잠잠해야 넣는다(그리는 중에 치지 않게). */
const PROMPT_QUIET_MS = 300
/** 이 안에 입력 상자가 안 보이면 넣지 않고 렌더러에 알린다(사람이 직접 친다). */
export const PROMPT_TIMEOUT_MS = 45_000
/** 평문으로 칠 슬래시 명령의 길이 상한(Orca: 1KiB 넘으면 붙여넣기). */
const SLASH_PLAIN_MAX = 1024

/**
 * 에이전트 입력 상자가 지금 화면에 떠 있나(첫 지시를 넣어도 되나). herdr 판정 위에 얹은 CLI 별 한 줄:
 *  · claude — 프롬프트 상자(live_prompt_box: 위아래 가로줄 사이 `❯`). 신뢰 확인·로그인 화면이면 아니다.
 *  · codex  — 현재 입력 줄 `› `(뒤에 응답 표시가 없는 마지막 것)이 있고 막힘(신뢰 확인)·일하는 중이 아니다.
 *  · gemini — 입력 상자 안내 문구("Type your message")가 있고 막힘이 아니다.
 */
export function composerReady(agent: AgentId, input: ScreenInput, d: ScreenDetection): boolean {
  if (d.state === 'blocked' || d.skip) return false
  // 2.1.300 은 입력 줄 머리가 ❯ 가 아니라 > 다(2.2.15 실측 — 못 알아봐 채팅 전송·끝남 띠가 둘 다 죽었다).
  // herdr 매니페스트(live_prompt_box)는 원본과 같게 두고 여기서 받는다.
  if (agent === 'claude') return d.rule === 'live_prompt_box' || (d.state === 'idle' && /^\s*>/m.test(promptBoxBody(input.screen)))
  const lines = input.screen.split('\n')
  if (agent === 'codex') {
    if (d.state === 'working') return false
    for (let k = lines.length - 1; k >= 0; k--) {
      if (/^[•■✗✓]/u.test(lines[k])) return false
      if (lines[k] === '›' || lines[k].startsWith('› ')) return true
    }
    return false
  }
  return input.screen.toLowerCase().includes('type your message')
}

/** 넣을 바이트. 괄호 붙여넣기(줄바꿈이 제출이 안 되게). codex 는 Windows 에서 입력 레코드로 읽어 괄호를 못 쓴다 — 줄바꿈을 Alt+Enter 로(Orca windowsInputRecordPasteNewline). */
export function promptBytes(agent: AgentId, text: string, win: boolean): string {
  const t = text.replace(/\r\n?/g, '\n')
  // 한 줄 슬래시 명령(`/model opus`·`/clear`)은 그대로 친다 — 붙여넣기로 감싸면 TUI 가 명령이 아니라 글로 받는다(Orca native-chat-paste-bytes:
  // 짧은 한 줄은 평문, Enter 는 따로).
  if (/^\/\S/.test(t) && !t.includes('\n') && t.length <= SLASH_PLAIN_MAX) return t
  if (agent === 'codex' && win) return t.replace(/\n/g, '\x1b\r')
  return `\x1b[200~${t}\x1b[201~`
}

/** 붙여 넣은 뒤 Enter 까지(Orca: ConPTY 64B/ms 흡수 + 0.5초 안정 · 입력 레코드 TUI 는 글자당 3ms). */
export function submitDelayMs(agent: AgentId, text: string, win: boolean): number {
  const bytes = Buffer.byteLength(text, 'utf8')
  return 500 + Math.ceil(bytes / (win ? 64 : 4096)) + (agent === 'codex' && win ? text.length * 3 : 0)
}

/**
 * M11 에이전트가 끝나고 셸만 남았나 — 아라 에이전트 탭은 셸에 실행 줄을 친다(Orca 는 패인 프로세스 종료로 본다). 입력 상자를 한 번 본 뒤
 * 화면 마지막 줄이 셸 프롬프트면 끝난 것. PowerShell `PS C:\x>` · cmd `C:\x>` · posix `user@host:~/x$`·`~/x %`.
 * ponytail: 프롬프트 모양 판정 — 사용자가 프롬프트를 크게 바꿨으면 못 알아본다(그때는 셸이 끝날 때만 재시작 칩).
 */
export function shellPromptVisible(screen: string): boolean {
  const last = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .pop() ?? ''
  return /^PS .+>$/.test(last) || /^[A-Za-z]:\\[^>]*>$/.test(last) || /^\S*[@:~/]\S*\s?[$#%]$/.test(last)
}

type Entry = {
  agent: AgentId
  term: Terminal
  title: string
  progress: string
  hook: { pane: HookPane; event: string } | null
  screen: ScreenDetection | null
  view: AgentStatusView | null
  evalTimer: ReturnType<typeof setTimeout> | null
  silentTimer: ReturnType<typeof setTimeout> | null
  lastOutputAt: number
  prompt: { text: string; deadline: number } | null
  promptFailed: boolean
  /** 입력 상자를 한 번이라도 봤다 — 그 뒤의 채팅 입력은 일하는 중에도 넣는다(Claude 는 턴 중 입력을 줄 세운다). */
  composerSeen: boolean
  /** M11 에이전트가 끝나고 셸 프롬프트만 남았다(재시작 칩). 입력 상자가 다시 보이면 풀린다. */
  agentExited: boolean
}

export type AgentStatusTracker = SessionTap & {
  track(o: { sessionId: string; agent: AgentId; cols?: number; rows?: number; prompt?: string }): void
  /** M5 채팅 입력 — 첫 지시와 같은 길(입력 상자가 뜬 뒤). 바로 쓰면 셸(PSReadLine 미리 읽기)이 먹는다. 추적 안 하는 탭이면 false. */
  submit(sessionId: string, text: string): boolean
  hook(e: HookEvent): void
  views(): AgentStatusView[]
}

export function createAgentStatusTracker(deps: {
  push: (v: AgentStatusView) => void
  write: (sessionId: string, data: string) => void
  now?: () => number
  win?: boolean
  /** 시험용(기본 PROMPT_TIMEOUT_MS). */
  promptTimeoutMs?: number
}): AgentStatusTracker {
  const now = deps.now ?? Date.now
  const win = deps.win ?? process.platform === 'win32'
  const promptTimeout = deps.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
  const entries = new Map<string, Entry>()

  const screenOf = (e: Entry): ScreenInput => {
    const buf = e.term.buffer.active
    const from = Math.max(0, buf.length - e.term.rows - RECENT_SCROLLBACK)
    const lines: string[] = []
    for (let i = from; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return { screen: lines.join('\n'), oscTitle: e.title, oscProgress: e.progress }
  }

  const publish = (id: string, e: Entry): void => {
    // M11 탭 제목: 에이전트가 OSC 로 정한 작업 요약 — 입력 상자를 본 뒤(셸이 아니라 에이전트가 쓴 제목)만. 상태 글리프는 떼서 비교한다(스피너마다 밀지 않게).
    const title = e.composerSeen ? agentLiveTitle(e.agent, e.title) : null
    // 앞 상태를 그대로 쓰는 갈래(화면 판정 건너뜀)에서도 제목·끝남은 지금 값으로.
    const { title: _title, agentExited: _exited, ...base } = resolveStatus(id, e.hook, e.screen, e.view, now())
    const view = { ...base, ...(e.promptFailed ? { promptFailed: true } : {}), ...(title ? { title } : {}), ...(e.agentExited ? { agentExited: true as const } : {}) }
    if (JSON.stringify(view) === JSON.stringify(e.view)) return
    e.view = view
    deps.push(view)
    // 훅이 '일하는 중'에서 말이 없으면 2분 뒤 화면을 다시 본다(Esc 로 끊은 턴은 Stop 이 안 온다) — 그때는 출력도 없다.
    if (e.silentTimer) clearTimeout(e.silentTimer)
    e.silentTimer = null
    if (view.state === 'working' && !view.estimated && e.hook) {
      e.silentTimer = setTimeout(() => evaluate(id), Math.max(0, e.hook.pane.at + HOOK_SILENT_MS + 1000 - now()))
    }
  }

  const deliver = (id: string, e: Entry, input: ScreenInput): void => {
    const p = e.prompt
    if (!p) return
    if (now() > p.deadline) {
      e.prompt = null
      e.promptFailed = true
      return
    }
    if (!e.screen) return
    // 처음 한 번은 입력 상자가 보여야 넣는다(셸 단계엔 절대 안 침). 본 뒤에는 막힘(승인·질문 창)만 아니면 넣는다.
    // 일하는 중(스피너가 계속 그림)엔 잠잠함을 기다리지 않는다 — 턴이 길면 제한 시간에 걸린다.
    const ready = composerReady(e.agent, input, e.screen)
    if (!ready && (!e.composerSeen || e.screen.state === 'blocked')) return
    const quiet = now() - e.lastOutputAt
    if (ready && quiet < PROMPT_QUIET_MS) {
      schedule(id, e, PROMPT_QUIET_MS - quiet)
      return
    }
    e.prompt = null
    deps.write(id, promptBytes(e.agent, p.text, win))
    setTimeout(() => deps.write(id, '\r'), submitDelayMs(e.agent, p.text, win))
  }

  function evaluate(id: string): void {
    const e = entries.get(id)
    if (!e) return
    e.evalTimer = null
    const input = screenOf(e)
    const d = detectScreen(e.agent, input)
    if (!d.skip) e.screen = d
    // 마지막 줄이 셸 프롬프트면 에이전트는 없다(위에 남은 입력 상자 그림은 지난 화면이다).
    const shell = shellPromptVisible(input.screen)
    if (!shell && e.screen && composerReady(e.agent, input, e.screen)) e.composerSeen = true
    e.agentExited = e.composerSeen && shell
    deliver(id, e, input)
    publish(id, e)
  }

  function schedule(id: string, e: Entry, ms = EVAL_MS): void {
    if (e.evalTimer) return
    e.evalTimer = setTimeout(() => evaluate(id), ms)
  }

  return {
    track({ sessionId, agent, cols, rows, prompt }) {
      const term = new Terminal({ cols: cols ?? 80, rows: rows ?? 24, scrollback: 200, allowProposedApi: true })
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
      const e: Entry = {
        agent,
        term,
        title: '',
        progress: '',
        hook: null,
        screen: null,
        view: null,
        evalTimer: null,
        silentTimer: null,
        lastOutputAt: now(),
        prompt: prompt ? { text: prompt, deadline: now() + promptTimeout } : null,
        promptFailed: false,
        composerSeen: false,
        agentExited: false
      }
      term.onTitleChange((t) => {
        e.title = t
      })
      // OSC 9;4 진행 보고(herdr osc_progress) — 값 부분만(`4;0` …).
      term.parser.registerOscHandler(9, (data) => {
        if (data.startsWith('4;')) e.progress = data
        return true
      })
      entries.set(sessionId, e)
      // 첫 지시가 있으면 출력이 없어도 제한 시간이 지나면 실패를 알린다.
      if (prompt) setTimeout(() => evaluate(sessionId), promptTimeout + 50)
    },
    submit(sessionId, text) {
      const e = entries.get(sessionId)
      if (!e) return false
      // 아직 못 넣은 것이 있으면 이어 붙인다(잃지 않게).
      e.prompt = { text: e.prompt ? `${e.prompt.text}
${text}` : text, deadline: now() + promptTimeout }
      e.promptFailed = false
      if (!e.evalTimer) evaluate(sessionId)
      setTimeout(() => evaluate(sessionId), promptTimeout + 50)
      return true
    },
    hook(ev) {
      const e = entries.get(ev.paneKey)
      if (!e) return // 우리 에이전트 탭이 아니다(이미 닫힌 탭 등) — 아무 주장도 안 한다.
      const next = applyHookEvent(e.hook?.pane ?? null, ev.source, ev.payload, now())
      if (!next) return
      e.hook = { pane: next, event: String(ev.payload['hook_event_name']) }
      publish(ev.paneKey, e)
    },
    views: () => [...entries.values()].flatMap((e) => (e.view ? [e.view] : [])),
    data(meta: Session, chunk: Uint8Array) {
      const e = entries.get(meta.id)
      if (!e) return
      e.lastOutputAt = now()
      e.term.write(chunk, () => schedule(meta.id, e))
    },
    resize(id, cols, rows) {
      entries.get(id)?.term.resize(cols, rows)
    },
    exit(id) {
      const e = entries.get(id)
      if (!e) return
      if (e.evalTimer) clearTimeout(e.evalTimer)
      if (e.silentTimer) clearTimeout(e.silentTimer)
      e.term.dispose()
      entries.delete(id)
    }
  }
}
