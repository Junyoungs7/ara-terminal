// 포트 모니터 독립 창의 진입 해시. main 과 renderer 가 **같은 문자열**을 봐야 하므로 여기 둔다
// (sessionWin.ts 와 같은 이유 — 한쪽만 고치면 창이 빈 화면으로 뜨고 그 사실을 아무도 못 잡는다).
//
// 편집기(#editor)·RDP(#rdpwin)·떼어낸 세션(#sessionwin) 과 달리 **매개변수가 없다.**
// 어느 서버를 볼지는 창 안에서 탭으로 고르기 때문이다(창은 하나, 탭이 는다).
export const PORT_WIN_HASH = '#portwin'

export function isPortWinHash(hash: string): boolean {
  return hash === PORT_WIN_HASH
}
