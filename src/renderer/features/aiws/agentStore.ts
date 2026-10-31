// M3 에이전트 — 렌더러 상태(zustand). Orca slices/detected-agents.ts(감지 목록) + 터미널 탭(terminal-tab-agent-launch-pane.ts)의 1차 부분.
// 탭은 main 의 로컬 세션(space:'ai')이고 상태는 "실행 중 / 종료"만(점·훅은 라운드 2).
// AI 작업 공간 청크 안에 산다 — 처음 열 때만 불러온다.
import { create } from 'zustand'
import type { AgentId, AgentSettings, DetectedAgent } from '@shared/agents'
import type { AgentLaunchResult } from '@shared/ipc'

export type AgentTab = {
  sessionId: string
  agent: AgentId
  /** 어느 작업 단위의 탭인가 — 사이드바에서 고른 워크트리의 탭만 보인다. */
  worktreeId: string
  title: string
  /** 셸에 친 한 줄(탭 제목 툴팁 — 무엇이 실행됐는지 감추지 않는다). */
  line: string
  exited: boolean
}

type AgentState = {
  /** null = 아직 안 찾음. */
  detected: DetectedAgent[] | null
  detecting: boolean
  settings: AgentSettings | null
  tabs: AgentTab[]
  activeTabByWorktree: Record<string, string>
  loadAgents: (force?: boolean) => Promise<void>
  saveSettings: (next: AgentSettings) => Promise<void>
  launchAgent: (o: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string }) => Promise<AgentLaunchResult>
  setActiveTab: (worktreeId: string, sessionId: string) => void
  closeTab: (sessionId: string) => void
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  detected: null,
  detecting: false,
  settings: null,
  tabs: [],
  activeTabByWorktree: {},

  loadAgents: async (force) => {
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
    const tab: AgentTab = { sessionId: r.sessionId, agent, worktreeId, title: r.title, line: r.line, exited: false }
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
      const active = { ...s.activeTabByWorktree }
      if (active[tab.worktreeId] === sessionId) {
        const rest = tabs.filter((t) => t.worktreeId === tab.worktreeId)
        if (rest.length) active[tab.worktreeId] = rest[rest.length - 1].sessionId
        else delete active[tab.worktreeId]
      }
      return { tabs, activeTabByWorktree: active }
    })
  }
}))

/** 피커가 처음 고를 에이전트 — 기본 에이전트가 설치·켜짐이면 그것, 아니면 설치된 첫 것. */
export function pickInitialAgent(settings: AgentSettings | null, detected: DetectedAgent[] | null): AgentId | null {
  const usable = (detected ?? []).filter((d) => d.installed && settings?.agents[d.id].enabled !== false).map((d) => d.id)
  if (settings && usable.includes(settings.defaultAgent)) return settings.defaultAgent
  return usable[0] ?? null
}
