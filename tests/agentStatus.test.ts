import { describe, it, expect } from 'vitest'
import {
  applyHook,
  CLAUDE_HOOK_EVENTS,
  HOOK_STATE_OF,
  isHookCli,
  isUserExit,
  notifyTag,
  type AgentStatus
} from '../src/shared/agentStatus'

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
    // #160: 나간 것은 끝낸 것이 아니다. `done` 이면 크래시가 "끝냈습니다"로 나간다.
    expect(of('SessionEnd')).toBe('unverifiable')
    expect(of('SessionEnd')).not.toBe('done')
  })

  it('모르는 이벤트는 null — 아무 주장도 안 한다', () => {
    // 이 한 줄이 이 라운드의 전부다: CLI 가 새 이벤트를 추가해도 우리 판정이 흔들리지 않는다.
    // (claude-code 2.0.76 은 훅 이벤트가 서른 개가 넘는다 — 그중 우리가 아는 것만 표에 있다.)
    for (const e of ['SubagentStop', 'PreCompact', 'PostCompact', 'TaskCreated', '', 'stop', 'Whatever']) {
      expect(HOOK_STATE_OF.claude(e)).toBeNull()
    }
  })

  it('설치하는 이벤트 = 표의 키(모르는 이벤트를 심지 않는다)', () => {
    expect([...CLAUDE_HOOK_EVENTS].sort()).toEqual(
      ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
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

// 사람이 끝낸 종료만 줄을 지운다. **`applyHook` 은 나머지를 맡는다** — 아래 #160 묶음이
// 그 나머지고, 여기가 갈림길이다.
describe('isUserExit — 어디까지를 "사용자가 직접 종료"로 보나', () => {
  it('사람이 친 것만 참이다', () => {
    expect(isUserExit('SessionEnd', 'prompt_input_exit')).toBe(true) // /exit · /quit
    expect(isUserExit('SessionEnd', 'logout')).toBe(true) // /logout
  })

  it('나머지 종료는 전부 거짓 — 모르면 `확인 불가` 로 남는다', () => {
    // `clear` 는 프로세스가 안 죽고, `bypass_permissions_disabled` 는 claude 가 스스로 나간 것이며,
    // `other` 는 크래시·SIGINT·**Ctrl+D** 가 전부 섞여 있는 기본값이다(번들에서 확인).
    for (const r of ['clear', 'other', 'bypass_permissions_disabled', '']) {
      expect(isUserExit('SessionEnd', r)).toBe(false)
    }
    expect(isUserExit('SessionEnd', null)).toBe(false) // 본문을 못 읽었다
  })

  it('모르는 `reason` 은 지우지 않는다 — 허용 목록이지 차단 목록이 아니다', () => {
    expect(isUserExit('SessionEnd', 'some_future_reason')).toBe(false)
  })

  it('다른 이벤트는 `reason` 이 뭐든 상관없다', () => {
    for (const e of ['Stop', 'SessionStart', 'Notification']) {
      expect(isUserExit(e, 'prompt_input_exit')).toBe(false)
    }
  })
})

describe('#160 CLI 가 나갔다 — 탭은 살아 있고 claude 만 죽은 경우(사람이 끝낸 것이 아닌 쪽)', () => {
  it('일하던 중에 나가면 `작업 중`이 아니라 `모른다`가 된다', () => {
    // 구멍의 모양 그대로: PreToolUse(working) 뒤에 Stop 없이 SessionEnd 만 온다(크래시·Ctrl+D).
    const working = applyHook(null, claude('PreToolUse'), T0)!
    const ended = applyHook(working, claude('SessionEnd'), T0 + 30_000)!
    expect(ended.state).toBe('unverifiable')
    expect(ended.stateStartedAt).toBe(T0 + 30_000) // 상태가 바뀌었으니 시계도 새로 선다
    expect(ended.updatedAt).toBe(T0 + 30_000)
  })

  it('사람을 기다리던 중에 나가도 마찬가지 — 알림 대상에서 빠진다', () => {
    const waiting = applyHook(null, claude('Notification'), T0)!
    const ended = applyHook(waiting, claude('SessionEnd'), T0 + 1_000)!
    // `waiting` 이 유일한 알림 상태다(aiQuietWatch). 나간 세션이 계속 사람을 부르면 안 된다.
    expect(ended.state).toBe('unverifiable')
  })

  it('한 턴을 끝내고 나가도 `끝남`에 머물지 않는다 — 그 탭엔 이제 CLI 가 없다', () => {
    const done = applyHook(null, claude('Stop'), T0)!
    expect(done.state).toBe('done')
    expect(applyHook(done, claude('SessionEnd'), T0 + 1_000)!.state).toBe('unverifiable')
  })

  it('다시 띄우면 그 줄이 되살아난다 — 종료가 세션을 지우는 것이 아니다', () => {
    const ended = applyHook(applyHook(null, claude('PreToolUse'), T0)!, claude('SessionEnd'), T0 + 1_000)!
    const again = applyHook(ended, claude('SessionStart'), T0 + 2_000)!
    expect(again.state).toBe('working')
    expect(again.stateStartedAt).toBe(T0 + 2_000)
  })

  it('없던 세션에 SessionEnd 만 오면 `모른다`를 만든다 — 그게 참이다', () => {
    // 앱을 늦게 켜서 앞의 훅을 놓쳤을 때. 상태를 안 만들어도 화면은 `unverifiable` 이라 같지만,
    // 들은 것을 원장에 남기는 쪽이 `updatedAt` 을 정직하게 만든다.
    expect(applyHook(null, claude('SessionEnd'), T0)!.state).toBe('unverifiable')
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
