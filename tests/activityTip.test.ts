import { describe, it, expect } from 'vitest'
import { KEYMAP } from '../src/shared/keymap'
import { ACTIVITY_ITEMS } from '../src/shared/types'
import { splitTip } from '../src/renderer/store/tooltip'

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
