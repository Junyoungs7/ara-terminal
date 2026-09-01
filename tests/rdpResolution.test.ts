// F25 RDP 해상도 선택 — 라벨 ↔ 픽셀 변환(순수 함수). 라벨이 어긋나면 드롭다운에서 고른 해상도가
// 조용히 "창 크기에 맞춤"으로 떨어진다(목록에 없는 라벨 = null 이므로) — 그 회귀를 잡는다.
import { describe, it, expect } from 'vitest'
import {
  RDP_DEFAULT,
  RDP_RESOLUTIONS,
  canvasPoint,
  fixedResolution,
  resLabel,
  resolveSize,
  round4
} from '../src/renderer/components/rdpInput'
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

// 2026-09-01 제보 ⑤ — 창 맞춤일 때 캔버스가 칸을 꽉 채우게(object-fit: contain) 바꿨다.
// 그러면 비율이 다를 때 **그림 둘레에 여백**이 생긴다. 좌표를 상자 기준으로만 재면 클릭이 그
// 여백만큼 밀려 원격에서 엉뚱한 곳을 누른다 — 그 회귀를 여기서 잡는다.
const fakeCanvas = (w: number, h: number, rect: { left: number; top: number; width: number; height: number }) =>
  ({ width: w, height: h, getBoundingClientRect: () => rect }) as unknown as HTMLCanvasElement

describe('캔버스 좌표 → 원격 좌표', () => {
  it('여백이 없으면(상자 = 그림) 배율만 되돌린다', () => {
    const c = fakeCanvas(1000, 500, { left: 0, top: 0, width: 500, height: 250 })
    expect(canvasPoint(c, 250, 125)).toEqual({ x: 500, y: 250 })
  })

  it('★ 좌우 여백 — 그림 왼쪽 끝을 누르면 원격 x=0 이다(상자 왼쪽이 아니다)', () => {
    // 800×600(4:3) 을 1000×600 칸에 담으면 좌우로 100px 씩 남는다.
    const c = fakeCanvas(800, 600, { left: 0, top: 0, width: 1000, height: 600 })
    expect(canvasPoint(c, 100, 0)).toEqual({ x: 0, y: 0 })
    expect(canvasPoint(c, 500, 300)).toEqual({ x: 400, y: 300 }) // 가운데는 가운데
  })

  it('★ 위아래 여백 — 세로로 남을 때도 같은 규칙', () => {
    // 800×600 을 800×800 칸에 담으면 위아래로 100px 씩 남는다.
    const c = fakeCanvas(800, 600, { left: 0, top: 0, width: 800, height: 800 })
    expect(canvasPoint(c, 0, 100)).toEqual({ x: 0, y: 0 })
    expect(canvasPoint(c, 400, 400)).toEqual({ x: 400, y: 300 })
  })

  it('상자 밖은 화면 안으로 자른다 — 원격에 없는 좌표를 보내지 않는다', () => {
    const c = fakeCanvas(800, 600, { left: 0, top: 0, width: 800, height: 600 })
    expect(canvasPoint(c, -50, -50)).toEqual({ x: 0, y: 0 })
    expect(canvasPoint(c, 9999, 9999)).toEqual({ x: 799, y: 599 })
  })

  it('숨은 칸(0px)이어도 NaN 을 보내지 않는다', () => {
    const c = fakeCanvas(800, 600, { left: 0, top: 0, width: 0, height: 0 })
    const p = canvasPoint(c, 10, 10)
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })
})
