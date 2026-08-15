import { describe, it, expect } from 'vitest'
import { deletePrompt } from '../src/renderer/store/deletePrompt'

// #89(2026-08-16) — 같은 [삭제] 버튼인데 로컬은 휴지통, 원격은 영구다.
//
// 왜 검사하나: 문구 하나를 양쪽에 쓰면서 "되돌릴 수 없습니다"라고 말하고 있었다. 휴지통으로 가는데
// 그렇게 겁주는 것도, 영구인데 안심시키는 것도 똑같이 거짓말이고 — 한 번 어긋나면 그다음부터
// 사용자는 확인 창을 안 읽는다. 어느 문구가 나가는지는 이 함수 하나가 정한다.

describe('deletePrompt — 로컬은 휴지통', () => {
  it('되돌릴 수 있다고 표시한다', () => {
    expect(deletePrompt({ remote: false, dirCount: 0 })).toEqual({
      messageKey: 'file.del.msgTrash',
      confirmKey: 'file.del.btnTrash',
      permanent: false
    })
  })

  it('★ 폴더가 섞여도 문구가 같다 — 휴지통은 폴더째 되돌릴 수 있어 경고할 것이 없다', () => {
    expect(deletePrompt({ remote: false, dirCount: 3 }).messageKey).toBe('file.del.msgTrash')
  })
})

describe('deletePrompt — 원격은 영구', () => {
  it('파일만 고르면 기본 경고', () => {
    expect(deletePrompt({ remote: true, dirCount: 0 })).toEqual({
      messageKey: 'file.del.msg',
      confirmKey: 'file.del.btn',
      permanent: true
    })
  })

  it('★ 폴더가 섞이면 하위 내용까지 사라진다고 못 박는다', () => {
    expect(deletePrompt({ remote: true, dirCount: 1 }).messageKey).toBe('file.del.msgDir')
  })

  it('버튼 라벨이 로컬과 다르다 — 누르기 직전 마지막 단서다', () => {
    expect(deletePrompt({ remote: true, dirCount: 0 }).confirmKey).not.toBe(
      deletePrompt({ remote: false, dirCount: 0 }).confirmKey
    )
  })
})
