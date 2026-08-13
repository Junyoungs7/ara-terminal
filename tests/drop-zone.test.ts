import { describe, it, expect } from 'vitest'
import { paneDropZone, zoneRect, axisForZone } from '../src/renderer/store/dropZone'

// FB-0002: 탭 드래그 → 패널 드롭 방향 판정(순수 함수 — 패널 사각형 + 커서 좌표 → 방향).
const rect = { left: 100, top: 200, width: 400, height: 300 }

describe('paneDropZone (탭 드래그 → 분할 방향 판정)', () => {
  it('한가운데는 중앙(이동/교체)', () => {
    expect(paneDropZone(rect, 300, 350)).toBe('center')
  })

  it('왼쪽 가장자리는 left, 오른쪽 가장자리는 right', () => {
    expect(paneDropZone(rect, 105, 350)).toBe('left')
    expect(paneDropZone(rect, 495, 350)).toBe('right')
  })

  it('위쪽 가장자리는 top, 아래쪽 가장자리는 bottom', () => {
    expect(paneDropZone(rect, 300, 205)).toBe('top')
    expect(paneDropZone(rect, 300, 495)).toBe('bottom')
  })

  it('가로·세로 모두 가장자리면 더 가까운 쪽 하나를 고른다', () => {
    // 좌상단 모서리 근처, 왼쪽 변이 위쪽 변보다 커서에 더 가깝다(nx < ny).
    expect(paneDropZone(rect, 102, 210)).toBe('left')
  })

  it('폭·높이가 0 이하인 사각형은 중앙으로 취급(0으로 나누기 방지)', () => {
    expect(paneDropZone({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBe('center')
  })
})

describe('zoneRect (미리보기 사각형)', () => {
  it('center 는 패널 전체', () => {
    expect(zoneRect(rect, 'center')).toEqual(rect)
  })

  it('left/right 는 절반 너비, 높이는 그대로', () => {
    expect(zoneRect(rect, 'left')).toEqual({ left: 100, top: 200, width: 200, height: 300 })
    expect(zoneRect(rect, 'right')).toEqual({ left: 300, top: 200, width: 200, height: 300 })
  })

  it('top/bottom 은 절반 높이, 너비는 그대로', () => {
    expect(zoneRect(rect, 'top')).toEqual({ left: 100, top: 200, width: 400, height: 150 })
    expect(zoneRect(rect, 'bottom')).toEqual({ left: 100, top: 350, width: 400, height: 150 })
  })
})

describe('axisForZone (분할 축 매핑)', () => {
  it('left/right 는 세로 분할(lr), top/bottom 은 가로 분할(tb)', () => {
    expect(axisForZone('left')).toBe('lr')
    expect(axisForZone('right')).toBe('lr')
    expect(axisForZone('top')).toBe('tb')
    expect(axisForZone('bottom')).toBe('tb')
  })
})
