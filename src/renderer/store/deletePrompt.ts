// #89(2026-08-16) — 삭제 확인 문구 고르기(순수 — 단위 테스트 대상).
//
// 왜 갈라야 하나: 같은 [삭제] 버튼인데 **로컬은 휴지통, 원격은 영구**다. 지금까지 문구 하나가
// 양쪽에 쓰이면서 "되돌릴 수 없습니다"라고 말했다 — 휴지통으로 가는데 그렇게 겁주는 것도,
// 반대로 영구인데 안심시키는 것도 똑같이 거짓말이다. 문구가 실제 동작과 어긋나면 그다음부터
// 사용자는 확인 창을 안 읽는다.
//
// 폴더 경고("하위 내용까지")는 **원격에만** 붙인다. 휴지통은 폴더째 되돌릴 수 있어 경고할 것이 없다.

export type DeletePrompt = {
  messageKey: string
  confirmKey: string
  /** 되돌릴 수 있으면 false. 확인 창의 색조(danger)를 정한다. */
  permanent: boolean
}

export function deletePrompt(ctx: { remote: boolean; dirCount: number }): DeletePrompt {
  if (!ctx.remote) {
    return { messageKey: 'file.del.msgTrash', confirmKey: 'file.del.btnTrash', permanent: false }
  }
  return {
    messageKey: ctx.dirCount > 0 ? 'file.del.msgDir' : 'file.del.msg',
    confirmKey: 'file.del.btn',
    permanent: true
  }
}
