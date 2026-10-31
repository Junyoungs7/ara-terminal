// M3 에이전트 — 렌더러 상태(features/aiws/agentStore.ts). window.ev 를 가짜로 세워 main 없이 돈다(진짜 CLI 안 띄움).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentSettings, type DetectedAgent } from '@shared/agents'

const exits = new Map<string, () => void>()
let n = 0
const ev = {
  agents: {
    detect: vi.fn(async (): Promise<DetectedAgent[]> => [
      { id: 'claude', installed: false, path: null, version: null },
      { id: 'codex', installed: true, path: '/bin/codex', version: '0.46.0' },
      { id: 'gemini', installed: true, path: '/bin/gemini', version: null }
    ]),
    getSettings: vi.fn(async () => defaultAgentSettings()),
    setSettings: vi.fn(async (s: unknown) => s),
    launch: vi.fn(async (agent: string, cwd: string) =>
      cwd === '/bad' ? { ok: false as const, error: '폴더가 없습니다' } : { ok: true as const, sessionId: `s${++n}`, title: `${agent} · x`, line: agent }
    )
  },
  session: {
    onExit: vi.fn((id: string, cb: () => void) => {
      exits.set(id, cb)
      return () => exits.delete(id)
    }),
    destroy: vi.fn(async () => ({ ok: true }))
  }
}

let m: typeof import('../src/renderer/features/aiws/agentStore')
beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { ev }
  m = await import('../src/renderer/features/aiws/agentStore')
})
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})
beforeEach(() => {
  m.useAgentStore.setState({ tabs: [], activeTabByWorktree: {}, detected: null, settings: null })
})

describe('agentStore', () => {
  it('감지 + 처음 고를 에이전트 — 기본(claude)이 설치 안 됐으면 설치된 첫 것', async () => {
    await m.useAgentStore.getState().loadAgents()
    const { settings, detected } = m.useAgentStore.getState()
    expect(m.pickInitialAgent(settings, detected)).toBe('codex')
    // 끈 에이전트는 고르지 않는다
    const off = { ...settings!, agents: { ...settings!.agents, codex: { ...settings!.agents.codex, enabled: false } } }
    expect(m.pickInitialAgent(off, detected)).toBe('gemini')
    expect(m.pickInitialAgent(null, null)).toBeNull()
  })

  it('실행 → 그 작업 단위의 탭이 되고 활성, 셸이 끝나면 종료', async () => {
    const r = await m.useAgentStore.getState().launchAgent({ agent: 'codex', worktreeId: 'w1', cwd: '/repo', prompt: 'hi' })
    expect(r.ok).toBe(true)
    expect(ev.agents.launch).toHaveBeenCalledWith('codex', '/repo', 'hi')
    let s = m.useAgentStore.getState()
    expect(s.tabs).toMatchObject([{ sessionId: 's1', agent: 'codex', worktreeId: 'w1', exited: false }])
    expect(s.activeTabByWorktree.w1).toBe('s1')
    exits.get('s1')!()
    s = m.useAgentStore.getState()
    expect(s.tabs[0].exited).toBe(true)
  })

  it('실패는 탭을 안 만든다', async () => {
    const r = await m.useAgentStore.getState().launchAgent({ agent: 'codex', worktreeId: 'w1', cwd: '/bad' })
    expect(r).toEqual({ ok: false, error: '폴더가 없습니다' })
    expect(m.useAgentStore.getState().tabs).toEqual([])
  })

  it('탭 닫기 — 살아 있으면 세션을 끄고, 활성이면 같은 작업 단위의 마지막 탭으로', async () => {
    const st = m.useAgentStore.getState()
    const a = await st.launchAgent({ agent: 'codex', worktreeId: 'w1', cwd: '/r' })
    const b = await st.launchAgent({ agent: 'gemini', worktreeId: 'w1', cwd: '/r' })
    await st.launchAgent({ agent: 'codex', worktreeId: 'w2', cwd: '/r' })
    if (!a.ok || !b.ok) throw new Error('x')
    st.closeTab(b.sessionId)
    expect(ev.session.destroy).toHaveBeenCalledWith(b.sessionId)
    expect(m.useAgentStore.getState().activeTabByWorktree.w1).toBe(a.sessionId)
    exits.get(a.sessionId)!()
    st.closeTab(a.sessionId)
    expect(ev.session.destroy).not.toHaveBeenCalledWith(a.sessionId) // 이미 끝난 셸
    expect(m.useAgentStore.getState().activeTabByWorktree.w1).toBeUndefined()
    expect(m.useAgentStore.getState().tabs.map((t) => t.worktreeId)).toEqual(['w2'])
  })
})
