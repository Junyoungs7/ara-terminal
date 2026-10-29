import { describe, it, expect } from 'vitest'
import {
  allPanesRdp,
  gridUsage,
  cellsFor,
  toLayoutNode,
  MAX_PANES,
  showSessionPanes,
  splitFiller,
  splitPanes,
  type LayoutState,
  type Pane
} from '../src/renderer/store/layout'
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

// 2026-09-02 준영님 ③: *"rdp 는 어차피 하단바를 사용 못하니까 rdp 연결할 때는 하단바를 켜지
// 말게 해 줘."* 감추는 판정을 여기서 못 박는다 — 조용히 뒤집히면 **터미널을 보는데 하단바가
// 없거나**(더 나쁘다) RDP 를 보는데 그대로 있거나 둘 중 하나다.
describe('하단바를 감출 칸 구성', () => {
  const pane = (sessionId: string): Pane => ({ id: `p-${sessionId}`, sessionId })

  it('★ 칸이 전부 RDP 일 때만 감춘다', () => {
    expect(allPanesRdp([pane('rdp:prof-1:2')])).toBe(true)
    expect(allPanesRdp([pane('rdp:a:1'), pane('rdp:b:2')])).toBe(true)
  })

  it('★ 터미널이 한 칸이라도 있으면 둔다 — 그 칸이 하단바를 쓴다(포커스가 어디든)', () => {
    expect(allPanesRdp([pane('rdp:a:1'), pane('s-local-1')])).toBe(false)
  })

  it('칸이 하나도 없으면(빈 시작) 감추지 않는다 — 감출 근거가 없다', () => {
    expect(allPanesRdp([])).toBe(false)
  })
})

/**
 * 분할 경합(2.0 e2e SPLIT-2~7·CHROME-2·CTX-2·KEY-6): 배경 탭이 없으면 분할이 새 셸을 연다(MainArea doSplit).
 * 그 셸의 `session:opened` 가 `session:create` 응답보다 **먼저** 오면 리스너의 showSession 이 보던 칸의
 * 세션을 새 셸로 갈아 끼우고, 이어지는 split 이 같은 새 셸로 둘째 칸을 만든다 — 한 세션이 두 칸이라
 * PaneGrid 는 칸 하나만 그린다. 분할 전에 그 칸에 있던 세션(splitFiller)을 filler 로 넘기면 제자리로 돌아온다.
 */
describe('분할 경합 — opened 가 create 응답보다 먼저 와도 두 칸이 된다', () => {
  const one = (): LayoutState => stateOf(1, { focusedId: 'p1' }) // p1 = s1
  it('splitFiller 는 showSession 이 덮어쓸 칸(포커스, 없으면 첫 칸)의 세션이다', () => {
    expect(splitFiller(one())).toBe('s1')
    expect(splitFiller(stateOf(2))).toBe('s1')
    expect(splitFiller(stateOf(0))).toBeUndefined()
  })
  it('opened 가 먼저 와도 filler 를 주면 [원래 세션, 새 세션] 두 칸', () => {
    const s = one()
    const raced = showSessionPanes(s, 'new')
    expect(raced.panes.map((p) => p.sessionId)).toEqual(['new']) // 경합: 보던 칸이 새 셸로 바뀌었다
    const after = splitPanes(raced, 'p2', 'new', 'lr', false, splitFiller(s))
    expect(after.panes.map((p) => p.sessionId)).toEqual(['s1', 'new'])
    expect(after.focusedId).toBe('p2')
  })
  it('opened 가 나중에 와도 같은 결과(filler 는 아무것도 바꾸지 않는다)', () => {
    const s = one()
    const split = splitPanes(s, 'p2', 'new', 'lr', false, splitFiller(s))
    const after = showSessionPanes(split, 'new')
    expect(after.panes.map((p) => p.sessionId)).toEqual(['s1', 'new'])
    expect(after.focusedId).toBe('p2')
  })
})
