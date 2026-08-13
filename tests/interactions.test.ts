import { describe, it, expect } from 'vitest'
import { radialOffset } from '../src/renderer/interactions/RadialMenu'
import { clampToViewport } from '../src/renderer/interactions/SmartPalette'
import { CONTEXT_ACTIONS } from '../src/renderer/interactions/actions'

// F4c 순수 로직 — 라디얼 배치 공식(§9.1) + 팔레트 뷰포트 경계 보정(§9.2). (계획서 §D.1)

describe('라디얼 배치 공식 (§9.1)', () => {
  it('i=0 은 12시(-90°) — 위쪽(y=-88, x≈0)', () => {
    const o = radialOffset(0, 8)
    expect(Math.abs(o.x)).toBeLessThan(1e-6)
    expect(o.y).toBeCloseTo(-88, 5)
  })

  it('n=4 에서 i=1 은 3시(오른쪽, x=88, y≈0)', () => {
    const o = radialOffset(1, 4)
    expect(o.x).toBeCloseTo(88, 5)
    expect(Math.abs(o.y)).toBeLessThan(1e-6)
  })

  it('모든 항목이 반경 88 위에 놓인다', () => {
    const n = CONTEXT_ACTIONS.length
    for (let i = 0; i < n; i++) {
      const o = radialOffset(i, n)
      expect(Math.hypot(o.x, o.y)).toBeCloseTo(88, 5)
    }
  })
})

describe('팔레트 뷰포트 경계 보정 (§9.2)', () => {
  it('여유가 있으면 커서 위치 그대로', () => {
    expect(clampToViewport(100, 100, 1440, 900)).toEqual({ left: 100, top: 100 })
  })

  it('오른쪽·아래 경계를 넘으면 안쪽으로 당긴다(280×320 + 8 여백)', () => {
    const r = clampToViewport(1400, 880, 1440, 900)
    expect(r.left).toBe(1440 - 280 - 8)
    expect(r.top).toBe(900 - 320 - 8)
  })
})

describe('컨텍스트 액션 단일 레지스트리', () => {
  it('8개 항목(목업 라디얼/팔레트 공유)', () => {
    expect(CONTEXT_ACTIONS).toHaveLength(8)
  })

  it('남은 미래 기능은 로그 저장 하나다(W3 에서 ai.ask 가 실배선됐다)', () => {
    expect(CONTEXT_ACTIONS.filter((a) => a.future).map((a) => a.id)).toEqual(['log.save'])
  })

  it('실동작 7종(복사/붙여넣기/분할2/복제/AI 질문/닫기)은 future 아님', () => {
    const live = ['copy', 'paste', 'split.horizontal', 'split.vertical', 'session.duplicate', 'ai.ask', 'pane.close']
    for (const id of live) {
      const a = CONTEXT_ACTIONS.find((x) => x.id === id)
      expect(a).toBeDefined()
      expect(a?.future).toBeFalsy()
    }
  })
})
