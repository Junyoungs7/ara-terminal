// M3 R2 AI-11 — 상태 → 글리프(봄/안 봄 herdr 규칙, 여러 탭 묶기).
import { describe, expect, it } from 'vitest'
import { aggregate, displayOf, nextSeen } from '../src/renderer/features/aiws/agentStatusView'
import type { AgentStatusView } from '../src/shared/agentHooks'

const v = (state: AgentStatusView['state'], extra: Partial<AgentStatusView> = {}): AgentStatusView => ({ sessionId: 's', state, estimated: false, children: [], source: 'x', ...extra })

describe('봄/안 봄(herdr seen)', () => {
  it('일하다 쉬게 된 순간: 보고 있으면 본 것(idle), 아니면 안 본 것(done)', () => {
    expect(nextSeen(v('working'), v('idle'), true, false)).toBe(false)
    expect(nextSeen(v('working'), v('idle'), true, true)).toBe(true)
    expect(nextSeen(v('blocked'), v('idle'), true, false)).toBe(false)
  })
  it('일하거나 막히면 늘 본 것, 쉼이 이어지면 앞 값', () => {
    expect(nextSeen(v('idle'), v('working'), false, false)).toBe(true)
    expect(nextSeen(v('idle'), v('idle'), false, true)).toBe(false)
    expect(nextSeen(undefined, v('idle'), true, false)).toBe(true)
  })
})

describe('글리프', () => {
  it('상태 → 표시', () => {
    expect(displayOf(undefined, true)).toBe('unknown')
    expect(displayOf(v(null), true)).toBe('unknown')
    expect(displayOf(v('working'), true)).toBe('working')
    expect(displayOf(v('blocked'), true)).toBe('blocked')
    expect(displayOf(v('blocked', { kind: 'question' }), true)).toBe('question')
    expect(displayOf(v('idle'), false)).toBe('done')
    expect(displayOf(v('idle'), true)).toBe('idle')
  })
  it('워크트리 줄은 손댈 일이 큰 것(막힘 > 안 본 끝 > 일함 > 쉼 > 모름), 같으면 확실한(추정 아닌) 쪽', () => {
    expect(aggregate([])).toBeNull()
    expect(aggregate([{ display: 'working', estimated: false }, { display: 'done', estimated: false }])?.display).toBe('done')
    expect(aggregate([{ display: 'done', estimated: false }, { display: 'question', estimated: true }])).toEqual({ display: 'question', estimated: true })
    expect(aggregate([{ display: 'working', estimated: true }, { display: 'working', estimated: false }])).toEqual({ display: 'working', estimated: false })
  })
})
