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
  monitorLayoutArgs,
  planSpan,
  planSpanAll,
  spanOrigin,
  SPAN_HEADER_H,
  type SpanChrome,
  type SpanDisplay
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

  it('★ 어긋난 배치의 죽은 영역을 알려 준다 — 원격 바탕화면은 있는데 아무 데도 안 보이는 칸이다', () => {
    // 위아래로 어긋나게 붙인 두 장: 감싸는 사각형이 각 모니터 넓이의 합보다 크다.
    const p = planSpanAll([d(1, 0, 0, 1920, 1080), d(2, 1920, 540, 1920, 1080)])!
    expect(p.remote).toEqual({ width: 3840, height: 1620 })
    // 사각형 3840x1620 = 6,220,800 / 모니터 합 = 4,147,200 → 3분의 1이 죽는다.
    expect(p.deadRatio).toBeCloseTo(1 / 3, 3)
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
    const p = planSpan(
      [
        d(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 }),
        d(2, 1920, 0, 1920, 1080, 1, { x: 1920, y: 0, width: 1920, height: 1032 })
      ],
      [1, 2],
      CHROME
    )!
    const primary = p.monitors.find((m) => m.primary)!
    const other = p.monitors.find((m) => !m.primary)!
    expect(other.slice.height - primary.slice.height).toBe(SPAN_HEADER_H)
    // 주 모니터의 원격 화면은 머리줄만큼 아래에서 시작한다(그 띠는 어느 모니터에도 안 보인다).
    expect(primary.slice.y).toBe(SPAN_HEADER_H)
    expect(other.slice.y).toBe(0)
  })

  it('★ 머리줄이 만든 띠는 죽은 영역으로 세지 않는다 — 흔한 2대 배치가 경고를 띄우면 안 된다', () => {
    const p = planSpan(
      [
        d(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 }),
        d(2, 1920, 0, 1920, 1080, 1, { x: 1920, y: 0, width: 1920, height: 1032 })
      ],
      [1, 2],
      CHROME
    )!
    // 남는 것은 두 창 테두리 사이 16px 뿐이다(경고 문턱 2% 아래).
    expect(p.deadRatio).toBeLessThan(0.02)
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

  it('★ desktop_size 는 사각형들의 바운딩 박스와 같다 — 어긋나면 서버가 사유 없이 끊는다', () => {
    const check = (plan: ReturnType<typeof planSpanAll>): void => {
      const ms = plan!.monitors
      const w = Math.max(...ms.map((m) => m.rdp.right)) - Math.min(...ms.map((m) => m.rdp.left)) + 1
      const h = Math.max(...ms.map((m) => m.rdp.bottom)) - Math.min(...ms.map((m) => m.rdp.top)) + 1
      expect([w, h]).toEqual([plan!.remote.width, plan!.remote.height])
      expect(monitorLayoutArgs(plan!)).not.toBeNull()
    }
    check(planSpanAll(twoWide))
    check(planSpanAll([d(1, 0, 0, 1920, 1080), d(2, -1920, 0, 1920, 1080)]))
    check(planSpanAll([d(1, 0, 0, 1365, 768), d(2, 1365, 0, 1366, 768)]))
    check(
      planSpanAll(
        [
          d(1, 0, 0, 1920, 1080, 1, { x: 0, y: 0, width: 1920, height: 1032 }),
          d(2, 1920, 0, 1920, 1080, 1, { x: 1920, y: 0, width: 1920, height: 1032 })
        ],
        CHROME
      )
    )
  })

  it('★ 바운딩 박스가 desktop_size 와 다르면 null — 640 하한에 걸린 작은 화면이 그렇다', () => {
    // 320x240 한 장: 원격은 640x640 으로 올라가는데 사각형은 320x240 이라 서로 안 맞는다.
    // 경계를 안 보내고 큰 화면 한 장으로 붙는다(접속 실패보다 낫다).
    expect(monitorLayoutArgs(planSpanAll([d(1, 0, 0, 320, 240)])!)).toBeNull()
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
