import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOUSE_CURSORS, mouseCursorOf } from '../src/shared/types'
import { CURSOR_KINDS, cursorValue } from '../src/renderer/cursorThemes'

// 2.0 4단계 — 마우스 커서 테마. 값마다 표준 커서 폴백이 붙고, 시스템 기본이면 표준 키워드뿐이다.
describe('마우스 커서 테마', () => {
  it('저장값은 목록 안으로 클램프한다', () => {
    expect(mouseCursorOf('mac')).toBe('mac')
    expect(mouseCursorOf('nope')).toBe('system')
    expect(mouseCursorOf(undefined)).toBe('system')
  })

  it('테마 값은 url(...) x y, <표준값> · 시스템 기본은 표준 키워드', () => {
    for (const theme of MOUSE_CURSORS)
      for (const k of CURSOR_KINDS) {
        const v = cursorValue(theme, k)
        if (theme === 'system') expect(v).toMatch(/^[a-z-]+$/)
        else expect(v).toMatch(/^url\("data:image\/svg\+xml,%3Csvg .+"\) \d+ \d+, (default|pointer|text|col-resize|wait)$/)
      }
  })

  it('CSS 의 표준 커서는 전부 테마 변수를 거친다(맨 키워드가 남으면 그 자리만 테마를 안 탄다)', () => {
    for (const f of ['shell.css', 'interactions.css']) {
      const css = readFileSync(`src/renderer/styles/${f}`, 'utf8')
      expect(css.match(/cursor:\s*(pointer|default|text|col-resize)\s*;/g), f).toBeNull()
    }
  })
})
