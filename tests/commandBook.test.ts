import { describe, it, expect } from 'vitest'
import { COMMAND_BOOK, CATEGORY_LABEL, searchCommandBook, type CommandCategory } from '../src/renderer/data/commandBook'

describe('COMMAND_BOOK — 데이터 무결성', () => {
  // FB-monitor(FB-0004): tmux 카테고리(11건) 추가로 상한을 90으로 올린다 — "실사용 최소 세트" 범위 안.
  it('50~90개 규모다', () => {
    expect(COMMAND_BOOK.length).toBeGreaterThanOrEqual(50)
    expect(COMMAND_BOOK.length).toBeLessThanOrEqual(90)
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
    expect(out.every((e) => e.cmd.toLowerCase().includes('압축') || e.desc.includes('압축'))).toBe(true)
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
