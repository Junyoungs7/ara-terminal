// FB-0002: 탭을 터미널 패널로 드래그했을 때 "어느 방향으로 분할할지" 판정하는 순수 함수.
// 패널 사각형 + 커서 좌표만 받는다 — DOM·React 의존 없음(vitest 대상).
// 안쪽 60%(가운데)는 그 패널로 이동/교체, 바깥 40%는 가장 가까운 가장자리 방향으로 분할(FB-0002).
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type Rect = { left: number; top: number; width: number; height: number }

const CENTER_MARGIN = 0.3 // 가운데 판정 폭 — 좌우/상하 각각 30%는 가장자리, 남는 40%가 중앙.

export function paneDropZone(rect: Rect, x: number, y: number): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const nx = (x - rect.left) / rect.width
  const ny = (y - rect.top) / rect.height
  const inCenterX = nx >= CENTER_MARGIN && nx <= 1 - CENTER_MARGIN
  const inCenterY = ny >= CENTER_MARGIN && ny <= 1 - CENTER_MARGIN
  if (inCenterX && inCenterY) return 'center'
  // 네 변 중 커서가 가장 가까운 쪽을 고른다(경계 밖 좌표도 클램프 없이 그대로 비교 — 항상 하나는 뽑힌다).
  const candidates: [DropZone, number][] = [
    ['left', nx],
    ['right', 1 - nx],
    ['top', ny],
    ['bottom', 1 - ny]
  ]
  return candidates.reduce((min, cur) => (cur[1] < min[1] ? cur : min))[0]
}

// 분할이 갈 축(PairAxis 'lr'|'tb') — 좌/우는 세로 분할, 상/하는 가로 분할.
export function axisForZone(zone: 'left' | 'right' | 'top' | 'bottom'): 'lr' | 'tb' {
  return zone === 'left' || zone === 'right' ? 'lr' : 'tb'
}

// 미리보기 사각형: center=패널 전체, 그 외=패널의 절반(왼쪽/오른쪽/위/아래).
export function zoneRect(rect: Rect, zone: DropZone): Rect {
  const half = { w: rect.width / 2, h: rect.height / 2 }
  switch (zone) {
    case 'left':
      return { left: rect.left, top: rect.top, width: half.w, height: rect.height }
    case 'right':
      return { left: rect.left + half.w, top: rect.top, width: half.w, height: rect.height }
    case 'top':
      return { left: rect.left, top: rect.top, width: rect.width, height: half.h }
    case 'bottom':
      return { left: rect.left, top: rect.top + half.h, width: rect.width, height: half.h }
    case 'center':
    default:
      return rect
  }
}
