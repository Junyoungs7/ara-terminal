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
//
// ── 2026-09-04 회귀: 원격 사각형을 물리 좌표에서 빼면 안 된다 ─────────────────────────────
// 처음엔 `canvas` 의 **물리 화면 좌표**를 그대로 원격에 알렸다. 테두리 폭을 좌우에서 빼는 순간
// 이웃한 두 모니터 사이에 **2px 틈**이 생겼고(준영님 배치 실측: 모니터2 right=-3, 모니터1 left=0),
// RDP 는 모니터가 맞닿아야 해서 서버가 배치를 통째로 버리고 desktop_size 한 장으로 처리했다 —
// 듀얼이던 화면이 "펼쳐진 한 화면"이 됐다.
//
// **원격 배치는 내 화면과 픽셀로 같을 필요가 없다.** 서버가 알아야 하는 것은 "몇 장이고, 각각 몇
// 픽셀이며, 어떻게 이웃하는가" 뿐이다. 그래서 이제 **크기는 창 내용에서, 자리는 맞붙여** 깐다:
// 물리 배치가 순서와 축만 정하고, 사각형은 틈 0·겹침 0 으로 이어 붙인다. 세로 어긋남(4px 같은 것)도
// 따라가지 않는다 — 따라가 봐야 아무 모니터에도 안 보이는 띠만 생긴다.

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
    // 머리줄은 주 모니터 창에만 있다 — 거기 원격 화면만 그만큼 짧다.
    const head = d.id === origin.id ? chrome.header : 0
    return { d, window: win, content, canvas: { width: content.width, height: Math.max(0, content.height - head) } }
  })

  // 배치 축과 순서는 **물리 좌표**가 정한다(왼쪽 모니터가 원격에서도 왼쪽이어야 한다).
  // ponytail: 격자(2x2) 배치는 한 줄로 편다 — 화면마다 제 몫은 그대로 보이고 이웃 관계만 어긋난다.
  //           실사용에 없는 배치라 2차원 채우기를 짜지 않았다. 나오면 그때 붙인다.
  const spread = (v: number[]): number => Math.max(...v) - Math.min(...v)
  const horizontal = spread(picked.map((d) => d.bounds.x)) >= spread(picked.map((d) => d.bounds.y))
  const ordered = [...boxes].sort((a, b) =>
    horizontal ? a.d.bounds.x - b.d.bounds.x : a.d.bounds.y - b.d.bounds.y
  )

  // 크기대로 **맞붙여** 깐다. 틈이 하나라도 있으면 서버가 배치를 버리고 큰 화면 한 장으로 처리한다.
  let cursor = 0
  const laid = ordered.map((b) => {
    const width = px(b.canvas.width)
    const height = px(b.canvas.height)
    const rect = horizontal ? { left: cursor, top: 0, width, height } : { left: 0, top: cursor, width, height }
    cursor += horizontal ? width : height
    return { b, rect }
  })

  // 주 모니터가 원점(RDP 규칙). 왼쪽·위의 모니터는 이제 음수가 된다.
  const originRect = laid.find((x) => x.b.d.id === origin.id)!.rect
  for (const x of laid) {
    x.rect.left -= originRect.left
    x.rect.top -= originRect.top
  }

  // 프레임버퍼 = 사각형들을 감싸는 상자. 그 좌상단이 잘라오기 좌표의 (0,0) 이다.
  const minLeft = Math.min(...laid.map((x) => x.rect.left))
  const minTop = Math.min(...laid.map((x) => x.rect.top))
  const remote = {
    width: round4(Math.max(...laid.map((x) => x.rect.left + x.rect.width)) - minLeft),
    height: round4(Math.max(...laid.map((x) => x.rect.top + x.rect.height)) - minTop)
  }

  const monitors: SpanMonitor[] = laid.map(({ b, rect }) => {
    // 4의 배수로 내리며 깎인 ≤3px 은 바깥쪽 사각형에서 잘라 낸다 — 감싸는 상자 == desktop_size.
    // 안쪽 변은 안 건드리므로 맞닿음은 그대로다.
    const width = Math.max(0, Math.min(rect.width, minLeft + remote.width - rect.left))
    const height = Math.max(0, Math.min(rect.height, minTop + remote.height - rect.top))
    return {
      id: b.d.id,
      primary: b.d.id === origin.id,
      // right/bottom 은 **포함** 좌표다 — 폭이 아니라 마지막 픽셀 번호라 1을 뺀다.
      rdp: { left: rect.left, top: rect.top, right: rect.left + width - 1, bottom: rect.top + height - 1 },
      // 잘라오기 좌표 = 같은 사각형을 프레임버퍼 원점으로 옮긴 것. 크기가 어긋나면 마우스가 딴 데를 찍는다.
      slice: { x: rect.left - minLeft, y: rect.top - minTop, width, height },
      window: b.window,
      content: b.content
    }
  })

  const boxArea = remote.width * remote.height
  const covered = monitors.reduce((s, m) => s + m.slice.width * m.slice.height, 0)

  return {
    remote,
    count: picked.length,
    monitors,
    deadRatio: boxArea > 0 ? Math.max(0, (boxArea - covered) / boxArea) : 0
  }
}

/** 원격에 알릴 모니터 사각형 하나. right/bottom 은 포함 좌표다(포크 wasm 의 `monitorLayout()` 모양). */
export type MonitorRect = { left: number; top: number; right: number; bottom: number; primary?: boolean }

/**
 * 원격에 알릴 모니터 배치. **하나라도 규칙을 어기면 null** 을 돌려 호출측이 경계 없이 붙게 한다
 * (펼치기는 되고 경계만 없는 상태 — 접속 실패나 조용한 오배치보다 낫다).
 *
 * 서버가 거절할 층위를 여기서 먼저 거른다(거절당해도 사유를 안 주고 배치만 조용히 버린다):
 * 16장 초과 · 200 미만 또는 8192 초과 변 · 주 모니터가 원점이 아님 · 감싸는 상자가 desktop_size 와
 * 다름 · **틈이나 겹침**.
 *
 * 마지막 항목이 2026-09-04 회귀의 정체다: 사각형 사이에 2px 틈이 생기자 서버가 배치를 버리고
 * 큰 화면 한 장으로 처리해 듀얼이 "펼쳐진 한 화면"이 됐다. 지금은 planSpan 이 맞붙여 깔아 그럴 수
 * 없지만, 그 계산을 고치는 사람이 다시 벌릴 수 있어 여기서 못 박는다.
 * ponytail: "모두가 이웃을 하나 이상 가진다"까지만 본다 — 완전한 연결성 검사가 아니다(한 줄로
 *           까는 한 그것으로 충분하고, 2차원 배치를 짜게 되면 그때 이 검사도 올려야 한다).
 */
export function monitorRects(plan: SpanPlan): MonitorRect[] | null {
  const MAX = 16
  const MIN_RECT = 200
  const MAX_RECT = 8192
  const ms = plan.monitors
  if (ms.length === 0 || ms.length > MAX) return null
  if (ms.filter((m) => m.primary).length !== 1) return null

  for (const m of ms) {
    const w = m.rdp.right - m.rdp.left + 1
    const h = m.rdp.bottom - m.rdp.top + 1
    if (w < MIN_RECT || w > MAX_RECT || h < MIN_RECT || h > MAX_RECT) return null
    if (m.primary && (m.rdp.left !== 0 || m.rdp.top !== 0)) return null
  }

  // vendor/ara-multimonitor.patch: "desktop_size must equal the bounding box of these rectangles."
  const left = Math.min(...ms.map((m) => m.rdp.left))
  const top = Math.min(...ms.map((m) => m.rdp.top))
  const right = Math.max(...ms.map((m) => m.rdp.right))
  const bottom = Math.max(...ms.map((m) => m.rdp.bottom))
  if (right - left + 1 !== plan.remote.width || bottom - top + 1 !== plan.remote.height) return null

  // 겹치지 않고, 저마다 이웃이 있다(변이 딱 맞닿는다).
  const rects = ms.map((m) => m.rdp)
  const overlaps = (a: MonitorRect, b: MonitorRect): boolean =>
    a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
  const touches = (a: MonitorRect, b: MonitorRect): boolean =>
    ((a.right + 1 === b.left || b.right + 1 === a.left) && a.top <= b.bottom && b.top <= a.bottom) ||
    ((a.bottom + 1 === b.top || b.bottom + 1 === a.top) && a.left <= b.right && b.left <= a.right)
  for (const a of rects) {
    let neighbour = false
    for (const b of rects) {
      if (a === b) continue
      if (overlaps(a, b)) return null
      if (touches(a, b)) neighbour = true
    }
    if (rects.length > 1 && !neighbour) return null
  }

  return ms.map((m) => ({ ...m.rdp, primary: m.primary }))
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
