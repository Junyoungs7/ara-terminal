import { describe, it, expect } from 'vitest'
import { shouldDetach } from '../src/renderer/store/tabDetach'

// 2026-08-22 준영님 제보 4·31: 탭을 창 밖으로 끌어다 놓으면 새 창이 떠야 한다.
// 판정을 순수 함수로 뽑아 둔 이유가 이 파일이다 — 진짜 드래그 없이 규칙만 시험한다.

const win = { x: 100, y: 100, w: 800, h: 600 } // 화면 (100,100)~(900,700)

describe('shouldDetach — 창 밖에 놓았는가', () => {
  it('★ 창 밖 + 아무도 안 받음 → 떼어낸다', () => {
    expect(shouldDetach('none', { x: 1500, y: 400 }, win)).toBe(true) // 오른쪽 모니터
    expect(shouldDetach('none', { x: 400, y: 900 }, win)).toBe(true) // 아래
    expect(shouldDetach('none', { x: 50, y: 400 }, win)).toBe(true) // 왼쪽
    expect(shouldDetach('none', { x: 400, y: 20 }, win)).toBe(true) // 위
  })

  it('★ 누군가 받았으면 창 밖이어도 떼어내지 않는다 — 재정렬·분할이 처리한 드롭이다', () => {
    expect(shouldDetach('move', { x: 1500, y: 400 }, win)).toBe(false)
    expect(shouldDetach('copy', { x: 1500, y: 400 }, win)).toBe(false)
  })

  it('★ 창 안에서 아무 데나 놓은 것은 떼어내기가 아니다 — 사이드바·상태바에 놓아도 창이 튀어나오면 안 된다', () => {
    expect(shouldDetach('none', { x: 120, y: 400 }, win)).toBe(false) // 사이드바쯤
    expect(shouldDetach('none', { x: 500, y: 690 }, win)).toBe(false) // 상태바쯤
  })

  it('경계: 왼쪽·위 모서리는 안, 오른쪽·아래 끝은 밖(창 좌표계와 같은 규칙)', () => {
    expect(shouldDetach('none', { x: 100, y: 100 }, win)).toBe(false)
    expect(shouldDetach('none', { x: 899, y: 699 }, win)).toBe(false)
    expect(shouldDetach('none', { x: 900, y: 400 }, win)).toBe(true)
    expect(shouldDetach('none', { x: 400, y: 700 }, win)).toBe(true)
  })
})
