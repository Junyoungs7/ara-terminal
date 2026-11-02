// G1 글라스(시안 C) — 켬/끔 판정 · 설정 기본값 · 토큰 · 성능 측정 인자.
import { readdirSync, readFileSync } from 'node:fs'
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
  it('G2 설정 기본값은 켬 — 옛 스냅샷(필드 없음)도 켬, false 만 끔', () => {
    expect(prefsFrom({} as UiState).glass).toBe(true)
    expect(prefsFrom({ glass: false } as UiState).glass).toBe(false)
    expect(prefsFrom({ glass: true } as UiState).glass).toBe(true)
  })
  it('G2 처음 화면 기본값(uiPrefs)·main 창 재질 판정도 켬 기준', () => {
    expect(readFileSync('src/renderer/store/uiPrefs.ts', 'utf8')).toMatch(/^\s*glass: true$/m)
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain('ui.glass !== false')
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
    // G2 — .main 은 AI 공간일 때만 비운다(.main.space-ai). 그 안의 가운데 작업 면은 불투명 바닥(--gl-center 끝이 --bg-terminal).
    expect([...body.matchAll(/\.main\.([\w-]+)/g)].map((m) => m[1])).toEqual(['space-ai'])
    expect(body).toMatch(/\.aiws-center\s*\{\s*background: var\(--gl-center\)/)
    expect(tokens).toMatch(/--gl-center:[^;]*var\(--bg-terminal\);/)
  })
  it('G2 고른 행은 앰버 왼쪽 막대 · 막힘 글리프는 반전 · 사용량 막대 홈은 --gl-track', () => {
    expect(body).toMatch(/\.aiws-row\.act[^{]*\{\s*box-shadow: inset 2px 0 0 var\(--sig-user\)/)
    expect(body).toMatch(/data-agent-state='question'\]\) \{\s*background: var\(--text-hi\)/)
    expect(body).toMatch(/\.sb-mbar, \.ara-us \.mb\) \{\s*background: var\(--gl-track\)/)
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

describe('G2 ✦(AI 반짝이) 아이콘 금지 — 브랜드 마크(접힌 별)와 겹치는 모양', () => {
  it('렌더러가 lucide Sparkles·WandSparkles 를 쓰지 않는다(빈 화면은 폴더·워크트리 같은 중립 아이콘)', () => {
    const files = readdirSync('src/renderer', { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) expect(readFileSync('src/renderer/' + f, 'utf8'), f).not.toMatch(/(Wand)?Sparkles|✦/)
    expect(readFileSync('src/renderer/features/aiws/AiSpace.tsx', 'utf8')).toContain('<FolderGit2 className="aiws-home-ic"')
  })
})

describe('perf-baseline --glass', () => {
  it('기본 off, on|off 만 받는다', () => {
    expect(perf.parseArgs([]).glass).toBe('off')
    expect(perf.parseArgs(['--gate', '--glass=on']).glass).toBe('on')
    expect(() => perf.parseArgs(['--glass=maybe'])).toThrow()
  })
})
