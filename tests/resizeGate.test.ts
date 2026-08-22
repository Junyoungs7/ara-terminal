import { describe, it, expect, beforeEach } from 'vitest'
import { holdTermResize, isResizeHeld, whenResizeAllowed } from '../src/renderer/terminal/resizeGate'

// 2026-08-22 준영님 결정(제보 14·15)으로 하단바가 터미널을 **밀어내게** 됐다. 그러면 경계를 끄는
// 동안 터미널 높이가 매 프레임 바뀌는데, 그때마다 xterm 을 다시 맞추면 분할 칸 수만큼 곱해진다.
// 2026-08-17 에 "덮는 방식"으로 도망갔던 이유가 그것이었다 — 이 게이트가 그 이유를 없앤다.

describe('터미널 리사이즈 게이트', () => {
  beforeEach(() => {
    // 앞 테스트가 붙든 채로 끝났어도 다음 테스트가 영향을 안 받게 푼다.
    while (isResizeHeld()) holdTermResize()() // eslint-disable-line no-unmodified-loop-condition
  })

  it('붙들지 않았으면 그 자리에서 실행한다', () => {
    let n = 0
    whenResizeAllowed(() => (n += 1))
    expect(n).toBe(1)
  })

  it('붙든 동안은 미루고, 놓을 때 한 번 실행한다', () => {
    let n = 0
    const release = holdTermResize()
    whenResizeAllowed(() => (n += 1))
    expect(n).toBe(0) // 끄는 중에는 아무것도 안 한다
    release()
    expect(n).toBe(1)
  })

  it('★ 같은 콜백이 여러 번 밀려도 한 번만 실행된다 — 드래그 한 번에 fit 도 한 번', () => {
    let n = 0
    const fit = (): void => {
      n += 1
    }
    const release = holdTermResize()
    for (let i = 0; i < 60; i++) whenResizeAllowed(fit) // 60프레임 드래그
    release()
    expect(n).toBe(1)
  })

  it('여러 칸(콜백)이 각각 한 번씩 따라잡는다', () => {
    const hit: string[] = []
    const release = holdTermResize()
    const a = (): void => void hit.push('a')
    const b = (): void => void hit.push('b')
    whenResizeAllowed(a)
    whenResizeAllowed(b)
    whenResizeAllowed(a)
    release()
    expect(hit.sort()).toEqual(['a', 'b'])
  })

  it('중첩해 붙들면 마지막이 풀릴 때 흘린다', () => {
    let n = 0
    const r1 = holdTermResize()
    const r2 = holdTermResize()
    whenResizeAllowed(() => (n += 1))
    r1()
    expect(n).toBe(0) // 아직 하나가 붙들고 있다
    r2()
    expect(n).toBe(1)
  })

  it('같은 손잡이를 두 번 놓아도 카운트가 깨지지 않는다', () => {
    const release = holdTermResize()
    release()
    release() // 실수로 두 번 — 여기서 음수가 되면 다음 hold 가 즉시 새어 나간다
    expect(isResizeHeld()).toBe(false)

    let n = 0
    const r2 = holdTermResize()
    whenResizeAllowed(() => (n += 1))
    expect(n).toBe(0)
    r2()
    expect(n).toBe(1)
  })
})
