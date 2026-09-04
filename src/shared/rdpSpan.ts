// 다중 모니터 RDP — 어느 모니터들을 하나의 원격 데스크톱으로 펼칠지 계산한다.
//
// 왜 이 계산이 전부인가: RDP 의 다중 모니터는 화면을 여러 개 보내는 게 아니다. 서버는 **모니터
// 전체를 감싸는 사각형 하나**를 프레임버퍼로 그리고, 모니터 경계는 "여기가 경계다"라는 메타데이터로만
// 따로 알린다(MS-RDPBCGR 의 TS_UD_CS_MONITOR). 그래서 경계 메타데이터 없이도 **펼치기 자체는 된다** —
// 서버가 그 큰 사각형을 모니터 하나로 볼 뿐이다(mstsc 의 옛 `span monitors:i:1` 과 같은 모습).
//
// 경계는 포크한 wasm 이 받는다(vendor/ara-multimonitor.patch — `monitorLayout()`). 업스트림
// 패키지에는 그 바인딩이 없어 RdpView 가 함수 유무를 보고 건너뛴다.
//
// **경계를 모르면 무엇이 달라지나**: 원격에서 창을 최대화하면 전체를 덮고, 작업표시줄이 전체 폭으로
// 늘어나고, 창 스냅이 모니터 경계를 무시한다. 화면이 펼쳐지는 것 자체는 똑같다.
//
// ── 2026-09-04: "창이 있는 전체화면"으로 바뀌면서 자리 계산이 통째로 달라졌다 ──────────────
// 전에는 테두리 없는 창이 **모니터 전체**(작업표시줄까지)를 덮었으므로 모니터 크기 = 원격 화면
// 크기였다. 이제 창에 제목 표시줄과 테두리가 있고 작업표시줄도 안 덮는다 — 원격 화면이 들어갈
// 자리가 모니터보다 작다. 그 차이를 안 빼면 화면이 잘리거나 스크롤이 생긴다. 그래서 좌표가 셋이다:
//   · `window`  = 창 바깥 자리   = 작업 영역(OS 가 모니터마다 알려 준다)
//   · `content` = 창 내용 자리   = window − 제목 표시줄·테두리(**실측** — SpanChrome)
//   · `canvas`  = 원격 화면 자리 = content − [옵션] 머리줄(주 모니터 창에만 있다)
// 프레임버퍼(=원격 해상도)는 **canvas 들을 감싸는 상자**다. 이것이 desktop_size 와 같아야 한다.

type Rect = { x: number; y: number; width: number; height: number }

/** Electron `screen.getAllDisplays()` 에서 우리가 쓰는 부분만. */
export type SpanDisplay = {
  id: number
  bounds: Rect
  /**
   * 작업 영역 — 작업표시줄을 뺀 자리(Electron `display.workArea`). 창은 여기까지만 덮는다.
   * OS 가 **모니터마다 따로** 알려 주므로 작업표시줄이 어느 모니터 어느 변에 붙어 있든 그대로 맞는다
   * (여기만은 우리가 재거나 짐작하지 않는다).
   */
  workArea: Rect
  /** DIP → 물리 픽셀 배율. 원격 해상도는 물리 픽셀로 잡아야 흐려지지 않는다. */
  scaleFactor: number
}

/**
 * 창 껍데기가 먹는 자리(DIP). **재는 값이다 — 짐작하지 않는다.**
 *
 * · `frame` = 제목 표시줄·테두리. main 이 호스트 창을 만든 뒤 `getBounds()` 와 `getContentBounds()`
 *   의 차이로 잰다(rdp/RdpWindows.ts). 잰 곳은 주 모니터 한 곳이고 그 값을 모든 모니터에 쓴다 —
 *   Windows 는 배율에 맞춰 제목 표시줄의 **물리** 픽셀을 키우므로 DIP 로는 모니터가 달라도 같다.
 *   그 가정이 틀려도 화면이 잘리지는 않는다: 창을 띄운 뒤 `setContentBounds(content)` 로 **내용
 *   영역을 계획값에 맞춰** 다시 잡기 때문이다(어긋난 만큼 창 바깥이 작업 영역을 조금 넘거나 모자랄 뿐).
 * · `header` = 주 모니터 창 맨 위 [옵션] 줄. 나머지 모니터 창에는 없다.
 */
export type SpanChrome = {
  frame: { left: number; top: number; right: number; bottom: number }
  header: number
}

/** 아직 재기 전(주 모니터를 고를 때)과 단위 검사의 기본값. */
export const NO_CHROME: SpanChrome = { frame: { left: 0, top: 0, right: 0, bottom: 0 }, header: 0 }

/**
 * 다중 모니터 창 [옵션] 머리줄의 높이(DIP·px).
 *
 * ⚠️ `styles/shell.css` 의 `.rdp-span .rdp-hd { height }` 와 **같은 수여야 한다.** 여기가 크면
 * 원격 화면 아래가 검게 남고, 저기가 크면 아래가 잘린다. 그래서 그 줄만은 `--row-tabbar`(UI 배율을
 * 탄다)를 안 쓰고 고정 px 로 둔다 — 배율을 바꾼 사람의 창에서 화면이 어긋나면 안 된다.
 */
export const SPAN_HEADER_H = 32

/**
 * 모니터 한 장. 좌표계가 **여럿**이라 각각 따로 담는다 — 섞으면 화면이 어긋난다.
 *
 * · `window`  = 그 모니터를 덮을 창 바깥 자리(DIP — Electron 창 좌표계) = 작업 영역.
 * · `content` = 그 창의 내용 영역(DIP). `setContentBounds` 에 그대로 넣는다.
 * · `rdp`   = 원격에 알릴 사각형. **주 모니터가 원점(0,0)** 이고 왼쪽/위에 있는 모니터는 음수다.
 *   right/bottom 은 포함 좌표다([MS-RDPBCGR] 2.2.1.3.6 규칙).
 * · `slice` = 프레임버퍼에서 잘라 올 자리. **감싸는 사각형의 좌상단이 원점**이라 항상 0 이상이다.
 */
export type SpanMonitor = {
  id: number
  primary: boolean
  rdp: { left: number; top: number; right: number; bottom: number }
  slice: Rect
  window: Rect
  content: Rect
}

export type SpanPlan = {
  /** 원격에 요청할 데스크톱 크기(물리 픽셀, 4의 배수). = slice 들을 감싸는 상자. */
  remote: { width: number; height: number }
  /** 고른 모니터 수. */
  count: number
  /** 모니터별 좌표(원격에 알릴 사각형 · 프레임버퍼 잘라올 자리 · 창 자리 · 내용 자리). */
  monitors: SpanMonitor[]
  /**
   * 모니터들의 **내용 영역**을 감싸는 상자에서 어떤 모니터도 덮지 않는 넓이의 비율(0~1).
   * 모니터가 어긋나게 배치돼 있으면 그 구멍은 원격 바탕화면이 보이지만 아무 데도 안 뜨는 죽은 영역이 된다.
   *
   * [옵션] 머리줄이 먹는 띠는 여기서 **뺀다** — 그건 어긋남이 아니라 우리가 일부러 내준 자리이고,
   * 안 빼면 흔한 2대 배치에서도 경고가 떠 "모니터를 맞추라"는 엉뚱한 안내가 나간다(실측 2.2%).
   */
  deadRatio: number
}

// RDP 폭·높이는 4의 배수가 안전하다(일부 서버가 어중간한 값에서 화면을 깨뜨린다).
// rdpInput.ts 의 round4 와 같은 규칙이지만 여기서 다시 정의한다 — 이 파일은 main 도 쓰므로
// 렌더러 전용 모듈(DOM 을 만지는 canvasPoint 등이 같이 있다)에 의존하면 안 된다.
const MIN_EDGE = 640
function round4(n: number): number {
  return Math.max(MIN_EDGE, Math.floor(n / 4) * 4)
}

/**
 * 주 모니터 = OS 좌표 원점에 있는 것. Windows 는 주 모니터의 좌상단을 (0,0) 으로 잡으므로 보통
 * 그대로 걸린다. 못 찾으면(왼쪽 모니터만 골랐다면) 고른 것 중 가장 왼쪽·위를 주로 삼는다 —
 * RDP 는 주 모니터가 반드시 원점이어야 해서 하나는 정해야 한다.
 *
 * 계획을 세우기 **전에** 호스트 창을 어느 모니터에 띄울지 알아야 해서 따로 뺐다(테두리를 재려면
 * 창이 먼저 있어야 하고, 창을 놓으려면 모니터를 먼저 골라야 한다).
 */
export function spanOrigin(displays: readonly SpanDisplay[], selectedIds: readonly number[]): SpanDisplay | null {
  const picked = displays.filter((d) => selectedIds.includes(d.id))
  if (picked.length === 0) return null
  return (
    picked.find((d) => d.bounds.x === 0 && d.bounds.y === 0) ??
    [...picked].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)[0]
  )
}

/**
 * 고른 모니터들을 하나의 원격 데스크톱으로 펼치는 계획. 고른 것이 없으면 null.
 *
 * 배율이 섞인 경우: 창은 모니터마다 하나씩이지만 프레임버퍼는 **하나**다. 그래서 **가장 큰 배율**로
 * 물리 픽셀을 잡는다 — 높은 배율 쪽을 선명하게 두고 낮은 쪽이 축소되는 편이, 반대로 해서 고밀도
 * 모니터가 흐려지는 것보다 낫다.
 */
export function planSpan(
  displays: readonly SpanDisplay[],
  selectedIds: readonly number[],
  chrome: SpanChrome = NO_CHROME
): SpanPlan | null {
  const origin = spanOrigin(displays, selectedIds)
  if (!origin) return null
  const picked = displays.filter((d) => selectedIds.includes(d.id))

  const scale = Math.max(...picked.map((d) => d.scaleFactor || 1))
  const px = (n: number): number => Math.round(n * scale)

  const boxes = picked.map((d) => {
    const win = d.workArea
    const content = {
      x: win.x + chrome.frame.left,
      y: win.y + chrome.frame.top,
      width: Math.max(0, win.width - chrome.frame.left - chrome.frame.right),
      height: Math.max(0, win.height - chrome.frame.top - chrome.frame.bottom)
    }
    // 머리줄은 주 모니터 창에만 있다 — 거기서만 원격 화면이 그만큼 아래에서 시작한다.
    const head = d.id === origin.id ? chrome.header : 0
    const canvas = {
      x: content.x,
      y: content.y + head,
      width: content.width,
      height: Math.max(0, content.height - head)
    }
    return { d, window: win, content, canvas }
  })

  // 프레임버퍼 = 캔버스 사각형들을 감싸는 상자. 그 좌상단이 원격 화면의 (0,0) 이다.
  const fx = Math.min(...boxes.map((b) => b.canvas.x))
  const fy = Math.min(...boxes.map((b) => b.canvas.y))
  const fw = Math.max(...boxes.map((b) => b.canvas.x + b.canvas.width)) - fx
  const fh = Math.max(...boxes.map((b) => b.canvas.y + b.canvas.height)) - fy
  const remote = { width: round4(px(fw)), height: round4(px(fh)) }

  // 슬라이스는 **누적 반올림이 아니라 구간 차**로 잰다 — 각각 반올림하면 마지막 모니터가 상자 밖으로
  // 1px 삐져나간다. 4의 배수로 내리며 깎인 ≤3px 은 여기서 잘라, 감싸는 상자 = desktop_size 를 지킨다.
  const sliceOf = (canvas: Rect): Rect => {
    const x = px(canvas.x - fx)
    const y = px(canvas.y - fy)
    return {
      x,
      y,
      width: Math.max(0, Math.min(px(canvas.x - fx + canvas.width) - x, remote.width - x)),
      height: Math.max(0, Math.min(px(canvas.y - fy + canvas.height) - y, remote.height - y))
    }
  }
  const originSlice = sliceOf(boxes.find((b) => b.d.id === origin.id)!.canvas)

  const monitors: SpanMonitor[] = boxes.map((b) => {
    const slice = sliceOf(b.canvas)
    // 원격 좌표 = 슬라이스를 주 모니터 원점으로 옮긴 것. 두 좌표계를 따로 계산하면 언젠가 어긋난다.
    const left = slice.x - originSlice.x
    const top = slice.y - originSlice.y
    return {
      id: b.d.id,
      primary: b.d.id === origin.id,
      // right/bottom 은 **포함** 좌표다 — 폭이 아니라 마지막 픽셀 번호라 1을 뺀다.
      rdp: { left, top, right: left + slice.width - 1, bottom: top + slice.height - 1 },
      slice,
      window: b.window,
      content: b.content
    }
  })

  // 죽은 영역은 **내용 영역**끼리 견준다(머리줄 제외 — 위 deadRatio 주석).
  const cx = Math.min(...boxes.map((b) => b.content.x))
  const cy = Math.min(...boxes.map((b) => b.content.y))
  const cw = Math.max(...boxes.map((b) => b.content.x + b.content.width)) - cx
  const ch = Math.max(...boxes.map((b) => b.content.y + b.content.height)) - cy
  const boxArea = cw * ch
  const covered = boxes.reduce((s, b) => s + b.content.width * b.content.height, 0)

  return {
    remote,
    count: picked.length,
    monitors,
    deadRatio: boxArea > 0 ? Math.max(0, (boxArea - covered) / boxArea) : 0
  }
}

/**
 * 원격에 보낼 평평한 배열 — 모니터당 [left, top, right, bottom, primary]. 공식 패키지의
 * `monitorLayout()` 이 받는 모양이다.
 *
 * 서버가 거절할 층위를 여기서 먼저 거른다(거절당하면 핸드셰이크 도중 조용히 끊길 뿐 사유를 안 준다):
 * 16장 초과 · 200 미만 또는 8192 초과 변 · 주 모니터가 원점이 아님 · 감싸는 상자가 desktop_size 와
 * 다름. 하나라도 걸리면 null 을 돌려 호출측이 **단일 모니터로 붙게** 한다(펼치기는 되고 경계만
 * 없는 상태 — 접속 실패보다 낫다).
 */
export function monitorLayoutArgs(plan: SpanPlan): number[] | null {
  const MAX = 16
  const MIN_RECT = 200
  const MAX_RECT = 8192
  if (plan.monitors.length === 0 || plan.monitors.length > MAX) return null
  if (plan.monitors.filter((m) => m.primary).length !== 1) return null

  const flat: number[] = []
  for (const m of plan.monitors) {
    const w = m.rdp.right - m.rdp.left + 1
    const h = m.rdp.bottom - m.rdp.top + 1
    if (w < MIN_RECT || w > MAX_RECT || h < MIN_RECT || h > MAX_RECT) return null
    if (m.primary && (m.rdp.left !== 0 || m.rdp.top !== 0)) return null
    flat.push(m.rdp.left, m.rdp.top, m.rdp.right, m.rdp.bottom, m.primary ? 1 : 0)
  }

  // vendor/ara-multimonitor.patch: "desktop_size must equal the bounding box of these rectangles."
  // 어긋나면 서버가 사유 없이 끊는다 — 여기서 잡아 경계 없이 붙는 쪽으로 떨어뜨린다.
  const left = Math.min(...plan.monitors.map((m) => m.rdp.left))
  const top = Math.min(...plan.monitors.map((m) => m.rdp.top))
  const right = Math.max(...plan.monitors.map((m) => m.rdp.right))
  const bottom = Math.max(...plan.monitors.map((m) => m.rdp.bottom))
  if (right - left + 1 !== plan.remote.width || bottom - top + 1 !== plan.remote.height) return null

  return flat
}

/** 모니터 전체를 펼치는 계획(기본 경로 — 모니터 고르기 UI 는 없다). */
export function planSpanAll(displays: readonly SpanDisplay[], chrome: SpanChrome = NO_CHROME): SpanPlan | null {
  return planSpan(
    displays,
    displays.map((d) => d.id),
    chrome
  )
}

/**
 * "다른 모니터" 창의 `window.open` 이름. 렌더러가 붙이고(store/rdpMirror.ts) main 이 이 이름으로
 * 창을 알아본다(rdp/RdpWindows.ts) — **두 프로세스가 맞춰야 하는 문자열이라 여기 한 번만 적는다.**
 */
export const MIRROR_FRAME_PREFIX = 'ara-rdp-mon-'

/**
 * `window.open` 프레임 이름 → 그 모니터. 우리 이름이 아니거나 계획에 없는 모니터면 null
 * (= 창을 열지 않는다).
 *
 * 좌표를 **계획에서** 꺼내는 이유: 그 값을 만든 곳이 여기다. 렌더러가 features 문자열에 실어
 * 되돌려준 것을 다시 파싱하던 코드는 정규식이 죽어 있어 한 번도 동작하지 않았다(2026-08-17).
 * 순수 함수 — tests/rdpSpan.test.ts 가 검증한다.
 */
export function monitorByFrame(plan: SpanPlan, frameName: string): SpanMonitor | null {
  if (!frameName.startsWith(MIRROR_FRAME_PREFIX)) return null
  const id = Number(frameName.slice(MIRROR_FRAME_PREFIX.length))
  if (!Number.isFinite(id)) return null
  return plan.monitors.find((m) => m.id === id) ?? null
}
