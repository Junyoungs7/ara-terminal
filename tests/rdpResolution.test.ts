// F25 RDP 해상도 선택 — 라벨 ↔ 픽셀 변환(순수 함수). 라벨이 어긋나면 드롭다운에서 고른 해상도가
// 조용히 "창 크기에 맞춤"으로 떨어진다(목록에 없는 라벨 = null 이므로) — 그 회귀를 잡는다.
import { describe, it, expect } from 'vitest'
import { RDP_DEFAULT, RDP_RESOLUTIONS, fixedResolution, resLabel, round4 } from '../src/renderer/components/rdpInput'

describe('RDP 해상도', () => {
  it('목록의 모든 라벨이 자기 해상도로 되돌아온다', () => {
    for (const r of RDP_RESOLUTIONS) expect(fixedResolution(resLabel(r))).toEqual(r)
  })

  it('기본값은 목록에 있는 1920x1080 이다', () => {
    expect(RDP_DEFAULT).toEqual([1920, 1080])
    expect(fixedResolution(resLabel(RDP_DEFAULT))).toEqual(RDP_DEFAULT)
  })

  it('목록에 없는 라벨(= 창 크기에 맞춤)은 null 이다', () => {
    expect(fixedResolution('창 크기에 맞춤')).toBeNull()
    expect(fixedResolution('1920x1080')).toBeNull() // 구분자가 다르면 다른 라벨이다
  })

  it('창 맞춤 크기는 4의 배수로 내리고 640 미만으로는 안 내려간다', () => {
    expect(round4(1013)).toBe(1012)
    expect(round4(1920)).toBe(1920)
    expect(round4(100)).toBe(640)
  })
})
