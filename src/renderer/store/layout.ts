import { useCallback, useMemo, useState } from 'react'
import type { LayoutNode } from '../../shared/types'

// F4a 분할 레이아웃 모델. 최대 4패널(2x2). 목업 variant-final-3 의 고정 2x2 그리드를
// 동적으로 재현: 패널을 순서대로 셀에 채우고(1→좌상, 2→우상, 3→좌하, 4→우하),
// colRatio/rowRatio 로 divider 비율을 조절한다. (레이아웃 라이브러리 금지 — CSS grid + 자체 상태)
//
// §B.3 layout 트리 스키마는 스냅샷 직렬화용 — toLayoutNode() 로 파생한다(복원 배선은 F6).

export const MAX_PANES = 4

// 2패널일 때의 배치 축(R2.0). 'lr' = 좌·우(세로 분할 Ctrl+\), 'tb' = 상·하(가로 분할 Ctrl+-).
// 3패널부터는 2x2 그리드 빈 셀을 채우므로 방향을 따지지 않는다(임의 중첩 분할 트리는 만들지 않는다).
export type PairAxis = 'lr' | 'tb'

// 셀 좌표(col,row) 채움 순서 — 목업 그리드 배치와 동일.
// 1패널: 좌상 전체 / 2패널: 좌·우(또는 상·하) / 3·4패널: 2x2.
const CELL_ORDER: ReadonlyArray<{ col: 0 | 1; row: 0 | 1 }> = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 }
]

// 2패널 상·하 배치일 때의 셀 순서(같은 열, 위→아래).
const CELL_ORDER_TB: ReadonlyArray<{ col: 0 | 1; row: 0 | 1 }> = [
  { col: 0, row: 0 },
  { col: 0, row: 1 }
]

export type Pane = { id: string; sessionId: string }

export type PaneCell = Pane & { col: 0 | 1; row: 0 | 1 }

let paneSeq = 0
const nextPaneId = () => `p${(paneSeq += 1)}`

export type LayoutState = {
  panes: Pane[]
  focusedId: string | null
  colRatio: number // 좌열 비율(0.2~0.8), 우열 = 1 - colRatio
  rowRatio: number // 상행 비율
  maximizedId: string | null
  pairAxis: PairAxis
}

// 몇 개의 열/행이 실제로 쓰이는지(그리드 템플릿 결정용).
export function gridUsage(count: number, pairAxis: PairAxis = 'lr'): { cols: 1 | 2; rows: 1 | 2 } {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count === 2) return pairAxis === 'tb' ? { cols: 1, rows: 2 } : { cols: 2, rows: 1 }
  return { cols: 2, rows: 2 } // 3~4패널
}

export function cellsFor(panes: Pane[], pairAxis: PairAxis = 'lr'): PaneCell[] {
  const order = panes.length === 2 && pairAxis === 'tb' ? CELL_ORDER_TB : CELL_ORDER
  return panes.map((p, i) => ({ ...p, ...order[i] }))
}

/**
 * 지금 보이는 칸이 **전부 RDP** 인가 — 하단바를 그릴지 정한다.
 *
 * 2026-09-02 준영님: *"rdp 는 어차피 하단바를 사용 못하니까 rdp 연결할 때는 하단바를 켜지 말게
 * 해 줘."* 포트·프로세스·컨테이너는 **SSH 세션의 것**이라 RDP 칸에는 보여 줄 것이 없다.
 *
 * **포커스 칸이 아니라 칸 구성으로 판정한다.** 포커스 기준이면 터미널과 RDP 를 나란히 둔 분할에서
 * 칸을 옮길 때마다 하단바가 사라졌다 나타나고, 하단바는 덮지 않고 **밀어내므로**(terminal/
 * resizeGate.ts 머리주석) 그때마다 터미널이 다시 맞춰진다 — 클릭 한 번에 화면이 튄다.
 * 한 칸이라도 터미널이면 그 터미널이 하단바를 쓴다.
 *
 * 칸이 하나도 없으면(빈 시작) 지금까지처럼 둔다 — 감출 근거가 없다.
 * `rdp:` 접두는 이 저장소가 이미 쓰는 판정이다(MainArea 의 스냅샷 저장 제외 · sessions.close).
 *
 * **남는 것**: 우측 바의 [하단바] 토글은 그동안에도 켜진 채로 보인다. 그 버튼은 "무엇을 열지"가
 * 아니라 "**하단바를 쓸지**"를 정하는 설정이고(ActivityBar.tsx 주석) 그 설정은 여전히 켜져 있는
 * 것이 맞다 — 다만 RDP 칸에서 눌러도 화면이 안 바뀐다. 그게 걸리면 이 판정을 Shell 로 올려
 * (onSettingsOpenChange 식 미러) 버튼을 비활성으로 만들면 된다.
 */
export function allPanesRdp(panes: readonly Pane[]): boolean {
  return panes.length > 0 && panes.every((p) => p.sessionId.startsWith('rdp:'))
}

// 스냅샷 §B.3 layout 트리로 직렬화. 단일 패널=pane, 그 외=중첩 split(row/col).
export function toLayoutNode(state: LayoutState): LayoutNode {
  const { panes, colRatio, rowRatio, pairAxis } = state
  const pane = (p: Pane | undefined): LayoutNode => ({ type: 'pane', sessionId: p?.sessionId ?? null })
  if (panes.length <= 1) return pane(panes[0])
  const topRow: LayoutNode = {
    type: 'split',
    direction: 'row',
    ratio: [colRatio, 1 - colRatio],
    children: [pane(panes[0]), pane(panes[1])]
  }
  // 2패널 상·하 배치는 col split{pane,pane} — 3~4패널의 col split{row,row} 와 구조로 구분된다.
  if (panes.length === 2 && pairAxis === 'tb') {
    return { type: 'split', direction: 'col', ratio: [rowRatio, 1 - rowRatio], children: [pane(panes[0]), pane(panes[1])] }
  }
  if (panes.length <= 2) return topRow
  const bottomLeft = pane(panes[2])
  const bottomRight = pane(panes[3])
  const bottomRow: LayoutNode = {
    type: 'split',
    direction: 'row',
    ratio: [colRatio, 1 - colRatio],
    children: panes.length === 3 ? [bottomLeft, { type: 'pane', sessionId: null }] : [bottomLeft, bottomRight]
  }
  return { type: 'split', direction: 'col', ratio: [rowRatio, 1 - rowRatio], children: [topRow, bottomRow] }
}

const RATIO_MIN = 0.2
const RATIO_MAX = 0.8
const clampRatio = (r: number) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r))

// toLayoutNode 의 역: 저장된 layout 트리를 (패널 순서 sessionId 목록 + col/row 비율)로 복원한다(F6).
// toLayoutNode 가 만드는 구조만 처리한다: 단일 pane / row split(2) / col split{row,row}(3~4).
// sessionId=null 인 패널(3분할의 빈 우하 등)은 제외 — 실제 세션이 있는 패널만 복원한다.
export type RestoredLayout = { sessionIds: string[]; colRatio: number; rowRatio: number; pairAxis: PairAxis }

export function fromLayoutNode(node: LayoutNode): RestoredLayout {
  const sessionIds: string[] = []
  let colRatio = 0.5
  let rowRatio = 0.5
  let pairAxis: PairAxis = 'lr'
  const pushPane = (n: LayoutNode) => {
    if (n.type === 'pane') {
      if (n.sessionId) sessionIds.push(n.sessionId)
    }
  }
  if (node.type === 'pane') {
    pushPane(node)
  } else if (node.direction === 'row') {
    // 2패널(좌/우). ratio[0] = colRatio.
    colRatio = node.ratio[0] ?? 0.5
    node.children.forEach(pushPane)
  } else {
    // col split(상/하). ratio[0] = rowRatio. 자식이 모두 pane 이면 2패널 상·하 배치(R2.0),
    // row split 이면 3~4패널 2x2.
    rowRatio = node.ratio[0] ?? 0.5
    if (node.children.every((c) => c.type === 'pane')) pairAxis = 'tb'
    for (const rowNode of node.children) {
      if (rowNode.type === 'split' && rowNode.direction === 'row') {
        colRatio = rowNode.ratio[0] ?? colRatio
        rowNode.children.forEach(pushPane)
      } else {
        pushPane(rowNode)
      }
    }
  }
  return { sessionIds: sessionIds.slice(0, MAX_PANES), colRatio, rowRatio, pairAxis }
}

export function useLayout(initialSessionId: string | null) {
  const [state, setState] = useState<LayoutState>(() => ({
    panes: initialSessionId ? [{ id: nextPaneId(), sessionId: initialSessionId }] : [],
    focusedId: null,
    colRatio: 0.5,
    rowRatio: 0.5,
    maximizedId: null,
    pairAxis: 'lr'
  }))

  // 분할: 지정 세션을 새 패널에 올린다. 상한 초과면 조용히 무시한다(호출부가 canSplit 으로 먼저 막고
  // 토스트를 띄운다). 성공 여부를 반환하지 않는 이유: setState 업데이터는 React 가 동기 호출한다는
  // 보장이 없어 "업데이터 안에서 세운 플래그를 반환"하면 실제로 패널이 늘었는데도 실패로 읽힌다.
  // axis 는 1→2 분할에서만 반영된다(3·4번째는 2x2 빈 셀 채움 — 방향 무시).
  const split = useCallback(
    (
      newSessionId: string,
      axis: PairAxis = 'lr',
      // 새 칸을 앞(왼쪽/위)에 넣을지. 드래그로 왼쪽 가장자리에 놓으면 왼쪽에 생겨야 한다 —
      // 예전엔 항상 뒤에 붙여서 어느 쪽에 놓든 오른쪽에 생겼다(준영님 제보).
      before = false,
      // 옮기는 세션이 이미 다른 칸에 있으면 그 칸에 대신 올릴 세션. 없으면 그 칸이 빈 채로 남는다
      // (한 세션은 한 칸에만 그려진다 — 같은 세션을 두 칸에 두면 나중 칸이 통째로 빈다, 실제 증상).
      filler?: string
    ): void => {
      setState((s) => {
        if (s.panes.length >= MAX_PANES) return s // 상한 — 변화 없음
        const p = { id: nextPaneId(), sessionId: newSessionId }
        const kept = filler
          ? s.panes.map((x) => (x.sessionId === newSessionId ? { ...x, sessionId: filler } : x))
          : s.panes
        return {
          ...s,
          panes: before ? [p, ...kept] : [...kept, p],
          pairAxis: s.panes.length === 1 ? axis : s.pairAxis,
          focusedId: p.id,
          maximizedId: null
        }
      })
    },
    []
  )

  const focus = useCallback((paneId: string) => {
    setState((s) => (s.focusedId === paneId ? s : { ...s, focusedId: paneId }))
  }, [])

  // 세션 활성화(탭·트리 클릭): 이미 어떤 패널이 표시 중이면 그 패널을 포커스,
  // 아니면 포커스 패널의 sessionId 를 교체(display 전환 — xterm 재마운트 없음). 패널이 없으면 첫 패널 생성.
  const showSession = useCallback((sessionId: string) => {
    setState((s) => {
      const existing = s.panes.find((p) => p.sessionId === sessionId)
      if (existing) return existing.id === s.focusedId ? s : { ...s, focusedId: existing.id }
      if (s.panes.length === 0) {
        const p = { id: nextPaneId(), sessionId }
        return { ...s, panes: [p], focusedId: p.id }
      }
      const targetId = s.focusedId ?? s.panes[0].id
      const panes = s.panes.map((p) => (p.id === targetId ? { ...p, sessionId } : p))
      return { ...s, panes, focusedId: targetId }
    })
  }, [])

  // F6 부분 복원 재시도: 특정 패널의 sessionId 를 교체(오류 placeholder → 재접속 성공 세션).
  const replaceSession = useCallback((fromSessionId: string, toSessionId: string) => {
    setState((s) => {
      const idx = s.panes.findIndex((p) => p.sessionId === fromSessionId)
      if (idx < 0) return s
      const panes = s.panes.map((p) => (p.sessionId === fromSessionId ? { ...p, sessionId: toSessionId } : p))
      return { ...s, panes, focusedId: s.panes[idx].id }
    })
  }, [])

  // 세션 종료: 그 세션을 표시 중인 패널을 제거(탭 닫기 경로). 없으면 변화 없음.
  const removeSession = useCallback((sessionId: string) => {
    setState((s) => {
      const idx = s.panes.findIndex((p) => p.sessionId === sessionId)
      if (idx < 0) return s
      const panes = s.panes.filter((p) => p.sessionId !== sessionId)
      const closedId = s.panes[idx].id
      const focusedId =
        s.focusedId === closedId ? (panes[idx]?.id ?? panes[idx - 1]?.id ?? panes[0]?.id ?? null) : s.focusedId
      const maximizedId = s.maximizedId === closedId ? null : s.maximizedId
      return { ...s, panes, focusedId, maximizedId }
    })
  }, [])

  // 패널 닫기: 배열에서 제거 + 인접 패널로 포커스 이동(공간 회수는 재배치로 자동).
  // 닫힌 패널의 sessionId 를 반환(호출부가 세션 종료 결정).
  const closePane = useCallback((paneId: string): string | null => {
    let closedSession: string | null = null
    setState((s) => {
      const idx = s.panes.findIndex((p) => p.id === paneId)
      if (idx < 0) return s
      closedSession = s.panes[idx].sessionId
      const panes = s.panes.filter((p) => p.id !== paneId)
      const focusedId =
        s.focusedId === paneId ? (panes[idx]?.id ?? panes[idx - 1]?.id ?? panes[0]?.id ?? null) : s.focusedId
      const maximizedId = s.maximizedId === paneId ? null : s.maximizedId
      return { ...s, panes, focusedId, maximizedId }
    })
    return closedSession
  }, [])

  const setColRatio = useCallback((r: number) => setState((s) => ({ ...s, colRatio: clampRatio(r) })), [])
  const setRowRatio = useCallback((r: number) => setState((s) => ({ ...s, rowRatio: clampRatio(r) })), [])

  // F6 복원: 저장된 패널 배치(sessionId 순서 + 비율)를 그대로 재구성한다. 첫 sessionId 패널에 포커스.
  // 부트에서 1회만 호출된다(권위 복원).
  const restore = useCallback((r: RestoredLayout) => {
    setState((s) => {
      const ids = r.sessionIds.slice(0, MAX_PANES)
      if (ids.length === 0) return s // 배치할 세션 없음 — 기존 유지.
      const panes = ids.map((sid) => ({ id: nextPaneId(), sessionId: sid }))
      return {
        panes,
        focusedId: panes[0]?.id ?? null,
        colRatio: clampRatio(r.colRatio),
        rowRatio: clampRatio(r.rowRatio),
        maximizedId: null,
        pairAxis: r.pairAxis
      }
    })
  }, [])

  // 최대화 토글(Ctrl+Up): 포커스 패널만 표시 / 다시 누르면 전체.
  // id 를 주면 **그 패널**을, 안 주면 지금까지대로 포커스 패널을 최대화한다. 패널 헤더의
  // [최대화] 버튼(2026-08-17 제보 ⑦)이 id 를 준다 — 클릭이 포커스도 옮기지만 그 순서에
  // 기대지 않는다. 이미 최대화 중이면 무엇을 눌러도 원래대로 돌아온다(토글 하나로 족하다).
  const toggleMaximize = useCallback((id?: string) => {
    setState((s) => {
      if (s.maximizedId) return { ...s, maximizedId: null }
      const target = id ?? s.focusedId
      if (!target) return s
      return { ...s, maximizedId: target }
    })
  }, [])

  // 포커스 이동(Alt+Arrow): 방향에 따라 인접 셀 패널로.
  const moveFocus = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    setState((s) => {
      if (s.panes.length < 2 || !s.focusedId) return s
      const cells = cellsFor(s.panes, s.pairAxis)
      const cur = cells.find((c) => c.id === s.focusedId)
      if (!cur) return s
      const want =
        dir === 'left'
          ? { col: 0, row: cur.row }
          : dir === 'right'
            ? { col: 1, row: cur.row }
            : dir === 'up'
              ? { col: cur.col, row: 0 }
              : { col: cur.col, row: 1 }
      const target = cells.find((c) => c.col === want.col && c.row === want.row)
      if (!target || target.id === s.focusedId) return s
      return { ...s, focusedId: target.id }
    })
  }, [])

  const cells = useMemo(() => cellsFor(state.panes, state.pairAxis), [state.panes, state.pairAxis])
  const usage = useMemo(
    () => gridUsage(state.panes.length, state.pairAxis),
    [state.panes.length, state.pairAxis]
  )

  return {
    ...state,
    cells,
    usage,
    canSplit: state.panes.length < MAX_PANES,
    split,
    focus,
    showSession,
    removeSession,
    closePane,
    setColRatio,
    setRowRatio,
    toggleMaximize,
    moveFocus,
    restore,
    replaceSession
  }
}
