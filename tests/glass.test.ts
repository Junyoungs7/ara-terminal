// G1 글라스(시안 C) — 켬/끔 판정 · 설정 기본값 · 토큰 · 성능 측정 인자.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { glassMaterialOf, glassOn } from '../src/shared/glass'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import type { UiState } from '../src/shared/types'

const perf = createRequire(import.meta.url)('./perf-baseline.cjs')

describe('글라스 스위치', () => {
  it('ARA_GLASS 가 설정을 덮는다(1 켬 · 0 끔 · 그 밖은 설정값)', () => {
    expect(glassOn(false, '1')).toBe(true)
    expect(glassOn(true, '0')).toBe(false)
    expect(glassOn(true, undefined)).toBe(true)
    expect(glassOn(false, 'yes')).toBe(false)
  })
  it('설정 기본값은 끔 — 옛 스냅샷(필드 없음)도 끔, true 만 켬', () => {
    expect(prefsFrom({} as UiState).glass).toBe(false)
    expect(prefsFrom({ glass: true } as UiState).glass).toBe(true)
    expect(prefsFrom({ glass: 'on' } as unknown as UiState).glass).toBe(false)
  })
  it('OS 재질은 측정용 env 로만, 안 되는 OS 면 CSS 바탕(null)', () => {
    expect(glassMaterialOf(undefined, 'win32')).toBeNull()
    expect(glassMaterialOf('os', 'win32')).toBe('mica')
    expect(glassMaterialOf('acrylic', 'win32')).toBe('acrylic')
    expect(glassMaterialOf('os', 'darwin')).toBe('vibrancy')
    expect(glassMaterialOf('mica', 'darwin')).toBeNull()
    expect(glassMaterialOf('os', 'linux')).toBeNull()
  })
})

describe('글라스 CSS', () => {
  const css = readFileSync('src/renderer/styles/glass.css', 'utf8')
  const tokens = readFileSync('src/renderer/styles/tokens.css', 'utf8')
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')

  it('모든 규칙이 data-glass="on" 아래에 있다 — 끄면 지금 화면 그대로', () => {
    const selectors = [...body.matchAll(/([^{}@]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => s && !/^(from|to|media|keyframes|\d)/.test(s))
    expect(selectors.length).toBeGreaterThan(10)
    for (const s of selectors) expect(s, s).toContain(":root[data-glass='on']")
  })
  it('터미널·에디터·diff·.main 은 건드리지 않는다(불투명 유지)', () => {
    for (const cls of ['.xterm', '.main', '.pane-grid', '.cm-editor', '.diff', '.term-tabbar']) {
      expect(body.includes(cls + ' ') || body.includes(cls + ',') || body.includes(cls + '{'), cls).toBe(false)
    }
  })
  it('투명·블러는 투명도 줄이기·고대비·강제 색이면 빠진다', () => {
    const at = body.indexOf('@media (prefers-reduced-transparency: no-preference)')
    expect(at).toBeGreaterThan(0)
    expect(body).toMatch(/prefers-contrast: no-preference/)
    expect(body).toMatch(/forced-colors: none/)
    // backdrop-filter·바탕은 그 @media 안에만
    expect(body.indexOf('backdrop-filter')).toBeGreaterThan(at)
    expect(body.indexOf('var(--gl-wall)')).toBeGreaterThan(at)
  })
  it('키프레임은 transform·opacity 만(블러 면 위에서 다시 그리기 없음)', () => {
    for (const m of body.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\}\s*)\}/g)) {
      const props = [...m[1].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1])
      for (const p of props) expect(['transform', 'opacity']).toContain(p)
    }
  })
  it('쓰는 --gl-*·--sig-* 토큰이 tokens.css 에 있다', () => {
    for (const m of body.matchAll(/var\((--(?:gl|sig)-[a-z0-9-]+)\)/g)) expect(tokens, m[1]).toContain(m[1] + ':')
  })
})

describe('perf-baseline --glass', () => {
  it('기본 off, on|off 만 받는다', () => {
    expect(perf.parseArgs([]).glass).toBe('off')
    expect(perf.parseArgs(['--gate', '--glass=on']).glass).toBe('on')
    expect(() => perf.parseArgs(['--glass=maybe'])).toThrow()
  })
})
