import { describe, it, expect } from 'vitest'
import { gridUsage, cellsFor, toLayoutNode, MAX_PANES, type LayoutState, type Pane } from '../src/renderer/store/layout'
import type { LayoutNode } from '../src/shared/types'

const mkPanes = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, sessionId: `s${i + 1}` }))

const stateOf = (n: number, over: Partial<LayoutState> = {}): LayoutState => ({
  panes: mkPanes(n),
  focusedId: null,
  colRatio: 0.5,
  rowRatio: 0.5,
  maximizedId: null,
  pairAxis: 'lr',
  ...over
})

// leaf(pane) 개수 세기 — 스냅샷 트리 불변식(§B.3, 최대 4 leaf) 검증용.
function countLeaves(node: LayoutNode): number {
  return node.type === 'pane' ? 1 : node.children.reduce((a, c) => a + countLeaves(c), 0)
}

describe('layout 그리드 배치 (F4a 2x2)', () => {
  it('패널 수에 따라 사용 열/행이 결정된다', () => {
    expect(gridUsage(1)).toEqual({ cols: 1, rows: 1 })
    expect(gridUsage(2)).toEqual({ cols: 2, rows: 1 })
    expect(gridUsage(3)).toEqual({ cols: 2, rows: 2 })
    expect(gridUsage(4)).toEqual({ cols: 2, rows: 2 })
  })

  it('패널은 목업 순서(좌상→우상→좌하→우하)로 셀에 채워진다', () => {
    const cells = cellsFor(mkPanes(4))
    expect(cells.map((c) => [c.col, c.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ])
  })

  it('상한은 4패널이다', () => {
    expect(MAX_PANES).toBe(4)
  })
})

// R2.0: 1→2 분할은 방향을 따른다. 가로 분할(Ctrl+-)=상하, 세로 분할(Ctrl+\)=좌우.
describe('분할 방향 (R2.0 2패널 배치 축)', () => {
  it('세로 분할(lr)은 2열 1행, 가로 분할(tb)은 1열 2행', () => {
    expect(gridUsage(2, 'lr')).toEqual({ cols: 2, rows: 1 })
    expect(gridUsage(2, 'tb')).toEqual({ cols: 1, rows: 2 })
  })

  it('3패널부터는 방향과 무관하게 2x2', () => {
    expect(gridUsage(3, 'tb')).toEqual({ cols: 2, rows: 2 })
    expect(gridUsage(4, 'tb')).toEqual({ cols: 2, rows: 2 })
  })

  it('가로 분할 2패널은 같은 열에 위·아래로 놓인다', () => {
    expect(cellsFor(mkPanes(2), 'tb').map((c) => [c.col, c.row])).toEqual([
      [0, 0],
      [0, 1]
    ])
  })

  it('세로 분할 2패널은 같은 행에 좌·우로 놓인다', () => {
    expect(cellsFor(mkPanes(2), 'lr').map((c) => [c.col, c.row])).toEqual([
      [0, 0],
      [1, 0]
    ])
  })

  it('가로 분할 2패널은 col split{pane,pane} 으로 직렬화된다(3~4패널의 col{row,row} 와 구분)', () => {
    const node = toLayoutNode(stateOf(2, { pairAxis: 'tb', rowRatio: 0.35 }))
    expect(node.type).toBe('split')
    if (node.type === 'split') {
      expect(node.direction).toBe('col')
      expect(node.ratio).toEqual([0.35, 0.65])
      expect(node.children.every((c) => c.type === 'pane')).toBe(true)
    }
  })
})

describe('toLayoutNode (§B.3 스냅샷 스키마)', () => {
  it('단일 패널은 pane 노드로 직렬화된다', () => {
    const node = toLayoutNode(stateOf(1))
    expect(node).toEqual({ type: 'pane', sessionId: 's1' })
  })

  it('2패널은 row split(좌/우) — ratio 는 colRatio 반영', () => {
    const node = toLayoutNode(stateOf(2, { colRatio: 0.4 }))
    expect(node.type).toBe('split')
    if (node.type === 'split') {
      expect(node.direction).toBe('row')
      expect(node.ratio).toEqual([0.4, 0.6])
      expect(node.children.map((c) => (c.type === 'pane' ? c.sessionId : null))).toEqual(['s1', 's2'])
    }
  })

  it('4패널은 col split(상/하) 안에 각 행이 row split — leaf 4개', () => {
    const node = toLayoutNode(stateOf(4, { rowRatio: 0.6 }))
    expect(node.type).toBe('split')
    if (node.type === 'split') {
      expect(node.direction).toBe('col')
      expect(node.ratio).toEqual([0.6, 0.4])
    }
    expect(countLeaves(node)).toBe(4)
  })

  it('어떤 패널 수(1~4)에서도 leaf 개수가 4를 넘지 않는다(트리 불변식)', () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      expect(countLeaves(toLayoutNode(stateOf(n)))).toBeLessThanOrEqual(MAX_PANES)
    }
  })
})
