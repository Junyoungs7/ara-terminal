// F25 RDP 해상도 선택 — 라벨 ↔ 픽셀 변환(순수 함수). 라벨이 어긋나면 드롭다운에서 고른 해상도가
// 조용히 "창 크기에 맞춤"으로 떨어진다(목록에 없는 라벨 = null 이므로) — 그 회귀를 잡는다.
import { describe, it, expect } from 'vitest'
import { RDP_DEFAULT, RDP_RESOLUTIONS, fixedResolution, resLabel, resolveSize, round4 } from '../src/renderer/components/rdpInput'
import ko from '../src/renderer/i18n/ko.json'

describe('RDP 해상도', () => {
  it('목록의 모든 라벨이 자기 해상도로 되돌아온다', () => {
    for (const r of RDP_RESOLUTIONS) expect(fixedResolution(resLabel(r))).toEqual(r)
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

// 2026-08-24 준영님 요청 — 기본을 "창 크기에 맞춤"으로 통일했다. 기본값이 된 이상,
// 창을 따라가는 쪽과 따라가지 않는 쪽이 정확히 갈려야 한다.
describe('창 맞춤이 기본', () => {
  it('★ 기본 라벨(ko.json 의 창 맞춤)은 고정 해상도가 아니다 — 칸을 잰다', () => {
    // RdpView 의 초깃값이 이 라벨이다. 목록에 없어야만 "잰다"로 떨어진다.
    expect(fixedResolution(ko['rdp.res.fit'])).toBeNull()
    expect(resolveSize(ko['rdp.res.fit'], { clientWidth: 1013, clientHeight: 769 })).toEqual([1012, 768])
  })

  it('★ 고정 해상도를 고르면 칸 크기를 무시한다', () => {
    expect(resolveSize('1280 × 720', { clientWidth: 3000, clientHeight: 2000 })).toEqual([1280, 720])
  })

  it('숨은 칸(0px)은 640 으로 받치고, 칸 자체가 없으면 최후 값으로 간다', () => {
    expect(resolveSize(ko['rdp.res.fit'], { clientWidth: 0, clientHeight: 0 })).toEqual([640, 640])
    expect(resolveSize(ko['rdp.res.fit'], null)).toEqual(RDP_DEFAULT)
  })
})
