import { describe, it, expect } from 'vitest'
import { applyHook, CLAUDE_HOOK_EVENTS, HOOK_STATE_OF, isHookCli, notifyTag, type AgentStatus } from '../src/shared/agentStatus'

// F1a 상태 매핑 — **추론을 그만둔 자리의 단위 검사.**
// 여기서 틀리면 화면이 조용히 거짓말을 한다(안 기다리는 걸 기다린다 하거나, 기다리는 걸 놓치거나).

const T0 = 1_700_000_000_000
const claude = (event: string) => ({ cli: 'claude' as const, sessionId: 's1', event })

describe('훅 이벤트 → 상태', () => {
  it('표대로 옮긴다', () => {
    const of = HOOK_STATE_OF.claude
    expect(of('SessionStart')).toBe('working')
    expect(of('UserPromptSubmit')).toBe('working')
    expect(of('PreToolUse')).toBe('working')
    expect(of('PostToolUse')).toBe('working')
    expect(of('Notification')).toBe('waiting')
    expect(of('Stop')).toBe('done')
  })

  it('모르는 이벤트는 null — 아무 주장도 안 한다', () => {
    // 이 한 줄이 이 라운드의 전부다: CLI 가 새 이벤트를 추가해도 우리 판정이 흔들리지 않는다.
    for (const e of ['SubagentStop', 'PreCompact', 'SessionEnd', '', 'stop', 'Whatever']) {
      expect(HOOK_STATE_OF.claude(e)).toBeNull()
    }
  })

  it('설치하는 이벤트 = 표의 키(모르는 이벤트를 심지 않는다)', () => {
    expect([...CLAUDE_HOOK_EVENTS].sort()).toEqual(
      ['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
    )
    for (const e of CLAUDE_HOOK_EVENTS) expect(HOOK_STATE_OF.claude(e)).not.toBeNull()
  })

  it('경로의 cli 는 표에 있는 것만 — 프로토타입은 표가 아니다', () => {
    expect(isHookCli('claude')).toBe(true)
    expect(isHookCli('codex')).toBe(false)
    // `in` 으로 짰으면 아래 둘이 통과하고, 그 반환값(함수·객체)이 상태로 취급된다.
    expect(isHookCli('constructor')).toBe(false)
    expect(isHookCli('__proto__')).toBe(false)
  })
})

describe('타임스탬프 둘 — 무엇이 언제 움직이나', () => {
  it('첫 훅이 상태를 만든다', () => {
    const s = applyHook(null, claude('SessionStart'), T0)
    expect(s).toEqual({ sessionId: 's1', cli: 'claude', state: 'working', updatedAt: T0, stateStartedAt: T0 })
  })

  it('없던 세션에 모르는 이벤트가 오면 아무것도 안 만든다', () => {
    expect(applyHook(null, claude('SubagentStop'), T0)).toBeNull()
  })

  it('같은 상태의 반복 이벤트: updatedAt 만 움직이고 stateStartedAt 은 그대로', () => {
    const a = applyHook(null, claude('PreToolUse'), T0)!
    const b = applyHook(a, claude('PostToolUse'), T0 + 5_000)!
    expect(b.state).toBe('working')
    expect(b.updatedAt).toBe(T0 + 5_000)
    expect(b.stateStartedAt).toBe(T0) // 3분짜리 빌드가 계속 working 인 이유
  })

  it('상태가 바뀌면 stateStartedAt 도 움직인다', () => {
    const a = applyHook(null, claude('PreToolUse'), T0)!
    const b = applyHook(a, claude('Notification'), T0 + 90_000)!
    expect(b).toMatchObject({ state: 'waiting', updatedAt: T0 + 90_000, stateStartedAt: T0 + 90_000 })
  })

  it('모르는 이벤트는 상태를 안 건드린다 — 다만 들었다는 사실은 남는다', () => {
    const a = applyHook(null, claude('Notification'), T0)!
    const b = applyHook(a, claude('SubagentStop'), T0 + 1_000)!
    expect(b.state).toBe('waiting')
    expect(b.stateStartedAt).toBe(T0)
    expect(b.updatedAt).toBe(T0 + 1_000)
  })

  it('알림 id 는 상태가 시작된 시각으로 만든다 — 같은 대기는 알림 하나', () => {
    const a = applyHook(null, claude('Notification'), T0)!
    const b = applyHook(a, claude('Notification'), T0 + 3_000)!
    expect(notifyTag(a)).toBe(notifyTag(b))
    const c = applyHook(b, claude('Stop'), T0 + 4_000)!
    expect(notifyTag(c)).not.toBe(notifyTag(b))
    expect(notifyTag(c)).toBe(`agent:s1:${T0 + 4_000}`)
  })
})

describe('restoredUnconfirmed — 나이와 무관하게 신선하지 않다', () => {
  const restored: AgentStatus = {
    sessionId: 's1',
    cli: 'claude',
    state: 'working',
    updatedAt: T0,
    stateStartedAt: T0,
    restoredUnconfirmed: true
  }

  it('첫 실제 훅이 표시를 지운다', () => {
    const s = applyHook(restored, claude('PreToolUse'), T0 + 1_000)!
    expect(s.restoredUnconfirmed).toBeUndefined()
  })

  it('값이 같아도 상태가 새로 시작된 것으로 친다 — 이전 값은 CLI 의 말이 아니었다', () => {
    const s = applyHook(restored, claude('PreToolUse'), T0 + 1_000)!
    expect(s.state).toBe('working')
    expect(s.stateStartedAt).toBe(T0 + 1_000)
  })

  it('모르는 이벤트도 표시를 지운다 — 그 세션이 살아서 말하고 있다는 것은 확인됐다', () => {
    const s = applyHook(restored, claude('SubagentStop'), T0 + 1_000)!
    expect(s.restoredUnconfirmed).toBeUndefined()
    expect(s.state).toBe('working')
  })
})
