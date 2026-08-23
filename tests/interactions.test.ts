import { describe, it, expect } from 'vitest'
import { AI_CHAT } from '../src/shared/features'
import { CONTEXT_ACTIONS } from '../src/renderer/interactions/actions'

// F4c 컨텍스트 액션 레지스트리.
// #67(2026-08-14): 라디얼 배치 공식(§9.1)·팔레트 뷰포트 보정(§9.2) 테스트가 여기 있었다.
// 두 컴포넌트를 지우면서 함께 지웠다 — 남은 모양은 리스트 하나뿐이라 좌표 계산이 없다.

describe('컨텍스트 액션 단일 레지스트리', () => {
  it('6개 항목(분할 둘은 서브메뉴로 빠졌다 — 2026-08-18)', () => {
    // 2026-08-23: 아라 대화를 숨기면 [아라에게 묻기] 한 줄이 빠져 다섯이 된다(features.AI_CHAT).
    expect(CONTEXT_ACTIONS).toHaveLength(AI_CHAT ? 6 : 5)
  })

  it('★ "추후 지원" 항목이 하나도 없다 — 눌렀는데 안 되는 메뉴를 두지 않는다', () => {
    // 2026-08-14: 마지막 하나였던 log.save 가 실배선됐다(로그 패널을 연다). 그전에는
    // "추후 지원" 토스트만 냈는데 패널의 [내려받기]는 이미 동작하고 있었다 — 있는 기능이
    // 없는 척하고 있었다. future 플래그 자체는 남겨 두되 쓰는 곳이 없어야 한다.
    expect(CONTEXT_ACTIONS.filter((a) => a.future).map((a) => a.id)).toEqual([])
  })

  it('실동작 5종(복사/붙여넣기/복제/아라에게 묻기/닫기)은 future 아님', () => {
    // split.* 는 2026-08-18 에 서브메뉴로 빠져 이 레지스트리에 없다 — 그 둘이 살아 있는지는
    // ux-round1 의 "묶음 둘이 서브메뉴로 있다" 가 본다(같은 사실을 두 곳에서 세지 않는다).
    const live = ['copy', 'paste', 'session.duplicate', 'pane.close', ...(AI_CHAT ? ['ai.ask'] : [])]
    for (const id of live) {
      const a = CONTEXT_ACTIONS.find((x) => x.id === id)
      expect(a).toBeDefined()
      expect(a?.future).toBeFalsy()
    }
  })
})
