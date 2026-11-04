// M11 R2 — 앱 재시작 뒤 에이전트 탭 되살리기(렌더러, features/aiws/agentStore.ts restoreTabs + tabLayout.ts).
// 데몬에 살아 있던 탭은 그대로 올리고, 데몬째 죽은 탭(cold)은 같은 에이전트·같은 폴더로 resume 실행 → 지난 레이아웃(탭 순서·고른 탭·고른 작업 단위)으로.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultAgentSettings } from '@shared/agents'
import type { AgentTabInfo } from '@shared/ipc'
import { TAB_LAYOUT_KEY, layoutOf, orderTabs, restoreActive } from '../src/renderer/features/aiws/tabLayout'

const store = new Map<string, string>()
const launch = vi.fn(async (agent: string, _cwd: string, _p?: string, resume?: string) => ({ ok: true as const, sessionId: `new-${agent}-${resume ?? 'fresh'}`, title: agent, line: agent }))
const tabs: AgentTabInfo[] = [
  { sessionId: 'live-1', agent: 'claude', cwd: 'C:\\repo\\wt', title: 'Claude · wt', line: 'claude' },
  { sessionId: 'old-2', agent: 'codex', cwd: 'C:\\repo\\wt', title: 'Codex · wt', line: 'codex', cold: true, resume: 'r-123', name: '로그인 고치기' },
  { sessionId: 'old-3', agent: 'gemini', cwd: 'C:\\repo\\wt', title: 'Gemini · wt', line: 'gemini', cold: true }
]
const ev = {
  agents: {
    detect: vi.fn(async () => []),
    getSettings: vi.fn(async () => defaultAgentSettings()),
    launch,
    statuses: vi.fn(async () => []),
    tabs: vi.fn(async () => tabs),
    onStatus: vi.fn(() => () => {}),
    onName: vi.fn(() => () => {}),
    onTitle: vi.fn(() => () => {}),
    onViewers: vi.fn(() => () => {}),
    onTyping: vi.fn(() => () => {}),
    onRemoteLimit: vi.fn(() => () => {})
  },
  session: { onExit: vi.fn(() => () => {}), destroy: vi.fn(async () => ({ ok: true })) }
}

let m: typeof import('../src/renderer/features/aiws/agentStore')
let aiws: typeof import('../src/renderer/features/aiws/store')
beforeAll(async () => {
  const g = globalThis as unknown as { window: unknown; localStorage: unknown }
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  g.window = { ev, addEventListener: () => {} }
  // 지난 레이아웃: cold 탭이 맨 앞, 고른 탭도 그것, 고른 작업 단위 w.
  store.set(TAB_LAYOUT_KEY, JSON.stringify({ order: ['old-3', 'live-1', 'old-2'], active: { 'r::C:\\repo\\wt': 'old-2' }, worktree: 'r::C:\\repo\\wt' }))
  m = await import('../src/renderer/features/aiws/agentStore')
  aiws = await import('../src/renderer/features/aiws/store')
})
afterAll(() => {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown }
  delete g.window
  delete g.localStorage
})

const until = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(pred()).toBe(true)
}

describe('앱 재시작 뒤 에이전트 탭', () => {
  it('살아 있던 탭은 그대로, 데몬째 죽은 탭은 resume 으로 다시 띄우고, 지난 순서·고른 탭·고른 작업 단위로', async () => {
    await m.useAgentStore.getState().loadAgents()
    // 워크트리 목록이 늦게 올라온다 — 올라오면 자리를 찾는다.
    expect(m.useAgentStore.getState().tabs).toEqual([])
    aiws.useAiwsStore.setState({ worktreesByRepo: { r: [{ id: 'r::C:\\repo\\wt', path: 'C:\\repo\\wt', displayName: 'wt' } as never] } })
    await until(() => m.useAgentStore.getState().tabs.length === 3)
    expect(launch).toHaveBeenCalledWith('codex', 'C:\\repo\\wt', undefined, 'r-123', undefined, undefined)
    expect(launch).toHaveBeenCalledWith('gemini', 'C:\\repo\\wt', undefined, undefined, undefined, undefined) // 세션 id 를 모르면 새로
    expect(launch).toHaveBeenCalledTimes(2) // 목록이 여러 번 바뀌어도 두 번 띄우지 않는다
    await until(() => m.useAgentStore.getState().tabs[0]?.sessionId === 'new-gemini-fresh')
    const s = m.useAgentStore.getState()
    expect(s.tabs.map((t) => t.sessionId)).toEqual(['new-gemini-fresh', 'live-1', 'new-codex-r-123'])
    expect(s.tabs[2].name).toBe('로그인 고치기')
    expect(s.activeTabByWorktree['r::C:\\repo\\wt']).toBe('new-codex-r-123')
    expect(aiws.useAiwsStore.getState().activeWorktreeId).toBe('r::C:\\repo\\wt')
    // 그 뒤로는 새 id 로 남는다.
    await until(() => JSON.parse(store.get(TAB_LAYOUT_KEY)!).order[0] === 'new-gemini-fresh')
  })
})

describe('tabLayout(순수)', () => {
  const L = { order: ['a', 'b', 'c'], active: { w: 'c' }, worktree: 'w' }
  it('저장 순서로 세우고, 저장에 없던 탭은 뒤에 그대로', () => {
    expect(orderTabs([{ sessionId: 'x' }, { sessionId: 'c2' }, { sessionId: 'a' }], L, new Map([['c', 'c2']])).map((t) => t.sessionId)).toEqual(['a', 'c2', 'x'])
  })
  it('고른 탭은 그 작업 단위에 있을 때만', () => {
    expect(restoreActive([{ sessionId: 'c2', worktreeId: 'w' }], L, new Map([['c', 'c2']]), { v: 'z' })).toEqual({ v: 'z', w: 'c2' })
    expect(restoreActive([{ sessionId: 'c2', worktreeId: 'other' }], L, new Map([['c', 'c2']]), {})).toEqual({})
  })
  it('아직 자리를 못 찾은 탭의 순서·고른 탭·작업 단위는 덮어쓰지 않는다', () => {
    expect(layoutOf([{ sessionId: 'a' }], {}, null, L, new Set(['c']))).toEqual({ order: ['a', 'c'], active: { w: 'c' }, worktree: 'w' })
    expect(layoutOf([{ sessionId: 'a' }], {}, null, L, new Set())).toEqual({ order: ['a'], active: {}, worktree: null })
  })
})
