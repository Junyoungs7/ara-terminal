// M3 에이전트 — 렌더러 상태(zustand). Orca slices/detected-agents.ts(감지 목록) + 터미널 탭(terminal-tab-agent-launch-pane.ts)의 1차 부분.
// 탭은 main 의 로컬 세션(space:'ai'). R2: 에이전트 상태(훅 + 화면 판정)를 'agents:status' 로 받고 봄/안 봄(done·idle)을 여기서 가른다.
// AI 작업 공간 청크 안에 산다 — 처음 열 때만 불러온다.
import { create } from 'zustand'
import type { AgentId, AgentSettings, DetectedAgent } from '@shared/agents'
import type { AgentLaunchResult, AgentTabInfo } from '@shared/ipc'
import { AGENT_SESSION_LOST_EXIT, type AgentStatusView } from '@shared/agentHooks'
import { areWorktreePathsEqual } from '@shared/worktrees'
import { AGENTS } from '@shared/agents'
import { nextSeen } from './agentStatusView'
import { FEED_CAP, feedKindOf, noteKindOf, type FeedEvent, type FeedKind } from './agentBoard'
import { useAiwsStore } from './store'
import { agentNotesEnabled, openNoteVia, pushNote } from '../../store/notify'
import { isLockedNow } from '../../store/lock'
import { t } from '../../i18n'

export type AgentTab = {
  sessionId: string
  agent: AgentId
  /** 어느 작업 단위의 탭인가 — 사이드바에서 고른 워크트리의 탭만 보인다. */
  worktreeId: string
  title: string
  /** 셸에 친 한 줄(탭 제목 툴팁 — 무엇이 실행됐는지 감추지 않는다). */
  line: string
  exited: boolean
  /** M4 DM-01: 데몬이 죽어 세션을 잃었다(종료와 구별해 그린다). */
  lost?: boolean
  /** 첫 지시(넣지 못했을 때 사람이 붙여 넣게 보여 준다). */
  prompt?: string
}

type AgentState = {
  /** null = 아직 안 찾음. */
  detected: DetectedAgent[] | null
  detecting: boolean
  settings: AgentSettings | null
  tabs: AgentTab[]
  activeTabByWorktree: Record<string, string>
  /** 탭(세션)별 에이전트 상태 — main 원장의 사본. */
  statusById: Record<string, AgentStatusView>
  /** 봤나(herdr seen). 없으면 본 것. */
  seenById: Record<string, boolean>
  /** 지금 화면에 보이는 에이전트 탭(AI 작업 공간이 열려 있고 그 탭이 고른 탭). 없으면 null. */
  viewing: string | null
  /** 가운데에 무엇을 그리나 — 고른 작업 단위(탭) · 대시보드(AI-08) · 활동 피드(AI-09). 레일이 바꾼다. */
  view: AiwsView
  /** 활동 피드(AI-09) — 상태 변화 이력, 들어온 순. 그릴 때 feedView 로 최신이 위. */
  feed: FeedEvent[]
  loadAgents: (force?: boolean) => Promise<void>
  saveSettings: (next: AgentSettings) => Promise<void>
  /** resume = 지난 세션 id(M4 AI-07) — 첫 지시 대신 재개로 띄운다. */
  launchAgent: (o: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string; resume?: string }) => Promise<AgentLaunchResult>
  setActiveTab: (worktreeId: string, sessionId: string) => void
  closeTab: (sessionId: string) => void
  setViewing: (sessionId: string | null) => void
  setView: (view: AiwsView) => void
}

export type AiwsView = 'worktree' | 'dashboard' | 'activity' | 'sessions'

export const useAgentStore = create<AgentState>()((set, get) => ({
  detected: null,
  detecting: false,
  settings: null,
  tabs: [],
  activeTabByWorktree: {},
  statusById: {},
  seenById: {},
  viewing: null,
  view: 'worktree',
  feed: [],

  loadAgents: async (force) => {
    startStatus()
    if (get().detecting) return
    set({ detecting: true })
    try {
      const [settings, detected] = await Promise.all([window.ev.agents.getSettings(), window.ev.agents.detect(force)])
      set({ settings, detected })
    } finally {
      set({ detecting: false })
    }
  },

  saveSettings: async (next) => {
    set({ settings: next })
    set({ settings: await window.ev.agents.setSettings(next) })
  },

  launchAgent: async ({ agent, worktreeId, cwd, prompt, resume }) => {
    const r = await window.ev.agents.launch(agent, cwd, prompt, resume)
    if (!r.ok) return r
    const tab: AgentTab = { sessionId: r.sessionId, agent, worktreeId, title: r.title, line: r.line, exited: false, ...(prompt?.trim() ? { prompt } : {}) }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: r.sessionId } }))
    watchExit(r.sessionId)
    return r
  },

  setActiveTab: (worktreeId, sessionId) => set((s) => ({ activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: sessionId } })),

  closeTab: (sessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    if (!tab.exited) void window.ev.session.destroy(sessionId)
    const pending = pendingNotes.get(sessionId)
    if (pending) clearTimeout(pending.timer)
    pendingNotes.delete(sessionId)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.sessionId !== sessionId)
      const { [sessionId]: _st, ...statusById } = s.statusById
      const { [sessionId]: _seen, ...seenById } = s.seenById
      const active = { ...s.activeTabByWorktree }
      if (active[tab.worktreeId] === sessionId) {
        const rest = tabs.filter((t) => t.worktreeId === tab.worktreeId)
        if (rest.length) active[tab.worktreeId] = rest[rest.length - 1].sessionId
        else delete active[tab.worktreeId]
      }
      return { tabs, activeTabByWorktree: active, statusById, seenById }
    })
  },

  // 탭을 보면 본 것(herdr: 그 칸으로 가면 seen = true).
  setViewing: (sessionId) => set((s) => ({ viewing: sessionId, ...(sessionId ? { seenById: { ...s.seenById, [sessionId]: true } } : {}) })),

  setView: (view) => set({ view })
}))

/** 그 에이전트 탭으로 — 워크트리를 고르고 그 탭을 고른 뒤 가운데를 탭 화면으로(대시보드 카드·피드·알림이 같은 길). */
export function revealAgent(sessionId: string): void {
  const tab = useAgentStore.getState().tabs.find((x) => x.sessionId === sessionId)
  if (!tab) return
  useAiwsStore.getState().setActiveWorktree(tab.worktreeId)
  useAgentStore.getState().setActiveTab(tab.worktreeId, sessionId)
  useAgentStore.getState().setView('worktree')
}

/** 워크트리 이름(카드·피드·알림 줄). 지워졌으면 id 그대로. */
export function worktreeName(worktreeId: string): string {
  return (
    Object.values(useAiwsStore.getState().worktreesByRepo)
      .flat()
      .find((w) => w.id === worktreeId)?.displayName ?? worktreeId
  )
}

/**
 * 알림은 잠깐 늦춘다 — 잠깐 막혔다가 스스로 이어 가는 CLI 가 자기 알림을 거둘 수 있게(옛 aiQuietWatch 의 1.5초 규칙 그대로).
 * 피드·보드는 즉시(그리는 것은 값이 싸다), 알림은 한 번 뜨면 사람이 치워야 한다.
 */
export const NOTE_DELAY_MS = 1_500
const pendingNotes = new Map<string, { kind: FeedKind; timer: ReturnType<typeof setTimeout> }>()

function sendAgentNote(sessionId: string, kind: FeedKind): void {
  const s = useAgentStore.getState()
  const tab = s.tabs.find((x) => x.sessionId === sessionId)
  // 늦추는 사이 그 탭을 열었으면 보낼 것이 없다.
  const nk = noteKindOf(kind, s.viewing === sessionId && typeof document !== 'undefined' && document.hasFocus(), agentNotesEnabled())
  if (!tab || !nk) return
  const title = t(`aiws.note.${kind}`).replace('{a}', AGENTS[tab.agent].label).replace('{w}', worktreeName(tab.worktreeId))
  const note = pushNote({ kind: nk, space: 'ai', target: { type: 'task', id: sessionId }, title, body: t(`aiws.note.${kind}.body`), go: () => revealAgent(sessionId) })
  // 앱이 뒤에 있을 때만 OS 알림(옛 aiQuietWatch 와 같은 방식 — 렌더러 Notification). 앞에 있으면 토스트·벨로 충분하다.
  if (typeof document === 'undefined' || document.hasFocus()) return
  try {
    // 앱 잠금 중에는 내용 없이(작업 이름·에이전트를 화면 밖으로 흘리지 않는다).
    const hide = isLockedNow()
    const n = new Notification(hide ? t('lock.notify.title') : title, { body: hide ? t('lock.notify.body') : note.body, tag: `ara-agent-${sessionId}-${kind}` })
    n.onclick = () => {
      window.focus()
      openNoteVia(note)
    }
  } catch {
    // 알림 권한이 없거나 OS 가 막았다 — 토스트·벨·맥박은 그대로.
  }
}

/** 상태가 바뀔 때 — 피드에 남기고 알림을 예약한다. 다른 종류로 바뀌면 걸린 예약은 거둔다(같은 종류의 도구 변화는 그대로 둔다). */
function onTransition(prev: AgentStatusView | undefined, next: AgentStatusView, viewingNow: boolean, now = Date.now()): void {
  const kind = feedKindOf(prev, next)
  const pending = pendingNotes.get(next.sessionId)
  if (pending && kind && pending.kind !== kind) {
    clearTimeout(pending.timer)
    pendingNotes.delete(next.sessionId)
  }
  if (!kind) return
  useAgentStore.setState((s) => ({ feed: [...s.feed, { id: ++feedSeq, at: now, sessionId: next.sessionId, kind, estimated: next.estimated }].slice(-FEED_CAP) }))
  if (!noteKindOf(kind, viewingNow, agentNotesEnabled())) return
  pendingNotes.set(next.sessionId, {
    kind,
    timer: setTimeout(() => {
      pendingNotes.delete(next.sessionId)
      sendAgentNote(next.sessionId, kind)
    }, NOTE_DELAY_MS)
  })
}
let feedSeq = 0

/** 탭의 세션이 끝나면 '종료' — 데몬이 죽어 잃었으면 '잃음'(M4 DM-01). */
function watchExit(sessionId: string): void {
  const off = window.ev.session.onExit(sessionId, (info) => {
    off()
    const lost = info.exitCode === AGENT_SESSION_LOST_EXIT
    useAgentStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, exited: true, ...(lost ? { lost: true } : {}) } : t)) }))
  })
}

/**
 * M4 DM-01: 데몬에서 되살린 탭을 올린다. 워크트리는 cwd 로 찾는다(id 는 repoId::path) — 목록이 아직 안 올라왔으면 올라올 때 다시.
 * ponytail: 끝내 못 찾는 탭(워크트리를 지움)은 안 보인 채 구독이 남는다 — 세션은 데몬에 살아 [백그라운드 에이전트 모두 종료]로 끈다.
 */
function restoreTabs(list: AgentTabInfo[]): void {
  let pending = list.filter((x) => !useAgentStore.getState().tabs.some((t) => t.sessionId === x.sessionId))
  const place = (): boolean => {
    const all = Object.values(useAiwsStore.getState().worktreesByRepo).flat()
    const found: AgentTab[] = []
    pending = pending.filter((x) => {
      const w = all.find((w) => areWorktreePathsEqual(w.path, x.cwd, /^[A-Za-z]:/.test(x.cwd) ? 'win32' : 'other'))
      if (w) found.push({ sessionId: x.sessionId, agent: x.agent, worktreeId: w.id, title: x.title, line: x.line, exited: false, ...(x.prompt ? { prompt: x.prompt } : {}) })
      return !w
    })
    if (found.length) {
      useAgentStore.setState((s) => ({
        tabs: [...s.tabs, ...found],
        activeTabByWorktree: { ...Object.fromEntries(found.map((t) => [t.worktreeId, t.sessionId])), ...s.activeTabByWorktree }
      }))
      found.forEach((t) => watchExit(t.sessionId))
    }
    return pending.length === 0
  }
  if (!place()) {
    const unsub = useAiwsStore.subscribe(() => place() && unsub())
  }
}

let statusStarted = false
/** 상태 구독 — AI 작업 공간을 처음 열 때(피커가 감지를 부를 때) 한 번. 창이 늦게 떠도 지금까지의 상태를 받아 온다. */
function startStatus(): void {
  if (statusStarted) return
  statusStarted = true
  const apply = (v: AgentStatusView): void => {
    const s = useAgentStore.getState()
    const prev = s.statusById[v.sessionId]
    // 탭이 아직 안 올라왔어도(launch 응답보다 상태가 먼저) 상태는 담아 둔다 — 탭이 생기면 그대로 보인다.
    const viewingNow = s.viewing === v.sessionId && typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
    const seen = nextSeen(prev, v, s.seenById[v.sessionId] ?? true, viewingNow)
    useAgentStore.setState((x) => ({ statusById: { ...x.statusById, [v.sessionId]: v }, seenById: { ...x.seenById, [v.sessionId]: seen } }))
    onTransition(prev, v, viewingNow)
  }
  window.ev.agents.onStatus(apply)
  // M4 DM-01: 앱을 다시 켰으면 데몬에 살아 있던 에이전트 탭을 되살린다.
  void window.ev.agents
    .tabs()
    .then(restoreTabs)
    .catch(() => {})
  void window.ev.agents
    .statuses()
    .then((list) => list.forEach(apply))
    .catch(() => {})
}

/** 피커가 처음 고를 에이전트 — 기본 에이전트가 설치·켜짐이면 그것, 아니면 설치된 첫 것. */
export function pickInitialAgent(settings: AgentSettings | null, detected: DetectedAgent[] | null): AgentId | null {
  const usable = (detected ?? []).filter((d) => d.installed && settings?.agents[d.id].enabled !== false).map((d) => d.id)
  if (settings && usable.includes(settings.defaultAgent)) return settings.defaultAgent
  return usable[0] ?? null
}
