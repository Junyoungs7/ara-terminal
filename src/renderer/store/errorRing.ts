// 렌더러 오류 링버퍼(#206). 이게 생기기 전엔 화면 쪽 결함이 **아무 기록도** 남기지 않았다(기획 §2).
// 창마다 하나(본창·떼어낸 창 각자 main.tsx 를 지난다). 마스킹은 보낼 때 main 이 건다.
import type { RendererError } from '@shared/bugReport'

export const RENDERER_ERRORS_MAX = 50
const STACK_MAX = 2000

const ring: RendererError[] = []

function push(message: string, stack: string): void {
  ring.push({ at: Date.now(), message, stack: stack.slice(0, STACK_MAX) })
  if (ring.length > RENDERER_ERRORS_MAX) ring.splice(0, ring.length - RENDERER_ERRORS_MAX)
}

/** 부팅 가장 이른 자리(main.tsx)에서 한 번. target 은 시험용(기본 window). */
export function installErrorRing(target: EventTarget = window): void {
  target.addEventListener('error', (e) => {
    const ev = e as ErrorEvent
    push(String(ev.message ?? ''), ev.error instanceof Error ? (ev.error.stack ?? '') : '')
  })
  target.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    push(r instanceof Error ? r.message : String(r), r instanceof Error ? (r.stack ?? '') : '')
  })
}

/** 지금까지 모인 것(오래된 것이 앞). 복사본이다. */
export function recentErrors(): RendererError[] {
  return ring.slice()
}
