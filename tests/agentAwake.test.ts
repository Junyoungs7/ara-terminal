// M11 깨어있기(main/agents/awake.ts) — Orca agent-awake-service.test.ts(fdfcfb3551)의 핵심 경우를 가짜 blocker 로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_AWAKE_STATUS_STALE_AFTER_MS, createAgentAwake } from '../src/main/agents/awake'

vi.mock('electron', () => ({}))

function fakeBlocker(): { blocker: { start: (t: string) => number; stop: (id: number) => void; isStarted: (id: number) => boolean }; started: Set<number>; types: string[] } {
  const started = new Set<number>()
  const types: string[] = []
  let seq = 0
  return {
    started,
    types,
    blocker: {
      start: (t) => {
        types.push(t)
        started.add(++seq)
        return seq
      },
      stop: (id) => void started.delete(id),
      isStarted: (id) => started.has(id)
    }
  }
}

describe('createAgentAwake', () => {
  let now = 1_000
  beforeEach(() => {
    vi.useFakeTimers()
    now = 1_000
  })
  afterEach(() => vi.useRealTimers())

  it('off 는 일하는 에이전트가 있어도 안 막고, on 은 늘 막는다(prevent-display-sleep)', () => {
    const f = fakeBlocker()
    const a = createAgentAwake({ blocker: f.blocker, now: () => now })
    a.observe('s1', true)
    expect(f.started.size).toBe(0)
    a.setMode('on')
    expect(f.started.size).toBe(1)
    expect(f.types).toEqual(['prevent-display-sleep'])
    a.observe('s1', false)
    expect(f.started.size).toBe(1)
    a.setMode('off')
    expect(f.started.size).toBe(0)
  })

  it('auto 는 일하는 탭이 있을 때만 — 쉬거나 탭이 끝나면 푼다, 한 blocker 만 쓴다', () => {
    const f = fakeBlocker()
    const a = createAgentAwake({ blocker: f.blocker, now: () => now })
    a.setMode('auto')
    expect(a.active).toBe(false)
    a.observe('s1', true)
    a.observe('s2', true)
    expect(f.started.size).toBe(1)
    a.observe('s1', false)
    expect(a.active).toBe(true)
    a.forget('s2')
    expect(a.active).toBe(false)
    expect(f.types).toHaveLength(1)
  })

  it('2시간 넘게 소식 없는 "일하는 중"은 세지 않는다(타이머가 풀어 준다)', () => {
    const f = fakeBlocker()
    const a = createAgentAwake({ blocker: f.blocker, now: () => now })
    a.setMode('auto')
    a.observe('s1', true)
    expect(a.active).toBe(true)
    now += AGENT_AWAKE_STATUS_STALE_AFTER_MS + 10
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS + 10)
    expect(a.active).toBe(false)
  })

  it('밖에서 풀린 blocker 는 다음 판단에서 다시 건다 · 깨어나면(resume) 다시 맞춘다 · dispose 는 푼다', () => {
    const f = fakeBlocker()
    let onResume: (() => void) | null = null
    const a = createAgentAwake({ blocker: f.blocker, now: () => now, powerMonitor: { on: (_e, l) => (onResume = l), off: () => (onResume = null) } })
    a.setMode('on')
    f.started.clear() // OS·다른 코드가 풀었다
    onResume!()
    expect(f.started.size).toBe(1)
    a.dispose()
    expect(f.started.size).toBe(0)
    expect(onResume).toBeNull()
  })
})
