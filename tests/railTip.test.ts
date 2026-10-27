import { describe, it, expect } from 'vitest'
import { KEYMAP } from '../src/shared/keymap'
import { pickCut, placeTip, splitTip } from '../src/renderer/store/tooltip'

// 좌측 아이콘 레일 툴팁(2.0 — 옛 우측 액티비티 바 시험 activityTip 에서 레일에 남는 규칙만 옮겼다).
// 레일 버튼은 아이콘뿐이고 툴팁이 `이름 (조합)` 이다(Sidebar.tsx railTip).

describe('레일 툴팁 문구', () => {
  it('만들어진 문구를 splitTip 이 이름과 뱃지로 가른다', () => {
    const win = KEYMAP.find((k) => k.action === 'explorer.toggle')!.win
    expect(splitTip(`탐색기 (${win})`)).toEqual({ text: '탐색기', key: win })
    // 단축키가 없는 항목은 꼬리표 없이 이름만 — 빈 괄호가 붙으면 안 된다.
    expect(splitTip('지난 세션')).toEqual({ text: '지난 세션', key: null })
  })
})

// 2026-09-05 — "잘린 글자만 툴팁"(pickCut)과 "넓은 앵커는 위로"(placeTip). 아이콘 레일은 두 규칙의
// 사각지대다: 잘못하면 레일 툴팁이 통째로 안 뜨거나(pickCut), 다음 아이콘을 덮는다(placeTip).
describe('아이콘 레일은 두 규칙의 예외로 남는다', () => {
  it('★ 아이콘뿐인 버튼은 asIs — skip 으로 묶으면 레일 툴팁이 전부 죽는다', () => {
    const win = KEYMAP.find((k) => k.action === 'explorer.toggle')!.win
    const btn = [
      { text: '', scrollW: 34, clientW: 34 }, // <button>
      { text: '', scrollW: 0, clientW: 0 } // <svg>
    ]
    expect(pickCut(`탐색기 (${win})`, btn)).toEqual({ kind: 'asIs' })
  })

  it('★ 레일 어디에 있어도 좌우 — 위/아래로 붙으면 다음 아이콘 가는 길이 막힌다', () => {
    const rail = (top: number, left: number) => ({ left, top, right: left + 34, bottom: top + 34, width: 34, height: 34 })
    for (let i = 0; i < 16; i++) {
      const top = 40 + i * 34
      expect(placeTip(rail(top, 6), 380, 24, 1600, 900).side, `좌측 레일 ${i}`).toBe('right')
      expect(placeTip(rail(top, 1560), 380, 24, 1600, 900).side, `우측 레일 ${i}`).toBe('left')
    }
  })
})
