import { describe, it, expect, afterEach } from 'vitest'
import { registerTerm, tailSegs, unregisterTerm } from '../src/renderer/terminal/termRegistry'

// 2026-08-22 준영님 제보 20번: 미니 프리뷰가 전부 하얀 글씨라 읽기 어렵다.
// 색을 살리되 **같은 색이 이어지는 구간으로 묶는 것**이 이 함수의 전부다 — 셀마다 span 을 만들면
// 카드 하나에 수백 개가 되고, 1.5초마다 세션 수만큼 돌아 프리뷰가 무거워진다.

/** xterm 셀 흉내. mode: 0=기본 · 1=P16 · 2=P256 · 3=RGB. */
const cell = (ch: string, mode = 0, fg = 0, bold = 0) => ({
  getChars: () => ch,
  getFgColorMode: () => mode,
  getFgColor: () => fg,
  isBold: () => bold
})

/** 셀 배열 → 줄. */
const line = (cells: ReturnType<typeof cell>[]) => ({
  length: cells.length,
  getCell: (x: number) => cells[x]
})

/** 줄 배열을 가진 가짜 터미널을 레지스트리에 꽂는다(진짜 xterm 없이 순수 로직만 본다). */
function mount(id: string, lines: ReturnType<typeof line>[]): void {
  const term = {
    rows: lines.length,
    buffer: { active: { baseY: 0, getLine: (i: number) => lines[i] } }
  }
  registerTerm(id, { term, fit: {}, search: {} } as never)
}

const plain = (s: string) => [...s].map((c) => cell(c))
const colored = (s: string, fg: number) => [...s].map((c) => cell(c, 1, fg))

describe('tailSegs — 미니 프리뷰 색 구간', () => {
  afterEach(() => {
    for (const id of ['s1', 's2']) unregisterTerm(id)
  })

  it('등록되지 않은 세션은 빈 배열', () => {
    expect(tailSegs('없음', 5)).toEqual([])
  })

  it('★ 같은 색이 이어지면 한 구간으로 묶는다 — 이게 성능의 전부다', () => {
    mount('s1', [line(plain('hello world'))])
    const rows = tailSegs('s1', 5)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(1) // 11글자 → span 1개
    expect(rows[0][0].text).toBe('hello world')
    expect(rows[0][0].fg).toBeUndefined() // 기본색은 색을 싣지 않는다
  })

  it('색이 바뀌는 자리에서만 구간을 가른다', () => {
    // `$ ` (기본) + `ok` (초록=2) + ` done` (기본)
    mount('s1', [line([...plain('$ '), ...colored('ok', 2), ...plain(' done')])])
    const [row] = tailSegs('s1', 5)
    expect(row.map((s) => s.text)).toEqual(['$ ', 'ok', ' done'])
    expect(row.map((s) => s.fg)).toEqual([undefined, 2, undefined])
  })

  it('굵기도 구간을 가른다 — 색이 같아도 굵기가 다르면 다른 span 이다', () => {
    mount('s1', [line([...[...'AB'].map((c) => cell(c, 1, 4, 1)), ...colored('cd', 4)])])
    const [row] = tailSegs('s1', 5)
    expect(row.map((s) => s.text)).toEqual(['AB', 'cd'])
    expect(row[0].bold).toBe(true)
    expect(row[1].bold).toBeUndefined()
  })

  it('24bit RGB 는 인덱스가 아니라고 표시해 둔다(화면이 기본색으로 떨군다)', () => {
    mount('s1', [line([...[...'x'].map((c) => cell(c, 3, 0xff8800))])])
    const [row] = tailSegs('s1', 5)
    expect(row[0].rgb).toBe(true)
  })

  it('꼬리의 빈 줄은 건너뛰고, 줄 끝 여백은 잘라 낸다', () => {
    mount('s1', [line(plain('첫 줄       ')), line(plain('   ')), line(plain('   '))])
    const rows = tailSegs('s1', 5)
    expect(rows).toHaveLength(1)
    expect(rows[0].map((s) => s.text).join('')).toBe('첫 줄')
  })

  it('요청한 줄 수만큼만, 오래된 것이 앞에 온다', () => {
    mount('s1', [line(plain('1')), line(plain('2')), line(plain('3'))])
    const rows = tailSegs('s1', 2)
    expect(rows.map((r) => r.map((s) => s.text).join(''))).toEqual(['2', '3'])
  })

  it('세션마다 자기 화면을 본다', () => {
    mount('s1', [line(plain('가'))])
    mount('s2', [line(plain('나'))])
    expect(tailSegs('s1', 3)[0][0].text).toBe('가')
    expect(tailSegs('s2', 3)[0][0].text).toBe('나')
  })
})
