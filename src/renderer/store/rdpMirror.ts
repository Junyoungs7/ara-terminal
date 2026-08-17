// 다중 모니터 창의 "다른 모니터" 창들 — 세션 하나의 화면을 모니터 수만큼 나눠 보여 준다.
//
// 왜 이렇게 되나: RDP 세션은 프레임버퍼가 **하나**다(모니터 경계는 메타데이터일 뿐 — shared/rdpSpan.ts).
// 그 하나를 여러 OS 창에 나눠 그려야 하는데, Electron 에서 창 하나는 렌더러 하나라 보통은 프로세스
// 경계를 넘겨야 한다. 실측해 보니 `window.open()` 으로 연 창은 **같은 프로세스·같은 오리진**이라
// 부모가 자식 문서의 캔버스에 `drawImage` 로 직접 그릴 수 있다(file:// 에서도 됐다). 그래서 매 프레임
// 픽셀을 IPC 로 나르지 않는다 — 같은 프로세스 안의 캔버스 간 복사다.
//
// 입력은 반대 방향이다: 자식 창에는 세션이 없으므로, 자식에서 누른 마우스·키를 **원격 좌표로
// 환산해서** 부모의 입력 통로(RdpInputBridge)로 넘긴다.

import { MIRROR_FRAME_PREFIX, type SpanMonitor } from '@shared/rdpSpan'
import type { RdpInputBridge } from '../components/RdpView'

/** 자식 창 캔버스의 로컬 좌표 → 원격 프레임버퍼 좌표. */
export function toRemotePoint(
  slice: SpanMonitor['slice'],
  localX: number,
  localY: number,
  viewW: number,
  viewH: number
): { x: number; y: number } {
  // 창이 슬라이스와 정확히 같은 크기가 아닐 수 있다(배율·창 테두리) — 비율로 환산한다.
  const sx = viewW > 0 ? slice.width / viewW : 1
  const sy = viewH > 0 ? slice.height / viewH : 1
  const x = slice.x + Math.round(localX * sx)
  const y = slice.y + Math.round(localY * sy)
  return {
    x: Math.min(Math.max(x, slice.x), slice.x + slice.width - 1),
    y: Math.min(Math.max(y, slice.y), slice.y + slice.height - 1)
  }
}

/** 마우스 버튼 번호(브라우저) → RDP 버튼. 지원하지 않는 버튼이면 null. */
export function mirrorButton(button: number): number | null {
  if (button === 0) return 0
  if (button === 1) return 2
  if (button === 2) return 1
  return null
}

const DOC = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:default}
  canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="m"></canvas></body></html>`

export type MirrorHandle = {
  monitorId: number
  win: Window
  stop: () => void
}

/**
 * 모니터 하나를 덮는 자식 창을 열고, 부모 캔버스의 해당 구역을 계속 복사한다.
 *
 * 창이 안 열리면(팝업 차단 등) null. 부모가 그 사실을 사용자에게 알려야 한다 — 조용히 넘어가면
 * "두 번째 모니터가 안 뜬다"로만 보인다.
 */
export function openMirror(
  source: HTMLCanvasElement,
  monitor: SpanMonitor,
  bridge: { current: RdpInputBridge | null }
): MirrorHandle | null {
  const { slice, window: box } = monitor
  // 크기·자리는 features 로도 보내지만 **main 이 실제로 쓰는 값은 계획 쪽**이다
  // (setWindowOpenHandler → monitorWindowBox). 여기 문자열은 브라우저 관례를 지키는 용도다.
  const win = window.open(
    '',
    `${MIRROR_FRAME_PREFIX}${monitor.id}`,
    `width=${box.width},height=${box.height},left=${box.x},top=${box.y}`
  )
  if (!win) return null

  win.document.open()
  win.document.write(DOC)
  win.document.close()

  const canvas = win.document.getElementById('m') as HTMLCanvasElement | null
  if (!canvas) {
    win.close()
    return null
  }
  canvas.width = slice.width
  canvas.height = slice.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    win.close()
    return null
  }

  let alive = true
  let raf = 0
  const draw = (): void => {
    if (!alive) return
    try {
      ctx.drawImage(source, slice.x, slice.y, slice.width, slice.height, 0, 0, slice.width, slice.height)
    } catch {
      // 세션이 끊겨 소스 캔버스가 정리되는 중 — 화면 한 장 때문에 루프를 죽이지 않는다.
    }
    raf = win.requestAnimationFrame(draw)
  }
  raf = win.requestAnimationFrame(draw)

  // 입력을 부모 세션으로 넘긴다. 좌표는 여기서 원격 좌표로 환산한다 — 부모는 어느 모니터인지 모른다.
  const point = (e: MouseEvent): { x: number; y: number } =>
    toRemotePoint(slice, e.clientX, e.clientY, canvas.clientWidth || slice.width, canvas.clientHeight || slice.height)

  const onMove = (e: MouseEvent): void => {
    const p = point(e)
    bridge.current?.mouse('move', p.x, p.y)
  }
  const onDown = (e: MouseEvent): void => {
    const b = mirrorButton(e.button)
    if (b === null) return
    e.preventDefault()
    const p = point(e)
    bridge.current?.mouse('down', p.x, p.y, b)
  }
  const onUp = (e: MouseEvent): void => {
    const b = mirrorButton(e.button)
    if (b === null) return
    e.preventDefault()
    const p = point(e)
    bridge.current?.mouse('up', p.x, p.y, b)
  }
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    bridge.current?.wheel(e.deltaY, e.deltaX, e.deltaMode === 0 ? 0 : e.deltaMode === 1 ? 1 : 2)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    e.preventDefault()
    bridge.current?.key(e.code, true)
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    e.preventDefault()
    bridge.current?.key(e.code, false)
  }
  const onCtx = (e: Event): void => e.preventDefault()

  canvas.addEventListener('mousemove', onMove)
  canvas.addEventListener('mousedown', onDown)
  canvas.addEventListener('mouseup', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onCtx)
  win.addEventListener('keydown', onKeyDown)
  win.addEventListener('keyup', onKeyUp)

  const stop = (): void => {
    if (!alive) return
    alive = false
    try {
      win.cancelAnimationFrame(raf)
    } catch {
      /* 창이 이미 닫혔다 */
    }
    try {
      if (!win.closed) win.close()
    } catch {
      /* 이미 닫힘 */
    }
  }
  // 사용자가 자식 창을 직접 닫으면 루프도 멈춘다(닫힌 창에 rAF 를 계속 걸면 예외가 샌다).
  win.addEventListener('beforeunload', () => {
    alive = false
  })

  return { monitorId: monitor.id, win, stop }
}
