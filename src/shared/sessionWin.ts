// F32 세션 창의 해시 계약 — **창을 여는 쪽(main)과 읽는 쪽(renderer)이 맞춰야 하는 문자열**이라
// 한 곳에만 적는다(rdpSpan.ts 의 MIRROR_FRAME_PREFIX 와 같은 이유).
//
// 잘못 읽으면 조용히 망가진다: 접두사가 어긋나면 그 창에 **본창이 통째로 뜨고**(같은 세션을 두
// 창이 그린다 · 부트 복원이 두 번 돈다), winId 가 비면 소유자 없는 빈 창이 남는다.

export const SESSION_WIN_HASH = '#sessionwin?'

export type SessionWinTarget = { winId: string }

/** main 이 창을 열 때 붙일 해시. */
export function sessionWinHash(winId: string): string {
  return SESSION_WIN_HASH + 'win=' + encodeURIComponent(winId)
}

/** renderer 진입점이 읽는다. 우리 해시가 아니거나 winId 가 비면 null(= 보통 앱 창). */
export function parseSessionWinHash(hash: string): SessionWinTarget | null {
  if (!hash.startsWith(SESSION_WIN_HASH)) return null
  const winId = new URLSearchParams(hash.slice(SESSION_WIN_HASH.length)).get('win') ?? ''
  return winId ? { winId } : null
}
