import { describe, it, expect } from 'vitest'
import { AI_ENTRY } from '../src/shared/features'
import { KEYMAP } from '../src/shared/keymap'
import { ACTIVITY_ITEMS } from '../src/shared/types'
import { pickCut, placeTip, splitTip } from '../src/renderer/store/tooltip'

// #73(2026-08-14) — 액티비티 바 툴팁의 단축키가 KEYMAP 에서 나오는지.
//
// 예전엔 아홉 중 둘만 "설정 (Ctrl+,)" 처럼 문구에 직접 박혀 있었는데, 실제로 단축키가 있는 것은
// 다섯이었다 — 미니 프리뷰(Ctrl+Shift+P)·파일 탐색기(Ctrl+Shift+O)·세션 로그(Ctrl+Shift+S)가
// 툴팁에 안 나왔다. 문구에 박아 두면 이렇게 갈린다.
//
// activityTip 자체는 navigator 를 읽어 DOM 환경이 필요하므로 여기서는 **표가 어긋나지 않는지**를
// 본다: 액티비티 바가 참조하는 액션이 전부 KEYMAP 에 있고 실제로 배선돼 있는가.
// 조합이 붙은 문구를 splitTip 이 뱃지로 떼어 내는지는 tooltip.test.ts 가 이미 본다.

// ActivityBar.ACTIVITY_KEY 와 같은 표. 여기서 어긋나면 툴팁에 없는 키가 뜨거나 빠진다.
const ACTIVITY_KEY = {
  ai: 'ai.toggle',
  log: 'log.save',
  preview: 'preview.toggle',
  explorer: 'explorer.toggle',
  settings: 'settings.open'
} as const

describe('액티비티 바 툴팁 단축키', () => {
  it('참조하는 액션이 전부 KEYMAP 에 있고 배선돼 있다', () => {
    for (const [id, action] of Object.entries(ACTIVITY_KEY)) {
      // 숨긴 기능(features.AI_ENTRY)의 항목은 레일에 뜨지 않으므로 툴팁도 뜨지 않는다 — 건너뛴다.
      if (!AI_ENTRY && id === 'ai') continue
      const b = KEYMAP.find((k) => k.action === action)
      expect(b, id).toBeDefined()
      // 미구현 키를 툴팁에 적으면 눌러도 안 되는 키를 광고하는 셈이다.
      expect(b!.implemented, id).toBe(true)
      expect(b!.win, id).toBeTruthy()
    }
  })

  it('★ 단축키가 있는 항목이 다섯이고, 셋은 예전에 빠져 있던 것이다', () => {
    expect(Object.keys(ACTIVITY_KEY).sort()).toEqual(['ai', 'explorer', 'log', 'preview', 'settings'])
    for (const id of ['preview', 'explorer', 'log'] as const) {
      expect(ACTIVITY_KEY[id]).toBeTruthy()
    }
  })

  it('표의 키는 전부 실제 액티비티 항목이다', () => {
    for (const id of Object.keys(ACTIVITY_KEY)) {
      expect(ACTIVITY_ITEMS).toContain(id)
    }
  })

  it('만들어진 문구를 splitTip 이 이름과 뱃지로 가른다', () => {
    const win = KEYMAP.find((k) => k.action === 'preview.toggle')!.win
    expect(splitTip(`미니 프리뷰 (${win})`)).toEqual({ text: '미니 프리뷰', key: win })
    // 단축키가 없는 항목은 꼬리표 없이 이름만 — 빈 괄호가 붙으면 안 된다.
    expect(splitTip('포트 모니터')).toEqual({ text: '포트 모니터', key: null })
  })
})

// 2026-09-05 — "잘린 글자만 툴팁" 규칙(pickCut)과 "넓은 앵커는 위로"(placeTip) 를 넣으면서
// 액티비티 바가 **두 규칙 모두의 사각지대**가 됐다. 여기서 그 둘을 지킨다:
// 잘못하면 레일 툴팁이 통째로 안 뜨거나(pickCut), 다음 아이콘을 덮는다(placeTip).
describe('액티비티 바는 두 규칙의 예외로 남는다', () => {
  it('★ 아이콘뿐인 버튼은 asIs — skip 으로 묶으면 레일 툴팁이 전부 죽는다', () => {
    // <button title="미니 프리뷰 (Ctrl+Shift+P)"><Eye /></button> — 글자를 그리는 자식이 없다.
    // 화면에 같은 글자가 없으니 "다 보인다"고 판정할 근거 자체가 없다.
    const win = KEYMAP.find((k) => k.action === 'preview.toggle')!.win
    const btn = [
      { text: '', scrollW: 34, clientW: 34 }, // <button>
      { text: '', scrollW: 0, clientW: 0 } // <svg>
    ]
    expect(pickCut(`미니 프리뷰 (${win})`, btn)).toEqual({ kind: 'asIs' })
  })

  it('★ 레일 어디에 있어도 좌우 — 위/아래로 붙으면 다음 아이콘 가는 길이 막힌다', () => {
    // 항목 수만큼 34px 간격으로 내려가며 전부 본다. 툴팁은 max-width 380 을 가정.
    const rail = (top: number, left: number) => ({
      left,
      top,
      right: left + 34,
      bottom: top + 34,
      width: 34,
      height: 34
    })
    for (let i = 0; i < ACTIVITY_ITEMS.length + 1; i++) {
      const top = 40 + i * 34
      expect(placeTip(rail(top, 6), 380, 24, 1600, 900).side, `좌측 레일 ${i}`).toBe('right')
      expect(placeTip(rail(top, 1560), 380, 24, 1600, 900).side, `우측 레일 ${i}`).toBe('left')
    }
  })
})
