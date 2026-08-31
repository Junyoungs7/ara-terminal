import { describe, it, expect, beforeEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { registerTerm, remeasureAll, sizeOf, unregisterTerm } from '../src/renderer/terminal/termRegistry'

// 2026-08-31 실측: 번들 폰트는 `font-display: swap` 이라 파일이 오기 전에는 스택의 **다음 폰트**로
// 그려진다. xterm 은 `term.open()` 때 딱 한 번 셀을 재고 `document.fonts` 를 보지 않으므로,
// 진짜 폰트가 도착해도 폴백의 셀 크기로 굳는다(준영님 설정 JetBrains Mono 14px/1.3 에서
// 7×18 로 굳어 126칸 44행 — 진짜 치수 8.4×23 으로는 107칸 34행).
//
// 고치는 열쇠는 **같은 값으로는 안 된다**는 것이다: xterm 의 OptionsService 는
// `rawOptions[k] !== v` 일 때만 이벤트를 쏘고, 셀을 다시 재는 리스너는 fontFamily·fontSize 가
// 실제로 바뀔 때만 걸린다. 이 검사가 그 우회(크기 흔들기)를 붙들어 둔다 —
// 누가 "같은 값 대입은 의미 없다"며 지우면 폰트 늦게 오는 창이 조용히 되돌아온다.

/** fontSize 대입 순서를 기록하는 가짜 xterm. 실제 xterm 과 같은 동일값 가드를 흉내 낸다. */
function fakeTerm(size: number): { term: Terminal; writes: number[] } {
  const writes: number[] = []
  let current = size
  const options = {
    get fontSize(): number {
      return current
    },
    set fontSize(v: number) {
      if (v === current) return // ← xterm 의 `rawOptions[k] !== v` 가드
      current = v
      writes.push(v)
    }
  }
  return { term: { options } as unknown as Terminal, writes }
}

const noopAddons = { search: {} as SearchAddon }

describe('폰트가 늦게 온 뒤의 셀 재측정 (remeasureAll)', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c']) unregisterTerm(id)
  })

  it('★ fontSize 를 실제로 바꿨다가 되돌린다 — 같은 값만 넣으면 xterm 이 다시 재지 않는다', () => {
    const { term, writes } = fakeTerm(14)
    let fitted = 0
    registerTerm('a', { term, fit: { fit: () => (fitted += 1) } as unknown as FitAddon, ...noopAddons })

    remeasureAll()

    expect(writes).toEqual([15, 14]) // 흔들고 되돌린다 = 가드를 두 번 통과한다
    expect(term.options.fontSize).toBe(14) // 사용자가 정한 크기는 그대로 남는다
    expect(fitted).toBe(1) // 새 셀 크기로 행·칸을 다시 계산한다
  })

  it('한 칸의 fit 이 던져도 나머지 칸은 맞춘다', () => {
    const a = fakeTerm(14)
    const b = fakeTerm(16)
    let bFitted = 0
    registerTerm('a', {
      term: a.term,
      fit: {
        fit: () => {
          throw new Error('숨김 패널 — clientWidth 0')
        }
      } as unknown as FitAddon,
      ...noopAddons
    })
    registerTerm('b', { term: b.term, fit: { fit: () => (bFitted += 1) } as unknown as FitAddon, ...noopAddons })

    expect(() => remeasureAll()).not.toThrow()
    expect(bFitted).toBe(1)
    expect(b.writes).toEqual([17, 16])
  })

  it('열린 터미널이 없으면 아무 일도 없다', () => {
    expect(() => remeasureAll()).not.toThrow()
  })
})

// #158: 접속 **전에** 셸 크기를 아는 창구. 새 SSH 세션은 포커스 칸의 sessionId 를 갈아 끼우는
// 식으로 뜨므로(layout.showSession), 지금 그 칸에 있는 xterm 의 치수가 곧 새 세션의 치수다.
// null 이 나오는 경우(빈 칸·RDP·placeholder)는 **폴백을 타야 한다** — main 이 80×24 로 연다.
describe('#158 포커스 칸의 치수 읽기 (sizeOf)', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c']) unregisterTerm(id)
  })

  const addon = { fit: {} as unknown as FitAddon, ...noopAddons }

  it('등록된 터미널의 cols·rows 를 그대로 준다', () => {
    registerTerm('a', { term: { cols: 203, rows: 51 } as unknown as Terminal, ...addon })
    expect(sizeOf('a')).toEqual({ cols: 203, rows: 51 })
  })

  it('없는 세션·null 이면 null 이다(그때는 접속이 크기를 안 보낸다)', () => {
    expect(sizeOf('a')).toBeNull()
    expect(sizeOf(null)).toBeNull()
  })
})
