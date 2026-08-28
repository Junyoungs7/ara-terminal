import { describe, it, expect } from 'vitest'
import { AI_ENTRY } from '../src/shared/features'
import { CONTEXT_ACTIONS } from '../src/renderer/interactions/actions'

// F4c 컨텍스트 액션 레지스트리.
// #67(2026-08-14): 라디얼 배치 공식(§9.1)·팔레트 뷰포트 보정(§9.2) 테스트가 여기 있었다.
// 두 컴포넌트를 지우면서 함께 지웠다 — 남은 모양은 리스트 하나뿐이라 좌표 계산이 없다.

describe('컨텍스트 액션 단일 레지스트리', () => {
  it('6개 항목(분할 둘은 서브메뉴로 빠졌다 — 2026-08-18)', () => {
    // 2026-08-23: 아라 대화를 숨기면 [아라에게 묻기] 한 줄이 빠져 다섯이 된다(features.AI_ENTRY).
    expect(CONTEXT_ACTIONS).toHaveLength(AI_ENTRY ? 6 : 5)
  })

  // "추후 지원" 항목이 없다는 것을 여기서 두 번 셌었다(future 플래그가 빈 배열인가 · 실동작
  // 5종이 future 가 아닌가). AUDIT-R5 에서 `future` 필드를 지웠으므로 이제 **컴파일러가** 그
  // 불변식을 지킨다 — 다시 세우려면 타입에 필드를 되살려야 하고 그 자리에서 눈에 띈다.
  it('실동작 5종(복사/붙여넣기/복제/아라에게 묻기/닫기)이 레지스트리에 있다', () => {
    // split.* 는 2026-08-18 에 서브메뉴로 빠져 이 레지스트리에 없다 — 그 둘이 살아 있는지는
    // ux-round1 의 "묶음 둘이 서브메뉴로 있다" 가 본다(같은 사실을 두 곳에서 세지 않는다).
    const live = ['copy', 'paste', 'session.duplicate', 'pane.close', ...(AI_ENTRY ? ['ai.ask'] : [])]
    for (const id of live) {
      expect(CONTEXT_ACTIONS.find((x) => x.id === id), id).toBeDefined()
    }
  })
})
