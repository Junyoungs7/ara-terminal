import { describe, it, expect } from 'vitest'
import {
  COMMAND_BOOK,
  CATEGORY_LABEL,
  DISTRO_LABEL,
  searchCommandBook,
  type CommandCategory
} from '../src/renderer/data/commandBook'

describe('COMMAND_BOOK — 데이터 무결성', () => {
  // FB-monitor(FB-0004): tmux 카테고리(11건)로 상한 90. 2026-08-14 rpm 계열 대응 2건으로 95.
  it('50~95개 규모다', () => {
    expect(COMMAND_BOOK.length).toBeGreaterThanOrEqual(50)
    expect(COMMAND_BOOK.length).toBeLessThanOrEqual(95)
  })

  it('id가 중복되지 않는다', () => {
    const ids = COMMAND_BOOK.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('cmd(명령)가 중복되지 않는다', () => {
    const cmds = COMMAND_BOOK.map((e) => e.cmd)
    expect(new Set(cmds).size).toBe(cmds.length)
  })

  it('모든 항목이 필수 필드(카테고리·명령·설명·예시 1개 이상)를 채운다', () => {
    for (const e of COMMAND_BOOK) {
      expect(e.category in CATEGORY_LABEL).toBe(true)
      expect(e.cmd.trim()).not.toBe('')
      expect(e.desc.trim()).not.toBe('')
      expect(e.examples.length).toBeGreaterThanOrEqual(1)
      for (const ex of e.examples) expect(ex.cmd.trim()).not.toBe('')
    }
  })

  // FB-monitor(FB-0004): tmux 카테고리 추가로 10 → 11.
  it('11개 카테고리가 모두 최소 한 항목씩 존재한다', () => {
    const cats = Object.keys(CATEGORY_LABEL) as CommandCategory[]
    expect(cats.length).toBe(11)
    for (const c of cats) expect(COMMAND_BOOK.some((e) => e.category === c)).toBe(true)
  })

  it('설명은 한국어다(빈 문자열이거나 알파벳만인 설명은 없다)', () => {
    for (const e of COMMAND_BOOK) expect(/[가-힣]/.test(e.desc)).toBe(true)
  })
})

describe('searchCommandBook — 검색 매칭', () => {
  it('빈 질의는 전체를 반환한다', () => {
    expect(searchCommandBook(COMMAND_BOOK, '')).toHaveLength(COMMAND_BOOK.length)
    expect(searchCommandBook(COMMAND_BOOK, '   ')).toHaveLength(COMMAND_BOOK.length)
  })

  it('명령 부분일치로 찾는다(대소문자 무시)', () => {
    const out = searchCommandBook(COMMAND_BOOK, 'JOURNALCTL')
    expect(out.some((e) => e.id === 'journalctl-u')).toBe(true)
  })

  it('설명(한국어) 부분일치로도 찾는다', () => {
    const out = searchCommandBook(COMMAND_BOOK, '압축')
    expect(out.length).toBeGreaterThan(0)
  })

  // 2026-08-14: 검색이 cmd·desc 만 보던 시절엔 RHEL 사용자가 'dnf' 로 찾으면 아무것도 안 나왔다
  // (그 낱말이 예시·힌트에만 있었다). 배포판을 가로질러 찾히는 것이 이 표의 쓸모다.
  it('★ 예시·힌트에만 있는 낱말로도 찾는다(dnf · firewall-cmd · netstat)', () => {
    for (const [q, id] of [
      ['dnf', 'dnf-upgrade'],
      ['firewall-cmd', 'iptables-list'],
      ['netstat', 'ss'],
      ['bind-utils', 'dig']
    ] as const) {
      expect(searchCommandBook(COMMAND_BOOK, q).some((e) => e.id === id)).toBe(true)
    }
  })

  it('계열 이름으로 그 계열 명령이 모인다', () => {
    const rpm = searchCommandBook(COMMAND_BOOK, 'RHEL')
    expect(rpm.some((e) => e.id === 'yum-install')).toBe(true)
    expect(rpm.some((e) => e.id === 'rpm-qa')).toBe(true)
    expect(searchCommandBook(COMMAND_BOOK, '우분투').some((e) => e.id === 'apt-install')).toBe(true)
  })
})

// 준영님 지적(2026-08-14): "리눅스도 우분투·RHEL 별로 다르잖아. 이것도 고려된거야?"
describe('배포판 계열 태그', () => {
  it('deb 전용 명령마다 rpm 쪽 짝이 있다(반대도 마찬가지)', () => {
    const deb = COMMAND_BOOK.filter((e) => e.distro === 'deb')
    const rpm = COMMAND_BOOK.filter((e) => e.distro === 'rpm')
    expect(deb.length).toBeGreaterThan(0)
    // 짝이 없으면 한쪽 계열 사용자에게는 그 기능이 표에 아예 없는 것과 같다.
    expect(rpm.length).toBe(deb.length)
  })

  it('★ 계열 태그가 붙은 항목은 반대 계열 대안을 힌트로 알려 준다', () => {
    for (const e of COMMAND_BOOK.filter((x) => x.distro)) {
      expect(e.hint, e.id).toBeTruthy()
      const other = e.distro === 'deb' ? /dnf|yum|rpm/ : /apt|dpkg/
      expect(other.test(e.hint!), e.id).toBe(true)
    }
  })

  it('계열 라벨은 한국어이고 두 계열 모두 있다', () => {
    expect(Object.keys(DISTRO_LABEL).sort()).toEqual(['deb', 'rpm'])
    for (const v of Object.values(DISTRO_LABEL)) expect(v.trim()).not.toBe('')
  })

  it('공통(POSIX) 명령에는 계열 태그를 달지 않는다', () => {
    for (const id of ['ls', 'ps', 'grep-r', 'tar-c', 'chmod']) {
      const e = COMMAND_BOOK.find((x) => x.id === id)
      expect(e, id).toBeDefined()
      expect(e!.distro, id).toBeUndefined()
    }
  })

  it('hint 는 한국어 문장이다', () => {
    for (const e of COMMAND_BOOK.filter((x) => x.hint)) {
      expect(/[가-힣]/.test(e.hint!), e.id).toBe(true)
    }
  })

  it('일치하는 것이 없으면 빈 배열이다', () => {
    expect(searchCommandBook(COMMAND_BOOK, 'zzz-no-such-command-zzz')).toEqual([])
  })

  it('원본 배열을 변경하지 않는다', () => {
    const before = COMMAND_BOOK.length
    searchCommandBook(COMMAND_BOOK, 'tar')
    expect(COMMAND_BOOK.length).toBe(before)
  })
})
