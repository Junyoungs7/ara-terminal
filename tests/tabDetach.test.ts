import { describe, it, expect, beforeEach } from 'vitest'
import { DROP_HANDLED_MS, markTabDropHandled, resetTabDrop, tabDropHandled } from '../src/renderer/store/tabDetach'

// 탭을 놓은 자리가 새 창을 만드는지 가르는 규칙.
//
// 2026-08-22 에는 "아무도 안 받았다(dropEffect 'none') + 창 밖 좌표"로 쟀는데 준영님 화면에서
// **바탕화면에서만** 창이 떴다(제보 5). 다른 앱은 텍스트 드롭을 받아 dropEffect 가 'none' 이
// 아니었고, 우리 창 안의 사이드바·하단바는 좌표 조건에 걸렸다. 그래서 규칙을 뒤집었다:
// **우리가 받았는가**만 본다. 그 하나로 "탭바·터미널 칸이면 처리, 나머지는 전부 새 창"이 된다.

describe('탭 드롭 — 우리가 받았는가', () => {
  beforeEach(() => resetTabDrop())

  it('아무것도 안 받았으면 우리가 처리한 것이 아니다(= 새 창)', () => {
    expect(tabDropHandled()).toBe(false)
  })

  it('★ 탭바·터미널 칸이 받으면 그 직후 dragEnd 는 새 창을 만들지 않는다', () => {
    markTabDropHandled(1000)
    expect(tabDropHandled(1000)).toBe(true)
    expect(tabDropHandled(1000 + DROP_HANDLED_MS - 1)).toBe(true)
  })

  it('★ 흔적은 곧 만료된다 — 직전 드롭 때문에 다음 드래그가 새 창을 못 만들면 안 된다', () => {
    markTabDropHandled(1000)
    expect(tabDropHandled(1000 + DROP_HANDLED_MS)).toBe(false)
    expect(tabDropHandled(9999)).toBe(false)
  })
})
