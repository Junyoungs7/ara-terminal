import { describe, it, expect } from 'vitest'
import { buildTmuxInput, isValidTmuxName, quoteShellArg } from '../src/shared/tmux'
import { CLEAR_LINE } from '../src/shared/shellInput'

describe('quoteShellArg — POSIX 셸 단일 인용', () => {
  it('평범한 이름은 그대로 감싼다', () => {
    expect(quoteShellArg('work')).toBe("'work'")
  })

  it('내부 작은따옴표를 안전하게 이어붙인다', () => {
    expect(quoteShellArg("a'b")).toBe("'a'\\''b'")
  })

  it('공백·세미콜론·백틱 등 셸 특수문자를 모두 감싼다(명령 주입 방지)', () => {
    const dangerous = 'x; rm -rf / #`id`'
    const quoted = quoteShellArg(dangerous)
    expect(quoted).toBe(`'${dangerous}'`)
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
  })
})

describe('isValidTmuxName', () => {
  it('빈 문자열·공백만은 무효다', () => {
    expect(isValidTmuxName('')).toBe(false)
    expect(isValidTmuxName('   ')).toBe(false)
  })

  it('줄바꿈이 섞이면 무효다', () => {
    expect(isValidTmuxName('work\ntmux kill-server')).toBe(false)
    expect(isValidTmuxName('work\r\nrm -rf /')).toBe(false)
  })

  it('평범한 이름은 유효하다', () => {
    expect(isValidTmuxName('work')).toBe(true)
    expect(isValidTmuxName('  work  ')).toBe(true)
  })
})

describe('buildTmuxInput — 명령 조립', () => {
  // 2026-08-23 준영님 제보 7번 — 치다 만 줄에 그대로 이어붙었다(`nvcc --versiontmux new -s 'test'`).
  it('★ 명령은 줄을 비우고 나간다 — 키 조합은 그대로다', () => {
    expect(buildTmuxInput({ kind: 'new', name: 'x' })!.startsWith(CLEAR_LINE)).toBe(true)
    expect(buildTmuxInput({ kind: 'list' })!.startsWith(CLEAR_LINE)).toBe(true)
    expect(buildTmuxInput({ kind: 'attach', name: 'x' })!.startsWith(CLEAR_LINE)).toBe(true)
    // 분리·창 이동은 tmux prefix 키다 — 줄과 무관하고, 지우면 쓰던 입력만 잃는다.
    for (const kind of ['detach', 'nextWindow', 'prevWindow'] as const) {
      expect(buildTmuxInput({ kind })!.startsWith(CLEAR_LINE)).toBe(false)
    }
  })

  it('new: 이름을 인용해 즉시 실행(\\r)한다', () => {
    expect(buildTmuxInput({ kind: 'new', name: 'work' })).toBe(CLEAR_LINE + "tmux new -s 'work'\r")
  })

  it('new: 셸 특수문자가 든 이름도 안전하게 인용된다', () => {
    const input = buildTmuxInput({ kind: 'new', name: 'a; rm -rf /' })
    expect(input).toBe(CLEAR_LINE + "tmux new -s 'a; rm -rf /'\r")
  })

  it('new/attach: 무효한 이름은 null(취소)이다', () => {
    expect(buildTmuxInput({ kind: 'new', name: '' })).toBeNull()
    expect(buildTmuxInput({ kind: 'attach', name: '   ' })).toBeNull()
  })

  it('list: 이름 없이 즉시 실행된다', () => {
    expect(buildTmuxInput({ kind: 'list' })).toBe(CLEAR_LINE + 'tmux ls\r')
  })

  it('attach: 이름을 인용해 즉시 실행한다', () => {
    expect(buildTmuxInput({ kind: 'attach', name: 'deploy' })).toBe(CLEAR_LINE + "tmux a -t 'deploy'\r")
  })

  it('detach/창 전환: prefix(Ctrl+b) + 키 하나, 개행이 없다(명령이 아니라 키 조합)', () => {
    expect(buildTmuxInput({ kind: 'detach' })).toBe('\x02d')
    expect(buildTmuxInput({ kind: 'nextWindow' })).toBe('\x02n')
    expect(buildTmuxInput({ kind: 'prevWindow' })).toBe('\x02p')
    for (const kind of ['detach', 'nextWindow', 'prevWindow'] as const) {
      expect(buildTmuxInput({ kind })?.endsWith('\r')).toBe(false)
    }
  })
})
