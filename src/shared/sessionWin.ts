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

/**
 * 닫기 확인(`win:closeAsk` → `win:closeConfirm`)에서 **본창을 가리키는 winId**.
 *
 * 왜 빈 문자열인가: 이 파일이 이미 "win= 이 비면 본창"으로 읽고 있고(위 parseSessionWinHash),
 * 떼어낸 창의 id 는 `newWinId()` 가 만드는 `w<base36>` 라 **절대 빌 수 없다** — 겹칠 길이 없다.
 * 덤으로 falsy 라 `if (winId)` 로 갈리는 기존 코드가 저절로 본창 쪽으로 떨어진다.
 * 채널을 새로 파지 않고 창 식별만 이 값으로 가른다(본창도 떼어낸 창과 같은 길을 탄다).
 */
export const MAIN_WIN_ID = ''

/**
 * 본창을 닫으려 할 때 **물어볼 것인가**(2026-09-05 준영님: "아라 끌때 세션이 떠있으면
 * 종료할꺼냐고 물어보고 확인 누르면 닫자").
 *
 * 🔴 순수 함수로 떼어낸 이유: 이 판단이 `true` 로 잘못 나오면 **아라가 영영 안 닫힌다.**
 * 창을 띄우지 않고 검사할 수 있어야 그 사고를 회귀로 잡는다(tests/sessionWin.test.ts).
 *
 * 기본값은 **묻지 않는다**이다 — 셋 중 하나라도 어긋나면 막지 말고 닫는다.
 * 안 물어보는 실패는 불편이지만, 안 닫히는 실패는 사고다.
 */
export function shouldAskBeforeQuit(o: {
  /** 본창이 쥔 세션 수. 0이면 안 묻는다 — 빈 창 닫는 데 확인은 방해다(askClose 와 같은 규칙). */
  sessionCount: number
  /**
   * 🔴 종료가 이미 진행 중이다(`before-quit` 이 지나갔다 · 자동 업데이트 재시작 포함).
   * 여기서 막으면 **교착**이다: app.quit() → before-quit → 각 창 close 순서라, 그 close 를
   * 또 막으면 확인 → app.quit() → 또 막힘이 된다. 확인을 이미 받은 경우도 이 플래그로 덮인다.
   */
  quitting: boolean
  /** 렌더러가 답할 수 있는 상태인가. 답할 사람이 없는데 막으면 못 닫는 창이 된다. */
  rendererAlive: boolean
}): boolean {
  return !o.quitting && o.rendererAlive && o.sessionCount > 0
}
