// #135 아라 문지기 — **실측이 정한 규칙**을 굳혀 둔다(2026-08-25, claude 2.1.220).
//
// 제일 중요한 것은 마지막 절이다: `Write` 를 막아도 `Bash` 가 열려 있으면 모델이 셸로 파일을
// 쓴다(직접 봤다). 그 조합을 "막았다"고 표시하면 사람이 지켜진다고 믿는다 — 뚫렸다고 말해야 한다.
import { describe, it, expect } from 'vitest'
import {
  blockedToolOf,
  classOfTool,
  disallowedTools,
  gateLeaks,
  gateOf,
  GATE_ALL_PASS,
  type AraGate
} from '../src/shared/aiGate'
import { buildClaudeArgs } from '../src/shared/aiEngine'

const g = (write: boolean, exec: boolean): AraGate => ({ write, exec })

describe('등급 → 막을 목록', () => {
  it('기본은 아무것도 막지 않는다 — 0.1.0 까지의 행동이 그대로다', () => {
    expect(disallowedTools(GATE_ALL_PASS)).toEqual([])
    expect(buildClaudeArgs({ disallowed: [] })).not.toContain('--disallowedTools')
  })

  it('끈 등급만 목록에 실린다 · 딸린 도구까지 함께 막는다', () => {
    expect(disallowedTools(g(false, true))).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
    // BashOutput·KillShell 을 남기면 이미 돌던 명령을 계속 만질 수 있다.
    expect(disallowedTools(g(true, false))).toEqual(['Bash', 'BashOutput', 'KillShell', 'KillBash'])
    expect(disallowedTools(g(false, false))).toHaveLength(8)
  })

  it('플래그로 나갈 때 이름이 그대로 붙는다', () => {
    const a = buildClaudeArgs({ disallowed: ['Write', 'Bash'] })
    const i = a.indexOf('--disallowedTools')
    expect(a.slice(i)).toEqual(['--disallowedTools', 'Write', 'Bash'])
  })

  it('저장값이 이상하면 **통과**로 내린다 — 막는 쪽이 기본이 아니다', () => {
    expect(gateOf(undefined)).toEqual(GATE_ALL_PASS)
    expect(gateOf({ write: 'no' })).toEqual(GATE_ALL_PASS)
    expect(gateOf({ write: false, exec: false })).toEqual({ write: false, exec: false })
  })
})

describe('막힌 것 알아보기', () => {
  it('★ 도구 결과에서 막힌 도구 이름을 뽑는다(실측 문구 그대로)', () => {
    const real = 'Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.'
    expect(blockedToolOf(real)).toBe('Write')
    expect(classOfTool('Write')).toBe('write')
    expect(classOfTool('Bash')).toBe('exec')
  })

  it('평범한 실패는 막힘이 아니다 — 아무 오류에나 허용 버튼을 띄우면 안 된다', () => {
    expect(blockedToolOf('exit 1')).toBeNull()
    expect(blockedToolOf('No such file or directory')).toBeNull()
    expect(classOfTool('Read')).toBeNull()
  })
})

describe('★ 뚫린 조합', () => {
  it('셸이 열려 있으면 파일 차단은 차단이 아니다(실측: printf > file 로 그냥 썼다)', () => {
    expect(gateLeaks(g(false, true))).toBe(true)
  })

  it('둘 다 막거나, 파일을 통과시킨 판은 거짓말을 하지 않는다', () => {
    expect(gateLeaks(g(false, false))).toBe(false)
    expect(gateLeaks(g(true, true))).toBe(false)
    expect(gateLeaks(g(true, false))).toBe(false)
  })
})
