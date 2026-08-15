import { describe, it, expect } from 'vitest'
import { rowKeyAction, type RowContext } from '../src/renderer/store/rowKeys'

// #82(2026-08-15) — 행 목록 키보드 조작의 **판단 규칙**.
//
// 왜 이 훅이 필요했나: 클릭되는 행이 앱 전체에 70곳 넘게 흩어져 있었고 전부 마우스 전용이었다.
// #71 에서 **진짜 버튼**(런치패드 타일·창 버튼)만 `<button>` 으로 바꿨고, 행은 성격이 달라
// (트리 행=treeitem · 표 행=row · 목록 행=option) 여기서 따로 다룬다.
//
// DOM 조작(포커스 이동·클릭)은 훅이 하고 여기서는 **무엇을 할지 정하는 부분만** 본다 —
// 판단을 DOM 과 섞으면 jsdom 을 새로 깔아야 검사할 수 있다(사내 환경에서 의존성을 늘리지 않는다).
// 실제 배선은 e2e(TREE-1★)가 진짜 트리를 키보드로 몰아 확인한다.

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  cur: 1,
  count: 5,
  expanded: null,
  tree: false,
  inInput: false,
  ...over
})

describe('rowKeyAction — 위아래로 훑기', () => {
  it('↓·↑ 는 이웃 행으로', () => {
    expect(rowKeyAction('ArrowDown', ctx())).toEqual({ kind: 'focus', index: 2 })
    expect(rowKeyAction('ArrowUp', ctx())).toEqual({ kind: 'focus', index: 0 })
  })

  it('Home·End 는 양 끝으로', () => {
    expect(rowKeyAction('Home', ctx())).toEqual({ kind: 'focus', index: 0 })
    expect(rowKeyAction('End', ctx())).toEqual({ kind: 'focus', index: 4 })
  })

  it('범위 밖 인덱스를 그대로 돌려준다 — 양끝 붙이기는 훅이 한다', () => {
    expect(rowKeyAction('ArrowUp', ctx({ cur: 0 }))).toEqual({ kind: 'focus', index: -1 })
    expect(rowKeyAction('ArrowDown', ctx({ cur: 4 }))).toEqual({ kind: 'focus', index: 5 })
  })

  it('Enter 와 Space 는 그 행을 누른다', () => {
    expect(rowKeyAction('Enter', ctx())).toEqual({ kind: 'click' })
    expect(rowKeyAction(' ', ctx())).toEqual({ kind: 'click' })
  })

  it('모르는 키는 아무 것도 안 한다 — 나머지는 전역 단축키로 흘러가야 한다', () => {
    for (const k of ['a', 'Tab', 'Escape', 'PageDown', 'F1']) {
      expect(rowKeyAction(k, ctx()), k).toEqual({ kind: 'none' })
    }
  })

  it('★ 입력칸 안에서는 손대지 않는다 — 거기서 화살표는 커서 이동이다', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
      expect(rowKeyAction(k, ctx({ inInput: true })), k).toEqual({ kind: 'none' })
    }
  })

  it('행이 없으면 아무 것도 안 한다', () => {
    expect(rowKeyAction('ArrowDown', ctx({ count: 0 }))).toEqual({ kind: 'none' })
  })
})

describe('rowKeyAction — 트리의 펼치기·접기', () => {
  const tree = (over: Partial<RowContext> = {}) => ctx({ tree: true, ...over })

  it('접힌 행에서 → 는 트위스티를 누른다(상태 주인은 컴포넌트다)', () => {
    expect(rowKeyAction('ArrowRight', tree({ expanded: false }))).toEqual({ kind: 'twisty' })
  })

  it('펼쳐진 행에서 ← 는 접는다', () => {
    expect(rowKeyAction('ArrowLeft', tree({ expanded: true }))).toEqual({ kind: 'twisty' })
  })

  it('★ 이미 펼쳐진 행에서 → 는 자식으로 내려간다 — 다시 토글하면 열자마자 닫힌다', () => {
    expect(rowKeyAction('ArrowRight', tree({ expanded: true, cur: 2 }))).toEqual({ kind: 'focus', index: 3 })
  })

  it('★ 이미 접힌 행에서 ← 는 아무 일도 안 한다 — 다시 토글하면 도로 열린다', () => {
    expect(rowKeyAction('ArrowLeft', tree({ expanded: false }))).toEqual({ kind: 'none' })
  })

  it('펼칠 것이 없는 행(aria-expanded 없음)은 →← 를 무시한다', () => {
    expect(rowKeyAction('ArrowRight', tree({ expanded: null }))).toEqual({ kind: 'none' })
    expect(rowKeyAction('ArrowLeft', tree({ expanded: null }))).toEqual({ kind: 'none' })
  })

  it('★ 표·목록(tree=false)에서는 →← 가 아무 일도 안 한다 — 거기엔 펼침이 없다', () => {
    expect(rowKeyAction('ArrowRight', ctx({ expanded: false }))).toEqual({ kind: 'none' })
    expect(rowKeyAction('ArrowLeft', ctx({ expanded: true }))).toEqual({ kind: 'none' })
  })
})
