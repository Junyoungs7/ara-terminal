import { describe, it, expect } from 'vitest'
import { isTabOverflowing } from '../src/renderer/store/tabOverflow'

// FB-tabs: 탭바 오버플로 판정(가용 폭 대비 콘텐츠 폭 → 드롭다운 노출 여부).
describe('isTabOverflowing (탭바 오버플로 드롭다운 노출 판정)', () => {
  it('콘텐츠가 가용 폭보다 좁으면 오버플로 아님', () => {
    expect(isTabOverflowing(600, 400)).toBe(false)
  })

  it('콘텐츠가 가용 폭보다 넓으면 오버플로', () => {
    expect(isTabOverflowing(600, 900)).toBe(true)
  })

  it('딱 맞으면(동일) 오버플로 아님 — 서브픽셀 오차 여유', () => {
    expect(isTabOverflowing(600, 600)).toBe(false)
    expect(isTabOverflowing(600, 600.4)).toBe(false)
  })

  it('오차 여유를 넘는 초과는 오버플로', () => {
    expect(isTabOverflowing(600, 602)).toBe(true)
  })
})
