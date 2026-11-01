// M3 에이전트 — 렌더러 상태(zustand). Orca slices/detected-agents.ts(감지 목록) + 터미널 탭(terminal-tab-agent-launch-pane.ts)의 1차 부분.
// 탭은 main 의 로컬 세션(space:'ai'). R2: 에이전트 상태(훅 + 화면 판정)를 'agents:status' 로 받고 봄/안 봄(done·idle)을 여기서 가른다.
// AI 작업 공간 청크 안에 산다 — 처음 열 때만 불러온다.
import { create } from 'zustand'
import type { AgentId, AgentSettings, DetectedAgent } from '@shared/agents'
import type { AgentLaunchResult } from '@shared/ipc'
import type { AgentStatusView } from '@shared/agentHooks'
import { nextSeen } from './agentStatusView'

export type AgentTab = {
  sessionId: string
  agent: AgentId
  /** 어느 작업 단위의 탭인가 — 사이드바에서 고른 워크트리의 탭만 보인다. */
  worktreeId: string
  title: string
  /** 셸에 친 한 줄(탭 제목 툴팁 — 무엇이 실행됐는지 감추지 않는다). */
  line: string
  exited: boolean
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
  loadAgents: (force?: boolean) => Promise<void>
  saveSettings: (next: AgentSettings) => Promise<void>
  launchAgent: (o: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string }) => Promise<AgentLaunchResult>
  setActiveTab: (worktreeId: string, sessionId: string) => void
  closeTab: (sessionId: string) => void
  setViewing: (sessionId: string | null) => void
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  detected: null,
  detecting: false,
  settings: null,
  tabs: [],
  activeTabByWorktree: {},
  statusById: {},
  seenById: {},
  viewing: null,

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

  launchAgent: async ({ agent, worktreeId, cwd, prompt }) => {
    const r = await window.ev.agents.launch(agent, cwd, prompt)
    if (!r.ok) return r
    const tab: AgentTab = { sessionId: r.sessionId, agent, worktreeId, title: r.title, line: r.line, exited: false, ...(prompt?.trim() ? { prompt } : {}) }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: r.sessionId } }))
    const off = window.ev.session.onExit(r.sessionId, () => {
      off()
      set((s) => ({ tabs: s.tabs.map((t) => (t.sessionId === r.sessionId ? { ...t, exited: true } : t)) }))
    })
    return r
  },

  setActiveTab: (worktreeId, sessionId) => set((s) => ({ activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: sessionId } })),

  closeTab: (sessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    if (!tab.exited) void window.ev.session.destroy(sessionId)
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
  setViewing: (sessionId) => set((s) => ({ viewing: sessionId, ...(sessionId ? { seenById: { ...s.seenById, [sessionId]: true } } : {}) }))
}))

let statusStarted = false
/** 상태 구독 — AI 작업 공간을 처음 열 때(피커가 감지를 부를 때) 한 번. 창이 늦게 떠도 지금까지의 상태를 받아 온다. */
function startStatus(): void {
  if (statusStarted) return
  statusStarted = true
  const apply = (v: AgentStatusView): void =>
    useAgentStore.setState((s) => {
      // 탭이 아직 안 올라왔어도(launch 응답보다 상태가 먼저) 상태는 담아 둔다 — 탭이 생기면 그대로 보인다.
      const viewingNow = s.viewing === v.sessionId && typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
      const seen = nextSeen(s.statusById[v.sessionId], v, s.seenById[v.sessionId] ?? true, viewingNow)
      return { statusById: { ...s.statusById, [v.sessionId]: v }, seenById: { ...s.seenById, [v.sessionId]: seen } }
    })
  window.ev.agents.onStatus(apply)
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
