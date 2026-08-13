// 다중 모니터 RDP — 어느 모니터들을 하나의 원격 데스크톱으로 펼칠지 계산한다.
//
// 왜 이 계산이 전부인가: RDP 의 다중 모니터는 화면을 여러 개 보내는 게 아니다. 서버는 **모니터
// 전체를 감싸는 사각형 하나**를 프레임버퍼로 그리고, 모니터 경계는 "여기가 경계다"라는 메타데이터로만
// 따로 알린다(MS-RDPBCGR 의 TS_UD_CS_MONITOR). 그래서 경계 메타데이터 없이도 **펼치기 자체는 된다** —
// 서버가 그 큰 사각형을 모니터 하나로 볼 뿐이다(mstsc 의 옛 `span monitors:i:1` 과 같은 모습).
//
// 지금 우리가 있는 자리가 딱 그렇다. 공식 wasm(@devolutions/iron-remote-desktop-rdp) 안에는 경계
// PDU 코드가 **이미 컴파일돼 있는데**(ironrdp-pdu 의 gcc/monitor_data.rs·monitor_extended_data.rs,
// ironrdp-displaycontrol 의 DisplayControlMonitorLayout) JS 로 나오는 구멍이 없다. 확장 디스패치가
// 받는 ident 는 이게 전부다(wasm 바이너리에서 확인):
//   pcb · kdc_proxy_url · display_control · enable_credssp · outbound_message_size_limit ·
//   files_available_callback · file_contents_request_callback · file_contents_response_callback ·
//   lock_callback · unlock_callback · locks_expired_callback · print_job_stream_callback
// monitor 계열이 없다 → 경계를 넣을 방법이 없다. 넣으려면 wasm 을 포크해 바인딩을 추가해야 한다.
//
// **경계를 모르면 무엇이 달라지나**: 원격에서 창을 최대화하면 전체를 덮고, 작업표시줄이 전체 폭으로
// 늘어나고, 창 스냅이 모니터 경계를 무시한다. 화면이 펼쳐지는 것 자체는 똑같다.

/** Electron `screen.getAllDisplays()` 에서 우리가 쓰는 부분만. */
export type SpanDisplay = {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  /** DIP → 물리 픽셀 배율. 원격 해상도는 물리 픽셀로 잡아야 흐려지지 않는다. */
  scaleFactor: number
}

/**
 * 모니터 한 장. 좌표계가 **둘**이라 각각 따로 담는다 — 섞으면 화면이 어긋난다.
 *
 * · `rdp` = 원격에 알릴 사각형. **주 모니터가 원점(0,0)** 이고 왼쪽/위에 있는 모니터는 음수다.
 *   right/bottom 은 포함 좌표다([MS-RDPBCGR] 2.2.1.3.6 규칙).
 * · `slice` = 프레임버퍼에서 잘라 올 자리. **감싸는 사각형의 좌상단이 원점**이라 항상 0 이상이다.
 * · `window` = 그 모니터를 덮을 창 자리(DIP — Electron 창 좌표계).
 */
export type SpanMonitor = {
  id: number
  primary: boolean
  rdp: { left: number; top: number; right: number; bottom: number }
  slice: { x: number; y: number; width: number; height: number }
  window: { x: number; y: number; width: number; height: number }
}

export type SpanPlan = {
  /** 창을 놓을 자리(DIP — Electron 의 창 좌표계). 모니터 전체를 감싸는 사각형. */
  bounds: { x: number; y: number; width: number; height: number }
  /** 원격에 요청할 데스크톱 크기(물리 픽셀, 4의 배수). */
  remote: { width: number; height: number }
  /** 고른 모니터 수. */
  count: number
  /** 모니터별 좌표(원격에 알릴 사각형 · 프레임버퍼 잘라올 자리 · 창 자리). */
  monitors: SpanMonitor[]
  /**
   * 감싸는 사각형에서 어떤 모니터도 덮지 않는 넓이의 비율(0~1).
   * 모니터가 어긋나게 배치돼 있으면 그 구멍은 원격 바탕화면이 보이지만 아무 데도 안 뜨는 죽은 영역이 된다.
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
 * 고른 모니터들을 하나의 원격 데스크톱으로 펼치는 계획. 고른 것이 없으면 null.
 *
 * 배율이 섞인 경우: 창은 여러 모니터에 걸치지만 Windows 는 창 하나에 배율 하나만 준다. 그래서
 * **가장 큰 배율**로 물리 픽셀을 잡는다 — 높은 배율 쪽을 선명하게 두고 낮은 쪽이 축소되는 편이,
 * 반대로 해서 고밀도 모니터가 흐려지는 것보다 낫다.
 */
export function planSpan(displays: readonly SpanDisplay[], selectedIds: readonly number[]): SpanPlan | null {
  const picked = displays.filter((d) => selectedIds.includes(d.id))
  if (picked.length === 0) return null

  const x = Math.min(...picked.map((d) => d.bounds.x))
  const y = Math.min(...picked.map((d) => d.bounds.y))
  const right = Math.max(...picked.map((d) => d.bounds.x + d.bounds.width))
  const bottom = Math.max(...picked.map((d) => d.bounds.y + d.bounds.height))
  const width = right - x
  const height = bottom - y

  const scale = Math.max(...picked.map((d) => d.scaleFactor || 1))
  const covered = picked.reduce((s, d) => s + d.bounds.width * d.bounds.height, 0)
  const boxArea = width * height

  // 주 모니터 = OS 좌표 원점에 있는 것. Windows 는 주 모니터의 좌상단을 (0,0) 으로 잡으므로 보통
  // 그대로 걸린다. 못 찾으면(왼쪽 모니터만 골랐다면) 고른 것 중 가장 왼쪽·위를 주로 삼는다 —
  // RDP 는 주 모니터가 반드시 원점이어야 해서 하나는 정해야 한다.
  const origin =
    picked.find((d) => d.bounds.x === 0 && d.bounds.y === 0) ??
    [...picked].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)[0]

  const px = (n: number): number => Math.round(n * scale)
  const monitors: SpanMonitor[] = picked.map((d) => {
    const w = px(d.bounds.width)
    const h = px(d.bounds.height)
    return {
      id: d.id,
      primary: d.id === origin.id,
      rdp: {
        left: px(d.bounds.x - origin.bounds.x),
        top: px(d.bounds.y - origin.bounds.y),
        // right/bottom 은 **포함** 좌표다 — 폭이 아니라 마지막 픽셀 번호라 1을 뺀다.
        right: px(d.bounds.x - origin.bounds.x) + w - 1,
        bottom: px(d.bounds.y - origin.bounds.y) + h - 1
      },
      slice: { x: px(d.bounds.x - x), y: px(d.bounds.y - y), width: w, height: h },
      window: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
    }
  })

  return {
    bounds: { x, y, width, height },
    remote: { width: round4(width * scale), height: round4(height * scale) },
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
 * 16장 초과 · 200 미만 또는 8192 초과 변 · 주 모니터가 원점이 아님. 하나라도 걸리면 null 을 돌려
 * 호출측이 **단일 모니터로 붙게** 한다(펼치기는 되고 경계만 없는 상태 — 접속 실패보다 낫다).
 */
export function monitorLayoutArgs(plan: SpanPlan): number[] | null {
  const MAX = 16
  const MIN_EDGE = 200
  const MAX_EDGE = 8192
  if (plan.monitors.length === 0 || plan.monitors.length > MAX) return null
  if (plan.monitors.filter((m) => m.primary).length !== 1) return null

  const flat: number[] = []
  for (const m of plan.monitors) {
    const w = m.rdp.right - m.rdp.left + 1
    const h = m.rdp.bottom - m.rdp.top + 1
    if (w < MIN_EDGE || w > MAX_EDGE || h < MIN_EDGE || h > MAX_EDGE) return null
    if (m.primary && (m.rdp.left !== 0 || m.rdp.top !== 0)) return null
    flat.push(m.rdp.left, m.rdp.top, m.rdp.right, m.rdp.bottom, m.primary ? 1 : 0)
  }
  return flat
}

/** 모니터 전체를 펼치는 계획(버튼 하나로 쓰는 기본 경로). */
export function planSpanAll(displays: readonly SpanDisplay[]): SpanPlan | null {
  return planSpan(
    displays,
    displays.map((d) => d.id)
  )
}
