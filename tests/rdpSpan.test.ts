// 다중 모니터 펼치기 계산 — 창을 어디에 놓고 원격에 어떤 크기를 요구할지.
//
// 왜 순수 함수로 뺐나: 틀리면 창이 화면 밖에 뜨거나(다시 잡을 수 없다) 원격 해상도가 어긋나
// 접속 뒤에야 알게 된다. RDP 는 접속 시점 해상도가 세션 해상도라 되돌리려면 재접속이다.
import { describe, it, expect } from 'vitest'
import { planSpan, planSpanAll, type SpanDisplay } from '../src/shared/rdpSpan'

const d = (id: number, x: number, y: number, w: number, h: number, scaleFactor = 1): SpanDisplay => ({
  id,
  bounds: { x, y, width: w, height: h },
  scaleFactor
})

// 흔한 배치: 1920x1080 두 장을 가로로 붙였다.
const twoWide = [d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 1920, 1080)]

describe('펼치기 계획', () => {
  it('고른 것이 없으면 null — 빈 창을 띄우지 않는다', () => {
    expect(planSpan(twoWide, [])).toBeNull()
    expect(planSpanAll([])).toBeNull()
  })

  it('한 장만 고르면 그 모니터 그대로', () => {
    const p = planSpan(twoWide, [2])!
    expect(p.bounds).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 })
    expect(p.remote).toEqual({ width: 1920, height: 1080 })
    expect(p.count).toBe(1)
  })

  it('★ 두 장을 고르면 감싸는 사각형 하나가 된다 — RDP 는 큰 화면 하나를 받는다', () => {
    const p = planSpanAll(twoWide)!
    expect(p.bounds).toEqual({ x: 0, y: 0, width: 3840, height: 1080 })
    expect(p.remote).toEqual({ width: 3840, height: 1080 })
    expect(p.deadRatio).toBe(0)
  })

  it('왼쪽에 붙은 모니터도 원점이 음수로 잡힌다 — 창 좌표가 화면 밖으로 새지 않는다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)])!
    expect(p.bounds).toEqual({ x: -1920, y: 0, width: 3840, height: 1080 })
  })

  it('위아래로 쌓인 배치', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 0, 1080, 1920, 1080)])!
    expect(p.bounds.height).toBe(2160)
    expect(p.remote.height).toBe(2160)
  })

  it('★ 원격 크기는 4의 배수 — 어중간한 폭에서 화면을 깨뜨리는 서버가 있다', () => {
    const p = planSpanAll([d(1, 0, 0, 1366, 769)])!
    expect(p.remote.width % 4).toBe(0)
    expect(p.remote.height % 4).toBe(0)
    expect(p.remote).toEqual({ width: 1364, height: 768 })
  })

  it('작은 화면에서도 640 아래로는 안 내려간다', () => {
    const p = planSpanAll([d(1, 0, 0, 320, 240)])!
    expect(p.remote).toEqual({ width: 640, height: 640 })
  })

  it('★ 배율은 물리 픽셀로 환산한다 — DIP 로 요청하면 고밀도 모니터에서 흐려진다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080, 1.5)])!
    expect(p.bounds.width).toBe(1920) // 창은 DIP
    expect(p.remote.width).toBe(2880) // 원격은 물리 픽셀
  })

  it('배율이 섞이면 큰 쪽을 따른다 — 낮은 쪽이 축소되는 편이 고밀도가 흐려지는 것보다 낫다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080, 1), d(2, 1920, 0, 1920, 1080, 2)])!
    expect(p.remote.width).toBe(7680)
  })

  it('★ 어긋난 배치의 죽은 영역을 알려 준다 — 원격 바탕화면은 있는데 아무 데도 안 보이는 칸이다', () => {
    // 위아래로 어긋나게 붙인 두 장: 감싸는 사각형이 각 모니터 넓이의 합보다 크다.
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 540, 1920, 1080)])!
    expect(p.bounds).toEqual({ x: 0, y: 0, width: 3840, height: 1620 })
    // 사각형 3840x1620 = 6,220,800 / 모니터 합 = 4,147,200 → 3분의 1이 죽는다.
    expect(p.deadRatio).toBeCloseTo(1 / 3, 3)
  })

  it('없는 id 는 무시한다(모니터를 뽑은 직후 등)', () => {
    const p = planSpan(twoWide, [1, 999])!
    expect(p.count).toBe(1)
    expect(p.bounds.width).toBe(1920)
  })

  it('scaleFactor 가 0/누락이어도 1로 본다 — 0 을 곱하면 크기가 사라진다', () => {
    const p = planSpanAll([{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 0 }])!
    expect(p.remote).toEqual({ width: 1920, height: 1080 })
  })
})

// ── 모니터별 좌표 · 원격에 알릴 배열 ──────────────────────────────────────────
//
// 좌표계가 둘이라(원격 = 주 모니터 원점 / 잘라오기 = 감싸는 사각형 원점) 섞으면 화면이 통째로
// 어긋난다. 눈으로는 "두 번째 모니터만 이상하다"로 보여 원인을 찾기 어렵다 — 여기서 못 박는다.
import { monitorLayoutArgs } from '../src/shared/rdpSpan'

describe('모니터별 좌표', () => {
  it('★ 원격 좌표는 주 모니터가 원점, 잘라오기 좌표는 감싸는 사각형이 원점', () => {
    // 주 모니터가 오른쪽에 있고 보조가 왼쪽에 붙은 배치 — 두 좌표계가 실제로 갈린다.
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)])!
    const primary = p.monitors.find((m) => m.primary)!
    const left = p.monitors.find((m) => !m.primary)!

    expect(primary.rdp).toEqual({ left: 0, top: 0, right: 1919, bottom: 1079 })
    expect(left.rdp).toEqual({ left: -1920, top: 0, right: -1, bottom: 1079 })
    // 잘라오기는 둘 다 0 이상이다(프레임버퍼에 음수 자리는 없다).
    expect(left.slice).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(primary.slice).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 })
  })

  it('★ right/bottom 은 포함 좌표다 — 폭을 그대로 쓰면 1픽셀씩 겹친다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080)])!
    expect(p.monitors[0].rdp.right).toBe(1919)
    expect(p.monitors[0].rdp.bottom).toBe(1079)
  })

  it('창 자리는 DIP 그대로 — 원격 좌표(물리 픽셀)와 섞으면 창이 엉뚱한 데 뜬다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080, 2)])!
    expect(p.monitors[0].window).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(p.monitors[0].rdp.right).toBe(3839)
  })

  it('주 모니터는 정확히 하나 — 원점에 있는 것', () => {
    const p = planSpanAll([d(1, 1920, 0, 1920, 1080), d(2, 0, 0, 1920, 1080)])!
    expect(p.monitors.filter((m) => m.primary).map((m) => m.id)).toEqual([2])
  })

  it('원점에 아무도 없으면 가장 왼쪽·위를 주로 삼는다 — RDP 는 주 모니터가 반드시 원점이다', () => {
    const p = planSpan([d(1, 1920, 0, 1920, 1080), d(2, 3840, 0, 1920, 1080)], [1, 2])!
    const primary = p.monitors.find((m) => m.primary)!
    expect(primary.id).toBe(1)
    expect(primary.rdp.left).toBe(0)
    expect(p.monitors.find((m) => !m.primary)!.rdp.left).toBe(1920)
  })
})

describe('원격에 알릴 배열', () => {
  it('모니터당 5개 숫자로 평평하게 편다', () => {
    expect(monitorLayoutArgs(planSpanAll(twoWide)!)).toEqual([0, 0, 1919, 1079, 1, 1920, 0, 3839, 1079, 0])
  })

  it('★ 16장을 넘으면 null — 서버가 거절하면 사유 없이 끊긴다', () => {
    const many = Array.from({ length: 17 }, (_, i) => d(i + 1, i * 1920, 0, 1920, 1080))
    expect(monitorLayoutArgs(planSpanAll(many)!)).toBeNull()
  })

  it('★ 변이 200 미만이면 null — 단일 모니터로라도 붙는 편이 낫다', () => {
    expect(monitorLayoutArgs(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 100, 1080)])!)).toBeNull()
  })

  it('변이 8192 를 넘으면 null', () => {
    expect(monitorLayoutArgs(planSpanAll([d(1, 0, 0, 5000, 1080, 2)])!)).toBeNull()
  })

  it('한 장짜리도 정상 — 주 모니터 하나로 나간다', () => {
    expect(monitorLayoutArgs(planSpanAll([d(1, 0, 0, 1920, 1080)])!)).toEqual([0, 0, 1919, 1079, 1])
  })
})
