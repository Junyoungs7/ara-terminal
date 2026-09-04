// 다중 모니터 펼치기 계산 — 창을 어디에 놓고 원격에 어떤 크기를 요구할지.
//
// 왜 순수 함수로 뺐나: 틀리면 창이 화면 밖에 뜨거나(다시 잡을 수 없다) 원격 해상도가 어긋나
// 접속 뒤에야 알게 된다. RDP 는 접속 시점 해상도가 세션 해상도라 되돌리려면 재접속이다.
//
// 2026-09-04 부터 좌표가 셋이다(창이 있는 전체화면으로 바뀌었다 — shared/rdpSpan.ts 머리말):
//   window(작업 영역) ⊃ content(테두리 뺀 내용 영역) ⊃ canvas(주 모니터는 머리줄까지 뺀다)
// 원격 해상도는 **canvas 들을 감싸는 상자**다. 여기가 틀리면 화면이 잘린다.
import { describe, it, expect } from 'vitest'
import {
  monitorByFrame,
  monitorRects,
  planSpan,
  planSpanAll,
  spanOrigin,
  SPAN_HEADER_H,
  type MonitorRect,
  type SpanChrome,
  type SpanDisplay,
  type SpanPlan
} from '../src/shared/rdpSpan'

/** 작업 영역을 따로 안 주면 모니터 전체(작업표시줄 없음)로 본다. */
const d = (
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
  scaleFactor = 1,
  workArea?: { x: number; y: number; width: number; height: number }
): SpanDisplay => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: workArea ?? { x, y, width: w, height: h },
  scaleFactor
})

// 흔한 배치: 1920x1080 두 장을 가로로 붙였다.
const twoWide = [d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 1920, 1080)]

/** 창 껍데기 실측값 예시(Windows 11 · 100% — 제목 표시줄 31, 테두리 8). */
const CHROME: SpanChrome = { frame: { left: 8, top: 31, right: 8, bottom: 8 }, header: SPAN_HEADER_H }

describe('펼치기 계획', () => {
  it('고른 것이 없으면 null — 빈 창을 띄우지 않는다', () => {
    expect(planSpan(twoWide, [])).toBeNull()
    expect(planSpanAll([])).toBeNull()
    expect(spanOrigin(twoWide, [])).toBeNull()
  })

  it('한 장만 고르면 그 모니터 그대로', () => {
    const p = planSpan(twoWide, [2])!
    expect(p.monitors[0].window).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 })
    expect(p.remote).toEqual({ width: 1920, height: 1080 })
    expect(p.count).toBe(1)
  })

  it('★ 두 장을 고르면 감싸는 사각형 하나가 된다 — RDP 는 큰 화면 하나를 받는다', () => {
    const p = planSpanAll(twoWide)!
    expect(p.remote).toEqual({ width: 3840, height: 1080 })
    expect(p.deadRatio).toBe(0)
  })

  it('왼쪽에 붙은 모니터도 창 자리가 음수로 잡힌다 — 화면 밖으로 새지 않는다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)])!
    expect(p.monitors.find((m) => m.id === 2)!.window.x).toBe(-1920)
    expect(p.remote.width).toBe(3840)
  })

  it('위아래로 쌓인 배치', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 0, 1080, 1920, 1080)])!
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
    expect(p.monitors[0].window.width).toBe(1920) // 창은 DIP
    expect(p.remote.width).toBe(2880) // 원격은 물리 픽셀
  })

  it('배율이 섞이면 큰 쪽을 따른다 — 낮은 쪽이 축소되는 편이 고밀도가 흐려지는 것보다 낫다', () => {
    const p = planSpanAll([d(1, 0, 0, 1920, 1080, 1), d(2, 1920, 0, 1920, 1080, 2)])!
    expect(p.remote.width).toBe(7680)
  })

  it('★ 세로로 어긋난 배치를 따라가지 않는다 — 따라가면 아무 데도 안 보이는 띠만 생긴다', () => {
    // 위아래로 540 어긋나게 붙인 두 장. 예전에는 그 어긋남을 그대로 원격에 알려 3분의 1이 죽었다.
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 540, 1920, 1080)])!
    expect(p.remote).toEqual({ width: 3840, height: 1080 })
    expect(p.monitors.map((m) => m.rdp.top)).toEqual([0, 0])
    expect(p.deadRatio).toBe(0)
  })

  it('★ 크기가 다르면 남는 자리가 죽은 영역이다 — 그건 알린다', () => {
    // 1080p + 720p 를 나란히: 감싸는 상자에서 720p 위쪽 360줄이 어느 모니터에도 안 보인다.
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 1280, 720)])!
    expect(p.remote).toEqual({ width: 3200, height: 1080 })
    expect(p.deadRatio).toBeCloseTo((1280 * 360) / (3200 * 1080), 3)
  })

  it('없는 id 는 무시한다(모니터를 뽑은 직후 등)', () => {
    const p = planSpan(twoWide, [1, 999])!
    expect(p.count).toBe(1)
    expect(p.remote.width).toBe(1920)
  })

  it('scaleFactor 가 0/누락이어도 1로 본다 — 0 을 곱하면 크기가 사라진다', () => {
    const p = planSpanAll([{ ...d(1, 0, 0, 1920, 1080), scaleFactor: 0 }])!
    expect(p.remote).toEqual({ width: 1920, height: 1080 })
  })
})

// ── 창 있는 전체화면: 보이는 자리를 다시 잰다 (2026-09-04 준영님 실기 제보) ─────────────────
//
// 여기가 이 라운드의 본체다. 창에 제목 표시줄·테두리가 생기고 작업표시줄도 안 덮으니 원격 화면이
// 들어갈 자리가 모니터보다 작다. 옛 값(모니터 전체)으로 붙으면 그 차이만큼 **화면이 잘린다.**
describe('작업표시줄·테두리·머리줄을 뺀 자리로 붙는다', () => {
  // 작업표시줄 48px 이 아래에 붙은 1920x1080 한 장.
  const withTaskbar = d(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 })
  const twoWithTaskbar = [
    withTaskbar,
    d(2, 1920, 0, 1920, 1080, 1, { x: 1920, y: 0, width: 1920, height: 1032 })
  ]

  it('★ 창은 작업 영역까지만 — 작업표시줄을 덮지 않는다', () => {
    const p = planSpanAll([withTaskbar], CHROME)!
    expect(p.monitors[0].window).toEqual({ x: 0, y: 0, width: 1920, height: 1032 })
  })

  it('★ 내용 영역 = 작업 영역 − 테두리. setContentBounds 가 이 값을 그대로 쓴다', () => {
    const p = planSpanAll([withTaskbar], CHROME)!
    expect(p.monitors[0].content).toEqual({ x: 8, y: 31, width: 1904, height: 993 })
  })

  it('★ 원격 해상도 = 내용 영역 − 머리줄. 모니터 크기(1920x1080)가 아니다', () => {
    const p = planSpanAll([withTaskbar], CHROME)!
    // 1904 x (993 − 32 = 961 → 4의 배수로 960)
    expect(p.remote).toEqual({ width: 1904, height: 960 })
    expect(p.remote.height).toBeLessThan(withTaskbar.bounds.height)
  })

  it('★ 머리줄은 주 모니터 창에만 있다 — 보조 모니터는 내용 영역을 다 쓴다', () => {
    const p = planSpan(twoWithTaskbar, [1, 2], CHROME)!
    const primary = p.monitors.find((m) => m.primary)!
    const other = p.monitors.find((m) => !m.primary)!
    // 주 모니터의 원격 화면만 머리줄만큼 짧다. 자리는 둘 다 맨 위에서 시작한다 —
    // 아래로 밀면 그만큼이 아무 모니터에도 안 보이는 띠가 된다.
    // (보조 쪽은 4의 배수로 내리며 ≤3px 이 더 깎일 수 있어 차이를 정확히 32로 못 박지 않는다.)
    expect(primary.slice.height).toBe(primary.content.height - SPAN_HEADER_H)
    expect(other.slice.height).toBeGreaterThan(primary.slice.height)
    expect(primary.slice.y).toBe(0)
    expect(other.slice.y).toBe(0)
  })

  it('★ 흔한 2대 배치는 경고를 띄우지 않는다 — 머리줄 한 줄이 문턱을 넘으면 소음이다', () => {
    // 남는 것은 주 모니터 아래 머리줄 한 줄뿐(경고 문턱 2% 아래).
    expect(planSpan(twoWithTaskbar, [1, 2], CHROME)!.deadRatio).toBeLessThan(0.02)
  })

  it('배율이 다른 모니터에도 같은 DIP 테두리를 쓴다 — 물리 픽셀로는 배율만큼 두꺼워진다', () => {
    // Windows 는 배율에 맞춰 제목 표시줄의 물리 픽셀을 키우므로 DIP 로는 같다는 가정.
    // 어긋나도 창을 띄운 뒤 setContentBounds 가 내용 영역을 이 값에 맞춘다(RdpWindows.ts).
    const p = planSpan([d(1, 0, 0, 1920, 1080, 1), d(2, 1920, 0, 1000, 800, 2)], [1, 2], CHROME)!
    const other = p.monitors.find((m) => m.id === 2)!
    expect(other.content).toEqual({ x: 1928, y: 31, width: 984, height: 761 })
    // 슬라이스는 가장 큰 배율(2)의 물리 픽셀이다.
    expect(other.slice.width).toBe(984 * 2)
  })

  it('테두리를 안 주면 옛 계산과 같다 — 주 모니터를 고르는 단계에서 쓰는 경로다', () => {
    const p = planSpanAll(twoWide)!
    expect(p.monitors[0].content).toEqual(p.monitors[0].window)
    expect(p.remote).toEqual({ width: 3840, height: 1080 })
  })
})

// ── 모니터별 좌표 · 원격에 알릴 배열 ──────────────────────────────────────────
//
// 좌표계가 둘이라(원격 = 주 모니터 원점 / 잘라오기 = 감싸는 사각형 원점) 섞으면 화면이 통째로
// 어긋난다. 눈으로는 "두 번째 모니터만 이상하다"로 보여 원인을 찾기 어렵다 — 여기서 못 박는다.
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
    expect(spanOrigin([d(1, 1920, 0, 1920, 1080), d(2, 0, 0, 1920, 1080)], [1, 2])?.id).toBe(2)
  })

  it('원점에 아무도 없으면 가장 왼쪽·위를 주로 삼는다 — RDP 는 주 모니터가 반드시 원점이다', () => {
    const p = planSpan([d(1, 1920, 0, 1920, 1080), d(2, 3840, 0, 1920, 1080)], [1, 2])!
    const primary = p.monitors.find((m) => m.primary)!
    expect(primary.id).toBe(1)
    expect(primary.rdp.left).toBe(0)
    expect(p.monitors.find((m) => !m.primary)!.rdp.left).toBe(1920)
  })

  it('★ 슬라이스는 프레임버퍼를 벗어나지 않는다 — 4의 배수로 깎인 만큼 마지막 모니터를 자른다', () => {
    // 1366+1366 = 2732 → 그대로 4의 배수라 안 깎인다. 홀수 폭을 섞어 깎이게 만든다.
    const p = planSpanAll([d(1, 0, 0, 1365, 768), d(2, 1365, 0, 1366, 768)])!
    expect(p.remote.width).toBe(2728) // 2731 → 2728
    for (const m of p.monitors) {
      expect(m.slice.x + m.slice.width).toBeLessThanOrEqual(p.remote.width)
      expect(m.slice.y + m.slice.height).toBeLessThanOrEqual(p.remote.height)
    }
  })
})

// ── 🔴 2026-09-04 회귀: 사각형 사이에 틈이 생기면 서버가 배치를 통째로 버린다 ────────────────
//
// 준영님 실기: *"실제 전체화면에 펼쳐져. 수정전에는 듀얼모니터였는데 지금은 펼쳐져서 보여."*
// 원인은 원격 사각형을 **물리 좌표에서** 만들면서 테두리 폭을 좌우에서 뺀 것이었다 —
// 모니터2 right=-3, 모니터1 left=0 이 되어 2px 이 어느 모니터에도 안 속했다. RDP 는 모니터가
// 맞닿아야 해서, 서버는 그 배치를 버리고 desktop_size 한 장으로 처리한다(= 펼쳐진 한 화면).
//
// 이제 크기만 창에서 가져오고 자리는 맞붙여 깐다. 아래 다섯이 그 계약이다.
describe('🔴 원격 사각형은 맞붙는다 (준영님 실측 배치)', () => {
  // DISPLAY1 이 주 모니터이고 DISPLAY2 가 **왼쪽**(음수 x)에 있으며 **y 가 4px 어긋나** 있다.
  const real = [
    d(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 }),
    d(2, -1920, 4, 1920, 1080, 1, { x: -1920, y: 4, width: 1920, height: 1032 })
  ]
  const REAL_CHROME: SpanChrome = { frame: { left: 1, top: 31, right: 1, bottom: 1 }, header: SPAN_HEADER_H }
  const plan = planSpan(real, [1, 2], REAL_CHROME)!
  const sorted = [...plan.monitors].sort((a, b) => a.rdp.left - b.rdp.left)

  it('★ ① 틈 0 · 겹침 0 — 이 하나가 틀리면 서버가 배치를 버린다', () => {
    expect(sorted[0].rdp.right + 1).toBe(sorted[1].rdp.left)
    expect(monitorRects(plan)).not.toBeNull() // 틈·겹침 검사를 포함한다
  })

  it('★ ② 주 모니터가 (0,0)', () => {
    const primary = plan.monitors.find((m) => m.primary)!
    expect(primary.id).toBe(1)
    expect([primary.rdp.left, primary.rdp.top]).toEqual([0, 0])
  })

  it('★ ③ 바운딩 박스 == remote', () => {
    const ms = plan.monitors
    expect([
      Math.max(...ms.map((m) => m.rdp.right)) - Math.min(...ms.map((m) => m.rdp.left)) + 1,
      Math.max(...ms.map((m) => m.rdp.bottom)) - Math.min(...ms.map((m) => m.rdp.top)) + 1
    ]).toEqual([plan.remote.width, plan.remote.height])
  })

  it('★ ④ 사각형 크기 == 그 창의 content 크기(주 모니터는 머리줄만큼 짧다)', () => {
    for (const m of plan.monitors) {
      expect(m.rdp.right - m.rdp.left + 1).toBe(m.content.width)
      expect(m.rdp.bottom - m.rdp.top + 1).toBe(m.content.height - (m.primary ? SPAN_HEADER_H : 0))
    }
  })

  it('★ ⑤ slice == 그 사각형(프레임버퍼 원점으로 옮긴 것) — 어긋나면 마우스가 딴 데를 찍는다', () => {
    const minLeft = Math.min(...plan.monitors.map((m) => m.rdp.left))
    const minTop = Math.min(...plan.monitors.map((m) => m.rdp.top))
    for (const m of plan.monitors) {
      expect(m.slice).toEqual({
        x: m.rdp.left - minLeft,
        y: m.rdp.top - minTop,
        width: m.rdp.right - m.rdp.left + 1,
        height: m.rdp.bottom - m.rdp.top + 1
      })
    }
  })

  it('세로 4px 어긋남은 따라가지 않는다 — 둘 다 맨 위에서 시작한다', () => {
    expect(plan.monitors.map((m) => m.rdp.top)).toEqual([0, 0])
  })
})

describe('원격에 알릴 사각형', () => {
  it('사각형 목록을 그대로 돌려준다(주 모니터 표시 포함)', () => {
    expect(monitorRects(planSpanAll(twoWide)!)).toEqual([
      { left: 0, top: 0, right: 1919, bottom: 1079, primary: true },
      { left: 1920, top: 0, right: 3839, bottom: 1079, primary: false }
    ])
  })

  it('★ 16장을 넘으면 null — 서버가 거절하면 사유 없이 끊긴다', () => {
    const many = Array.from({ length: 17 }, (_, i) => d(i + 1, i * 1920, 0, 1920, 1080))
    expect(monitorRects(planSpanAll(many)!)).toBeNull()
  })

  it('★ 변이 200 미만이면 null — 단일 모니터로라도 붙는 편이 낫다', () => {
    expect(monitorRects(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 100, 1080)])!)).toBeNull()
  })

  it('변이 8192 를 넘으면 null', () => {
    expect(monitorRects(planSpanAll([d(1, 0, 0, 5000, 1080, 2)])!)).toBeNull()
  })

  it('한 장짜리도 정상 — 주 모니터 하나로 나간다', () => {
    expect(monitorRects(planSpanAll([d(1, 0, 0, 1920, 1080)])!)).toEqual([
      { left: 0, top: 0, right: 1919, bottom: 1079, primary: true }
    ])
  })

  it('★ 틈이 있으면 null — 이번 회귀를 이 함수가 못 잡았다(그래서 넣었다)', () => {
    const plan = planSpanAll(twoWide)!
    const gapped: SpanPlan = {
      ...plan,
      monitors: plan.monitors.map((m) => (m.primary ? m : { ...m, rdp: { ...m.rdp, left: m.rdp.left + 2 } }))
    }
    expect(monitorRects(gapped)).toBeNull()
  })

  it('★ 겹치면 null — 같은 픽셀을 두 모니터가 그린다', () => {
    const plan = planSpanAll(twoWide)!
    const overlapped: SpanPlan = {
      ...plan,
      monitors: plan.monitors.map((m) => (m.primary ? m : { ...m, rdp: { ...m.rdp, left: m.rdp.left - 2 } }))
    }
    expect(monitorRects(overlapped)).toBeNull()
  })

  it('★ 바운딩 박스가 desktop_size 와 다르면 null — 640 하한에 걸린 작은 화면이 그렇다', () => {
    // 320x240 한 장: 원격은 640x640 으로 올라가는데 사각형은 320x240 이라 서로 안 맞는다.
    // 경계를 안 보내고 큰 화면 한 장으로 붙는다(접속 실패보다 낫다).
    expect(monitorRects(planSpanAll([d(1, 0, 0, 320, 240)])!)).toBeNull()
  })

  it('★ 여러 배치에서 다섯 계약이 함께 선다', () => {
    const check = (plan: SpanPlan | null): void => {
      const ms = plan!.monitors
      const rects: MonitorRect[] = monitorRects(plan!)! // null 이면 여기서 터진다 = 규칙 위반
      expect(rects).toHaveLength(ms.length)
      expect(
        Math.max(...ms.map((m) => m.rdp.right)) - Math.min(...ms.map((m) => m.rdp.left)) + 1
      ).toBe(plan!.remote.width)
      for (const m of ms) {
        expect(m.slice.width).toBe(m.rdp.right - m.rdp.left + 1)
        expect(m.slice.height).toBe(m.rdp.bottom - m.rdp.top + 1)
      }
    }
    check(planSpanAll(twoWide))
    check(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)]))
    check(planSpanAll([d(1, 0, 0, 1365, 768), d(2, 1365, 0, 1366, 768)]))
    check(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 0, 1080, 1920, 1080)])) // 세로로 쌓인 배치
    check(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 0, 1280, 1024), d(3, 3200, 0, 1920, 1080)]))
  })
})

// ── 자식 창 자리 (2026-08-17 제보 ⑨) ──────────────────────────────────────────
//
// 여기 있던 버그: main 이 `window.open` 의 features 문자열에서 좌표를 정규식으로 뽑았는데,
// 템플릿 리터럴 안의 `\d` 가 `d` 로 죽어 **한 번도 매치되지 않았다**. 넷 다 undefined 가 되니
// 자식 창이 기본 크기로 주 모니터에 떠 부모 창 뒤에 가려졌다 — "두 번째 모니터에 아무것도
// 안 뜬다"로 보였고, 창은 사실 열려 있었다. 이제 좌표를 계획에서 직접 꺼낸다.
import { MIRROR_FRAME_PREFIX } from '../src/shared/rdpSpan'

describe('다른 모니터 창 자리', () => {
  it('프레임 이름의 모니터 id 로 그 모니터의 창 자리를 찾는다', () => {
    const plan = planSpanAll(twoWide)!
    expect(monitorByFrame(plan, MIRROR_FRAME_PREFIX + '2')?.window).toEqual({
      x: 1920,
      y: 0,
      width: 1920,
      height: 1080
    })
  })

  it('★ 두 모니터가 서로 다른 자리를 받는다 — 같으면 한 장이 다른 장을 덮는다', () => {
    const plan = planSpanAll(twoWide)!
    const a = monitorByFrame(plan, MIRROR_FRAME_PREFIX + '1')!
    const b = monitorByFrame(plan, MIRROR_FRAME_PREFIX + '2')!
    expect(a.window.x).not.toBe(b.window.x)
  })

  it('★ 내용 영역도 함께 꺼낸다 — 창을 띄운 뒤 이 값으로 다시 맞춘다(테두리 실측 오차 흡수)', () => {
    const plan = planSpanAll(twoWide, CHROME)!
    expect(monitorByFrame(plan, MIRROR_FRAME_PREFIX + '2')?.content).toEqual({
      x: 1928,
      y: 31,
      width: 1904,
      height: 1041
    })
  })

  it('왼쪽에 붙은 모니터의 음수 좌표도 그대로 나온다', () => {
    const plan = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)])!
    expect(monitorByFrame(plan, MIRROR_FRAME_PREFIX + '2')?.window.x).toBe(-1920)
  })

  it('★ 우리 이름이 아니면 null — 원격 화면 창에서 임의 창이 열리는 길을 남기지 않는다', () => {
    const plan = planSpanAll(twoWide)!
    expect(monitorByFrame(plan, 'evil-popup')).toBeNull()
    expect(monitorByFrame(plan, '')).toBeNull()
  })

  it('★ 계획에 없는 모니터 id 면 null', () => {
    const plan = planSpanAll(twoWide)!
    expect(monitorByFrame(plan, MIRROR_FRAME_PREFIX + '99')).toBeNull()
    expect(monitorByFrame(plan, MIRROR_FRAME_PREFIX + 'abc')).toBeNull()
  })
})
