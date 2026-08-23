// 탭을 **어디에 놓았는가** — 놓은 자리가 새 창을 만들지 정한다.
// (2026-08-22 제보 4·31 "탭 드래그로 새 창" → 2026-08-23 제보 5 "크롬처럼, 세션창 밖 아무 데나".)
//
// 크롬의 규칙을 그대로 쓴다: **탭 줄과 페이지(우리는 터미널 칸)만 받고, 나머지는 전부 새 창.**
// 좌측 사이드바·하단바·상태바·다른 앱 위·바탕화면 — 받는 자리가 아니면 창이 뜬다.
//
// ## 왜 dropEffect 로 판단하지 않는가 (2026-08-23 에 뒤집은 것)
//
// 처음에는 "아무도 안 받았다(dropEffect 'none') + 창 밖"으로 판정했다. 두 군데서 틀렸다:
//  · **다른 앱 위에 놓으면 그 앱이 받는다.** 크롬·메모장은 텍스트 드롭을 받아들이므로 dropEffect 가
//    'copy'/'move' 로 돌아온다 — 그래서 준영님 화면에서는 **바탕화면에서만** 창이 떴다.
//  · **우리 창 안의 사이드바·하단바**는 애초에 창 밖이 아니라 좌표 조건에서 걸렸다.
//
// 그래서 판정을 뒤집었다: **우리가 받았는가**만 본다(탭바·터미널 칸의 drop 핸들러가 표시를 남긴다).
// 우리가 안 받았으면 놓인 자리가 어디든 새 창이다. "다른 아라 창 위"인지는 렌더러가 알 수 없으므로
// (다른 창의 좌표는 그 창만 안다) main 이 마지막에 가른다 — registerSessionWindowIpc 의 win:detach.

/** 마지막으로 우리 UI 가 탭 드롭을 받아 처리한 시각(ms). 없으면 0. */
let handledAt = 0

/**
 * "이 드롭은 우리가 처리했다" — 탭바(재정렬·창 합치기)와 터미널 칸(분할·가져오기)이 부른다.
 * dragend 는 drop 직후에 오므로 시각 하나로 충분하다(전역 상태를 더 두지 않는다).
 */
export function markTabDropHandled(now = Date.now()): void {
  handledAt = now
}

/**
 * 방금 그 드롭을 우리가 처리했는가. drop → dragend 사이는 같은 프레임 수준이라 창을 짧게 잡는다 —
 * 길게 잡으면 **직전 드롭의 흔적** 때문에 다음 드래그가 새 창을 못 만든다.
 */
export const DROP_HANDLED_MS = 400

export function tabDropHandled(now = Date.now()): boolean {
  return handledAt !== 0 && now - handledAt < DROP_HANDLED_MS
}

/** 테스트·창 전환용 초기화. */
export function resetTabDrop(): void {
  handledAt = 0
}
