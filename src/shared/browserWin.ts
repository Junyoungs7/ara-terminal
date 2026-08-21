// 내장 브라우저 탭 줄의 진입 해시. main 과 renderer 가 같은 문자열을 봐야 한다(portWin.ts 와 같은 이유).
//
// 이 해시로 뜨는 화면은 **탭 줄뿐**이다. 페이지 본문은 WebContentsView 로 그 아래 붙고,
// 그 view 에는 preload 가 없다 — 원격 페이지가 window.ev 를 못 보는 경계가 거기다.
export const BROWSER_WIN_HASH = '#browserwin'

export function isBrowserWinHash(hash: string): boolean {
  return hash === BROWSER_WIN_HASH
}

/** 렌더러가 그리는 탭 하나. 라벨은 **오리진만** — 페이지 제목은 위장 가능하므로 쓰지 않는다. */
export type BrowserTabView = { id: string; origin: string; url: string; loading: boolean }
