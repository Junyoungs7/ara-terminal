// F32 세션 창 해시 파싱 — 잘못 읽으면 본창이 두 번 뜨거나(같은 세션을 두 창이 그린다) 빈 창이 남는다.
// 창을 여는 쪽(main)과 읽는 쪽(renderer)이 문자열 하나로 맞추는 자리라 순수 함수로 떼어 검증한다.
import { describe, it, expect } from 'vitest'
import { parseSessionWinHash, sessionWinHash } from '../src/shared/sessionWin'

describe('세션 창 해시', () => {
  it('win 을 읽는다', () => {
    expect(parseSessionWinHash('#sessionwin?win=w1abc')).toEqual({ winId: 'w1abc' })
  })

  it('우리 해시가 아니면 null — 본창이 그려져야 한다', () => {
    expect(parseSessionWinHash('')).toBeNull()
    expect(parseSessionWinHash('#editor?path=/a')).toBeNull()
    expect(parseSessionWinHash('#rdpwin?profile=p1&w=1&h=1')).toBeNull()
    expect(parseSessionWinHash('#sessionwindow?win=x')).toBeNull()
  })

  it('★ win 이 비어 있으면 null — 소유자 없는 창을 띄우지 않는다', () => {
    expect(parseSessionWinHash('#sessionwin?win=')).toBeNull()
    expect(parseSessionWinHash('#sessionwin?')).toBeNull()
  })

  it('★ 여는 쪽과 읽는 쪽이 왕복한다 — 이 둘이 어긋나면 그 창에 본창이 통째로 뜬다', () => {
    for (const id of ['w1abc', 'w 1', 'w&x=1', '한글창']) {
      expect(parseSessionWinHash(sessionWinHash(id))).toEqual({ winId: id })
    }
  })
})
