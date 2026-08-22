// 탭을 **창 밖에** 놓았는가 — 그러면 새 창으로 떼어낸다.
// (2026-08-22 준영님 제보 4·31: "탭 드래그로 새 창", "탭 밖으로 드롭하면 새 창이 뜨게".)
//
// 왜 좌표로 판정하나: HTML5 드래그는 앱 밖으로 나가는 순간 아무 이벤트도 주지 않는다. 남는 단서는
// 드래그가 끝날 때 원본 탭이 받는 dragend 뿐이고, 거기엔 ① 아무도 안 받았다는 표시(dropEffect
// 'none') ② 마지막 커서의 **화면 좌표**가 실려 있다. 둘을 함께 본다:
//   · dropEffect 만 보면 사이드바·상태바처럼 **창 안의 안 받는 자리**에 놓아도 창이 튀어나온다.
//   · 좌표만 보면 창 위에 겹쳐 놓은 다른 창에 떨어뜨린 경우를 가려내지 못한다.
// 탭바 위(재정렬)와 터미널 영역(분할)은 각자 drop 을 받으므로 dropEffect 가 'move' 라 여기까지 안 온다.
//
// 남는 구멍 하나: 드래그 중 ESC 로 취소하면 브라우저는 dragend 를 **취소라고 말해 주지 않는다**
// (드래그 중에는 키 이벤트도 페이지로 오지 않는다). 커서가 창 밖에 있는 채로 ESC 를 누르면 창이
// 하나 뜬다. 되돌리는 길이 있어서(그 창을 닫으면 "본창으로 보내기"를 물어본다) 그대로 둔다.
export type WinBox = { x: number; y: number; w: number; h: number }

export function shouldDetach(dropEffect: string, at: { x: number; y: number }, win: WinBox): boolean {
  if (dropEffect !== 'none') return false // 누군가 받았다 = 재정렬·분할이 처리했다
  return at.x < win.x || at.y < win.y || at.x >= win.x + win.w || at.y >= win.y + win.h
}
