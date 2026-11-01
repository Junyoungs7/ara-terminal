// M3 R3 — AI-08 대시보드 칸 나누기 · AI-09 활동 피드(종류·정렬) · 완료 알림 라우팅(알림 센터 · 맥박 · 늦춤 · 끄기).
// window.ev 를 가짜로 세워 main 없이 돈다(진짜 CLI 안 띄움).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentSettings } from '@shared/agents'
import type { AgentStatusView } from '@shared/agentHooks'
import { boardOf, bucketOf, feedKindOf, feedView, noteKindOf, type FeedEvent } from '../src/renderer/features/aiws/agentBoard'
import { attention, notesNow, openNoteVia, resetNotes, setAgentNotesEnabled, setNoteOpener, setNoteSpace } from '../src/renderer/store/notify'

const v = (state: AgentStatusView['state'], extra: Partial<AgentStatusView> = {}): AgentStatusView => ({ sessionId: 's1', state, estimated: false, children: [], source: 'hook:x', ...extra })

describe('보드 칸(AI-08)', () => {
  it('작업 중 · 기다림(승인·질문) · 끝남(안 봄) · 쉼(본 쉼·모름·종료)', () => {
    expect(bucketOf('working')).toBe('working')
    expect(bucketOf('blocked')).toBe('waiting')
    expect(bucketOf('question')).toBe('waiting')
    expect(bucketOf('done')).toBe('done')
    expect(bucketOf('idle')).toBe('idle')
    expect(bucketOf('unknown')).toBe('idle')
    // 종료된 탭: 마지막이 '일함'이어도 쉼으로(영원히 작업 중에 남지 않게), 안 본 끝은 그대로 끝남.
    expect(bucketOf('working', true)).toBe('idle')
    expect(bucketOf('done', true)).toBe('done')
  })
  it('칸별로 가르고 칸 안 순서는 들어온 순서', () => {
    const b = boardOf([
      { id: 'a', display: 'working' as const },
      { id: 'b', display: 'question' as const },
      { id: 'c', display: 'working' as const },
      { id: 'd', display: 'done' as const }
    ])
    expect(b.working.map((x) => x.id)).toEqual(['a', 'c'])
    expect(b.waiting.map((x) => x.id)).toEqual(['b'])
    expect(b.done.map((x) => x.id)).toEqual(['d'])
    expect(b.idle).toEqual([])
  })
})

describe('활동 피드(AI-09)', () => {
  it('상태가 바뀔 때만 — 도구만 바뀌면 없음', () => {
    expect(feedKindOf(undefined, v('working'))).toBe('working')
    expect(feedKindOf(v('working', { tool: 'Grep' }), v('working', { tool: 'Bash' }))).toBeNull()
    expect(feedKindOf(v('working'), v('blocked', { kind: 'permission' }))).toBe('blocked')
    expect(feedKindOf(v('working'), v('blocked', { kind: 'question' }))).toBe('question')
    expect(feedKindOf(v('blocked'), v('idle', { source: 'hook:Stop' }))).toBe('done')
    expect(feedKindOf(v('working'), v('idle', { source: 'hook:StopFailure' }))).toBe('error')
    expect(feedKindOf(v('working'), v(null))).toBeNull()
  })
  it('처음 판정된 쉼(셸이 막 뜸)·쉼에서 쉼은 끝남이 아니다', () => {
    expect(feedKindOf(undefined, v('idle'))).toBeNull()
    expect(feedKindOf(v(null), v('idle'))).toBeNull()
    expect(feedKindOf(v('idle'), v('idle', { source: 'hook:StopFailure' }))).toBeNull()
  })
  it('정렬 — 최신이 위, 같은 시각이면 나중에 들어온 것이 위', () => {
    const e = (id: number, at: number): FeedEvent => ({ id, at, sessionId: 's' + id, kind: 'working', estimated: false })
    expect(feedView([e(1, 100), e(2, 300), e(3, 200), e(4, 300)]).map((x) => x.id)).toEqual([4, 2, 3, 1])
  })
  it('일 시작은 지금 일하는 중일 때만(Orca activity-pane-events) — 지난 working 은 안 남는다', () => {
    const e = (id: number, kind: FeedEvent['kind'], sessionId = 's'): FeedEvent => ({ id, at: id, sessionId, kind, estimated: false })
    // 한 턴: 작업 → 승인 대기 → 작업 → 끝남
    const turn = [e(1, 'working'), e(2, 'blocked'), e(3, 'working'), e(4, 'done')]
    expect(feedView(turn).map((x) => x.kind)).toEqual(['done', 'blocked'])
    // 아직 일하는 중이면 그 한 줄은 맨 위에 남는다. 다른 세션의 작업 중은 그 세션 기준.
    expect(feedView([...turn, e(5, 'working')]).map((x) => x.kind)).toEqual(['working', 'done', 'blocked'])
    expect(feedView([e(1, 'working', 'a'), e(2, 'done', 'b')]).map((x) => x.sessionId)).toEqual(['b', 'a'])
  })
})

describe('알림 라우팅(순수)', () => {
  it('끝남·오류·기다림만, 일 시작은 없음 · 보고 있으면 없음 · 끄면 없음', () => {
    expect(noteKindOf('done', false, true)).toBe('done')
    expect(noteKindOf('error', false, true)).toBe('error')
    expect(noteKindOf('blocked', false, true)).toBe('wait')
    expect(noteKindOf('question', false, true)).toBe('wait')
    expect(noteKindOf('working', false, true)).toBeNull()
    expect(noteKindOf('done', true, true)).toBeNull()
    expect(noteKindOf('blocked', false, false)).toBeNull()
  })
})

// ── 상태 구독 → 피드·알림 센터·맥박 (agentStore) ──
let pushStatus: ((s: AgentStatusView) => void) | null = null
const ev = {
  agents: {
    detect: vi.fn(async () => []),
    getSettings: vi.fn(async () => defaultAgentSettings()),
    launch: vi.fn(async (agent: string) => ({ ok: true as const, sessionId: 's1', title: agent, line: agent })),
    statuses: vi.fn(async () => []),
    tabs: vi.fn(async () => []), // M4 DM-01: 데몬에서 되살린 탭(여기선 없음)
    onStatus: vi.fn((cb: (s: AgentStatusView) => void) => {
      pushStatus = cb
      return () => {}
    }),
    onName: vi.fn(() => () => {}) // M5 AI-19
  },
  session: { onExit: vi.fn(() => () => {}), destroy: vi.fn(async () => ({ ok: true })) }
}

let m: typeof import('../src/renderer/features/aiws/agentStore')
beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { ev }
  m = await import('../src/renderer/features/aiws/agentStore')
  await m.useAgentStore.getState().loadAgents()
  await m.useAgentStore.getState().launchAgent({ agent: 'claude', worktreeId: 'r::w1', cwd: '/repo' })
})
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})
beforeEach(() => {
  vi.useFakeTimers()
  resetNotes()
  setNoteSpace('term')
  // 탭은 그대로, 상태·피드만 비운다.
  m.useAgentStore.setState({ statusById: {}, seenById: {}, viewing: null, feed: [], view: 'worktree' })
})
afterEach(() => vi.useRealTimers())

const send = (s: AgentStatusView): void => pushStatus!(s)

describe('완료 알림 · 맥박(agentStore → store/notify)', () => {
  it('터미널 공간에 있을 때 승인 대기 → 늦춘 뒤 AI 공간 wait 알림 → AI 버튼 맥박, 그 공간으로 가면 꺼짐', () => {
    send(v('working'))
    send(v('blocked', { kind: 'permission', tool: 'Bash' }))
    expect(notesNow().notes).toHaveLength(0) // 아직 늦추는 중
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    const [n] = notesNow().notes
    expect(n).toMatchObject({ kind: 'wait', space: 'ai', target: { type: 'task', id: 's1' } })
    expect(n.title).toContain('Claude Code')
    expect(attention(notesNow().notes, 'term')).toEqual({ ai: true })
    setNoteSpace('ai')
    expect(attention(notesNow().notes, 'term')).toEqual({})
    // 피드에는 즉시 두 줄(일 시작 · 승인 대기)
    expect(m.useAgentStore.getState().feed.map((e) => e.kind)).toEqual(['working', 'blocked'])
  })

  it('늦추는 사이 스스로 이어 가면(다시 일함) 알림을 거둔다 · 도구만 바뀌면 그대로', () => {
    send(v('working'))
    send(v('blocked', { kind: 'permission', tool: 'Bash' }))
    send(v('blocked', { kind: 'permission', tool: 'Edit' }))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    expect(notesNow().notes).toHaveLength(1)
    resetNotes()
    send(v('blocked', { kind: 'question' }))
    send(v('working'))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    expect(notesNow().notes).toHaveLength(0)
  })

  it('안 보는 사이 끝남 → done 알림(맥박 없음), 오류 → error 알림', () => {
    send(v('working'))
    send(v('idle', { source: 'hook:Stop' }))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    expect(notesNow().notes[0]).toMatchObject({ kind: 'done', space: 'ai' })
    expect(attention(notesNow().notes, 'term')).toEqual({})
    send(v('working'))
    send(v('idle', { source: 'hook:StopFailure' }))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    expect(notesNow().notes[0].kind).toBe('error')
  })

  it('설정 › 알림 [에이전트 알림]을 끄면 아무것도 안 보낸다(피드는 그대로)', () => {
    setAgentNotesEnabled(false)
    send(v('working'))
    send(v('blocked', { kind: 'permission' }))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    expect(notesNow().notes).toHaveLength(0)
    expect(m.useAgentStore.getState().feed).toHaveLength(2)
  })

  it('알림을 누르면(OS 알림도 같은 길) 그 워크트리·탭·탭 화면으로', () => {
    m.useAgentStore.setState({ view: 'dashboard' })
    const opened: number[] = []
    setNoteOpener((n) => {
      opened.push(n.id)
      n.go?.()
    })
    send(v('working'))
    send(v('blocked', { kind: 'question' }))
    vi.advanceTimersByTime(m.NOTE_DELAY_MS)
    openNoteVia(notesNow().notes[0])
    expect(opened).toHaveLength(1)
    expect(m.useAgentStore.getState().view).toBe('worktree')
    expect(m.useAgentStore.getState().activeTabByWorktree['r::w1']).toBe('s1')
    setNoteOpener(null)
  })
})
