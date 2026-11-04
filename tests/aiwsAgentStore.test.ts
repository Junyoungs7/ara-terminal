// M3 에이전트 — 렌더러 상태(features/aiws/agentStore.ts). window.ev 를 가짜로 세워 main 없이 돈다(진짜 CLI 안 띄움).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentSettings, type DetectedAgent } from '@shared/agents'
import { AGENT_SESSION_LOST_EXIT, type AgentStatusView } from '@shared/agentHooks'

const exits = new Map<string, (info?: { id: string; exitCode: number }) => void>()
let pushStatus: ((v: AgentStatusView) => void) | null = null
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
    ),
    statuses: vi.fn(async () => []),
    // M4 DM-01: 켤 때 데몬에서 되살린 탭(여기선 없음).
    tabs: vi.fn(async () => []),
    onStatus: vi.fn((cb: (v: AgentStatusView) => void) => {
      pushStatus = cb
      return () => {}
    }),
    onName: vi.fn(() => () => {}), // M5 AI-19
    onTitle: vi.fn(() => () => {}), // M11
    onViewers: vi.fn(() => () => {}), // R1
    forgetRemote: vi.fn(async () => {}),
    // M8 R4 끊긴 원격 탭 닫기·다시 연결
    killRemote: vi.fn(async () => true),
    reconnect: vi.fn(async () => ({ ok: true as const, tabs: [] }))
  },
  session: {
    onExit: vi.fn((id: string, cb: (info: { id: string; exitCode: number }) => void) => {
      exits.set(id, (info = { id, exitCode: 0 }) => cb(info))
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
  m.useAgentStore.setState({ tabs: [], activeTabByWorktree: {}, detected: null, settings: null, statusById: {}, seenById: {}, viewing: null })
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
    expect(ev.agents.launch).toHaveBeenCalledWith('codex', '/repo', 'hi', undefined, undefined, undefined) // 4번째 = 재개 id(M4 AI-07), 5번째 = 피커 옵션(M5), 6번째 = 실행 위치(M8 — 로컬 프로젝트면 없음)
    let s = m.useAgentStore.getState()
    expect(s.tabs).toMatchObject([{ sessionId: 's1', agent: 'codex', worktreeId: 'w1', exited: false }])
    expect(s.activeTabByWorktree.w1).toBe('s1')
    exits.get('s1')!()
    s = m.useAgentStore.getState()
    expect(s.tabs[0].exited).toBe(true)
  })

  it('M4: 데몬이 죽어 끝난 탭은 잃음(종료와 구별)', async () => {
    const r = await m.useAgentStore.getState().launchAgent({ agent: 'codex', worktreeId: 'wl', cwd: '/r' })
    if (!r.ok) throw new Error('x')
    exits.get(r.sessionId)!({ id: r.sessionId, exitCode: AGENT_SESSION_LOST_EXIT })
    const tab = m.useAgentStore.getState().tabs.find((t) => t.sessionId === r.sessionId)!
    expect(tab).toMatchObject({ exited: true, lost: true })
    m.useAgentStore.getState().closeTab(r.sessionId)
  })

  it('M11 재시작 칩: 끝난 탭 자리에 같은 에이전트·같은 폴더로 새 탭(옛 탭은 닫힘, 지난 세션 제목 이어 감), 첫 지시 제목은 생성', async () => {
    const { useAiwsStore } = await import('../src/renderer/features/aiws/store')
    useAiwsStore.setState({ worktreesByRepo: { r: [{ id: 'wr', repoId: 'r', path: '/repo-r', displayName: 'r' } as never] } })
    const st = m.useAgentStore.getState()
    const a = await st.launchAgent({ agent: 'codex', worktreeId: 'wr', cwd: '/repo-r', prompt: 'Can you please fix the login bug?', vaultTitle: '지난 제목' })
    const b = await st.launchAgent({ agent: 'gemini', worktreeId: 'wr', cwd: '/repo-r' })
    if (!a.ok || !b.ok) throw new Error('x')
    expect(m.useAgentStore.getState().tabs[0]).toMatchObject({ genTitle: 'Fix the login bug', vaultTitle: '지난 제목' })
    expect(await st.restartTab(a.sessionId)).toBeNull() // 살아 있는 탭은 아무 일도 안 한다
    exits.get(a.sessionId)!()
    expect(await m.useAgentStore.getState().restartTab(a.sessionId)).toBeNull()
    const s = m.useAgentStore.getState()
    expect(ev.agents.launch).toHaveBeenLastCalledWith('codex', '/repo-r', undefined, undefined, undefined, undefined)
    expect(s.tabs.map((x) => x.agent)).toEqual(['codex', 'gemini']) // 같은 자리
    expect(s.tabs[0].sessionId).not.toBe(a.sessionId)
    expect(s.tabs[0]).toMatchObject({ exited: false, vaultTitle: '지난 제목' })
    expect(s.activeTabByWorktree.wr).toBe(s.tabs[0].sessionId)
    useAiwsStore.setState({ worktreesByRepo: {} })
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

  // R1 결정 4 ⓑ: 끊긴 원격 탭 닫기 = 이 PC 에서만(저장 목록에서만 뺀다 — 서버 세션은 산다). M8 R4 의 "닫기 = 서버에서 끝내기"를 바꿨다.
  it('R1: 끊긴 원격 탭을 닫으면 이 PC 에서만 닫고(서버 세션은 그대로), [다시 연결] 때 서버에 없던 끊긴 탭은 종료로', async () => {
    const tab = (sessionId: string, host?: string) => ({ sessionId, agent: 'codex' as const, worktreeId: 'w', title: 't', line: 'l', exited: true, lost: true, ...(host ? { host } : {}) })
    m.useAgentStore.setState({ tabs: [tab('r1', 'u@h:22'), tab('r2', 'u@h:22'), tab('l1')] })
    m.useAgentStore.getState().closeTab('r1')
    m.useAgentStore.getState().closeTab('l1')
    expect(ev.agents.killRemote).not.toHaveBeenCalled()
    expect(ev.agents.forgetRemote).toHaveBeenCalledTimes(1)
    expect(ev.agents.forgetRemote).toHaveBeenCalledWith('r1')
    expect(ev.session.destroy).not.toHaveBeenCalledWith('r1')
    expect(await m.useAgentStore.getState().reconnectHost('u@h:22')).toBeNull()
    expect(m.useAgentStore.getState().tabs).toMatchObject([{ sessionId: 'r2', exited: true, lost: false }])
  })
  it('R1: 탭 메뉴 "서버에서도 끝내기" = 서버의 세션을 끝내고 탭을 닫는다(붙은 탭은 destroy 로 놓기만)', async () => {
    m.useAgentStore.setState({ tabs: [{ sessionId: 'r3', agent: 'codex', worktreeId: 'w', title: 't', line: 'l', exited: false, host: 'u@h:22' }] })
    await m.useAgentStore.getState().endRemote('r3')
    expect(ev.agents.killRemote).toHaveBeenCalledWith('u@h:22', 'r3')
    expect(ev.session.destroy).toHaveBeenCalledWith('r3')
    expect(m.useAgentStore.getState().tabs).toEqual([])
  })
})

describe('에이전트 상태(R2) — 봄/안 봄', () => {
  const v = (sessionId: string, state: AgentStatusView['state'], extra: Partial<AgentStatusView> = {}): AgentStatusView => ({ sessionId, state, estimated: false, children: [], source: 'hook:x', ...extra })
  it('처음 열 때 상태를 구독하고, 안 보는 탭이 일하다 쉬면 끝남(안 봄), 그 탭을 열면 본 것', async () => {
    await m.useAgentStore.getState().loadAgents()
    expect(pushStatus).not.toBeNull()
    pushStatus!(v('s9', 'working'))
    pushStatus!(v('s9', 'idle'))
    expect(m.useAgentStore.getState().seenById['s9']).toBe(false)
    m.useAgentStore.getState().setViewing('s9')
    expect(m.useAgentStore.getState().seenById['s9']).toBe(true)
    // 다시 일하면 본 것(다음 끝을 새로 알릴 수 있게).
    pushStatus!(v('s9', 'working'))
    expect(m.useAgentStore.getState().seenById['s9']).toBe(true)
  })
  it('탭을 닫으면 상태도 지운다', async () => {
    await m.useAgentStore.getState().launchAgent({ agent: 'codex', worktreeId: 'w1', cwd: '/ok' })
    const id = m.useAgentStore.getState().tabs[0].sessionId
    pushStatus!(v(id, 'blocked', { kind: 'question' }))
    expect(m.useAgentStore.getState().statusById[id]?.kind).toBe('question')
    m.useAgentStore.getState().closeTab(id)
    expect(m.useAgentStore.getState().statusById[id]).toBeUndefined()
  })
})
