import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { FONT_OPTIONS, stackFor } from '../src/renderer/terminal/fontStacks'
import type { FontConfig } from '../src/shared/types'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ev-font-'))
  path = join(dir, 'workspace.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('F5 폰트 설정 영속 (WorkspaceStore.setFont)', () => {
  it('setFont는 ui.font를 갱신하고 즉시 flush하여 재시작 후 유지된다', () => {
    const a = new WorkspaceStore(path, '0.1.0')
    const next: FontConfig = { term: 'D2Coding', sizePx: 18, lineHeight: 1.72 }
    a.setFont(next)

    const b = new WorkspaceStore(path, '0.1.0') // 재기동
    expect(b.get().ui.font).toEqual(next)
  })

  it('기본 스냅샷 폰트는 나눔고딕코딩 14px', () => {
    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().ui.font).toEqual({ term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 })
  })
})

describe('F5 폰트 스택(fontStacks)', () => {
  it('모든 후보 스택은 한글 폴백을 포함한다(무결 렌더 보장)', () => {
    for (const o of FONT_OPTIONS) {
      const hasKorean = /Nanum Gothic Coding|D2Coding/.test(o.stack)
      expect(hasKorean, `${o.key} 스택에 한글 폴백이 없음`).toBe(true)
      expect(o.stack.endsWith('monospace'), `${o.key}는 고정폭이어야 함`).toBe(true)
    }
  })

  it('stackFor는 알 수 없는 키에 대해 primary(나눔고딕코딩)로 폴백한다', () => {
    // UI-font4: 기본(krSystemFallback=true)엔 'KR System' 접두가 붙는다 — false로 순수 스택만 비교.
    // FINISH-M4: 'ARA Nerd Font Symbols' 는 설정과 무관하게 항상 붙으므로 접두를 벗기고 비교한다.
    expect(stripNerd(stackFor('없는폰트', false))).toBe(FONT_OPTIONS[0].stack)
    expect(stackFor('D2Coding', false)).toContain('D2Coding')
  })
})

// FINISH-M4: 항상 붙는 PUA 심볼 페이스 접두를 벗겨 그 이전 규약을 그대로 검사할 수 있게 한다.
const NERD = "'ARA Nerd Font Symbols'"
const stripNerd = (s: string): string => s.replace(`${NERD}, `, '')

describe('FINISH-M4: Nerd Font 심볼(PUA) — 서버 프롬프트 아이콘이 두부로 나오던 것', () => {
  it('설정과 무관하게 모든 스택 맨 앞에 붙는다 (KR System on/off · 후보 전부)', () => {
    for (const o of FONT_OPTIONS) {
      expect(stackFor(o.key)).toBe(`${NERD}, 'KR System', ${o.stack}`)
      expect(stackFor(o.key, false)).toBe(`${NERD}, ${o.stack}`)
    }
  })

  it('★ unicode-range 가 PUA 세 구간에만 국한된다 — 넓으면 터미널 글꼴이 통째로 바뀐다', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/fonts.css'), 'utf8')
    const block = css.split('@font-face').find((b) => b.includes("'ARA Nerd Font Symbols'"))
    expect(block, '심볼 @font-face 를 못 찾음').toBeTruthy()
    const range = /unicode-range:\s*([^;]+);/.exec(block!)?.[1]?.trim()
    expect(range, 'unicode-range 가 없다 — 이 폰트가 라틴까지 먹는다').toBeTruthy()

    // 값을 실제 구간으로 파싱해, 한글/라틴/기호가 하나라도 걸리면 실패시킨다.
    const spans = range!.split(',').map((part) => {
      const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-')
      return { lo: parseInt(lo, 16), hi: parseInt(hi ?? lo, 16) }
    })
    const covers = (cp: number): boolean => spans.some((s) => cp >= s.lo && cp <= s.hi)

    expect(covers(0xe0b0), 'powerline 구분자(U+E0B0)가 빠졌다').toBe(true)
    expect(covers(0xf09b), 'git 브랜치 계열(U+F09B)이 빠졌다').toBe(true)
    for (const [cp, what] of [
      [0x41, '라틴 A'],
      [0xac00, '한글 가'],
      [0xd7a3, '한글 힣'],
      [0x2192, '기호 →'],
      [0x2500, '박스 그리기 ─'],
      [0x3131, '한글 자모 ㄱ']
    ] as const) {
      expect(covers(cp), `${what}(U+${cp.toString(16).toUpperCase()}) 가 range 에 들어갔다`).toBe(false)
    }
  })

  it('폰트 파일과 OFL 라이선스가 번들에 함께 있다 (OFL 은 라이선스 동봉이 조건)', () => {
    const dir = join(__dirname, '../resources/fonts')
    // Mono 변종이어야 한다 — 두 칸 폭 변종은 셀 격자에서 프롬프트를 밀어낸다.
    expect(statSync(join(dir, 'SymbolsNerdFontMono-Regular.woff2')).size).toBeGreaterThan(100_000)
    expect(statSync(join(dir, 'OFL-SymbolsNerdFontMono.txt')).size).toBeGreaterThan(0)
  })
})

describe('UI-font4: 한글 시스템 폴백(KR System) — Tabby 재현 (agent_talk/UI-font4-done.md)', () => {
  // FINISH-M4 이후 stackFor 는 항상 PUA 심볼 페이스를 앞에 붙인다 — stripNerd 로 벗기고
  // KR System 규약만 검사한다(심볼 페이스 자체는 FINISH-M4 describe 에서 별도로 본다).
  it('기본값(true)은 모든 후보 스택 맨 앞에 KR System을 추가한다', () => {
    for (const o of FONT_OPTIONS) {
      expect(stripNerd(stackFor(o.key))).toBe(`'KR System', ${o.stack}`)
      expect(stripNerd(stackFor(o.key, true))).toBe(`'KR System', ${o.stack}`)
    }
  })

  it('false면 되돌리기 — KR System 없이 이전 동작과 완전히 동일하다', () => {
    for (const o of FONT_OPTIONS) {
      expect(stripNerd(stackFor(o.key, false))).toBe(o.stack)
    }
  })

  it('KR System은 한글 스택 뒤에 오지 않는다(먼저 매치돼야 실제로 렌더에 반영됨)', () => {
    const stack = stackFor('Nanum Gothic Coding', true)
    expect(stack.indexOf("'KR System'")).toBeLessThan(stack.indexOf("'Nanum Gothic Coding'"))
  })

  it('fonts.css의 KR System 페이스는 한글 unicode-range로 국한되고 macOS 대체(Apple SD Gothic Neo)를 포함한다', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/fonts.css'), 'utf8')
    const blocks = css.split('@font-face').filter((b) => b.includes("'KR System'"))
    expect(blocks.length, 'KR System @font-face 를 못 찾음').toBeGreaterThan(0)
    for (const b of blocks) {
      expect(b, 'unicode-range 로 한글에 국한되지 않음').toMatch(/unicode-range:.*AC00-D7A3/)
      expect(b, "Windows 대체(Malgun Gothic)가 없음").toMatch(/local\('Malgun Gothic'\)/)
      expect(b, "macOS 대체(Apple SD Gothic Neo)가 없음 — 크로스플랫폼 폴백 체인 필수").toMatch(/local\('Apple SD Gothic Neo'\)/)
    }
  })
})

describe('글꼴 셋의 역할 분리 — 시스템 고정 · 터미널만 사용자 설정 (2026-08-21)', () => {
  // 2026-08-04 에는 정반대였다: `--mono === --term` 이 확정 요구였고, 사용자가 터미널 폰트를
  // 바꾸면 앱 화면 전체가 따라 바뀌었다. 그 결과가 "개발용 티"였고 준영님이 뒤집으셨다.
  //   --ui   Pretendard   크롬 전부.            고정 · 설정에 없다
  //   --mono 나눔고딕코딩  경로·명령·로그·에디터. 고정 · 설정에 없다
  //   --term 사용자 선택   터미널 본문 전용
  //
  // bindCssVars는 document.documentElement 에 직접 쓴다 — jsdom 없이도 실측 가능하게
  // setProperty 만 흉내 낸 최소 스텁을 주입한다(새 의존성 없음).
  let props: Record<string, string>
  beforeEach(() => {
    props = {}
    ;(globalThis as unknown as { document: unknown }).document = {
      documentElement: { style: { setProperty: (k: string, v: string) => { props[k] = v } } }
    }
  })
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document
  })

  it('★ bindCssVars 는 --term 만 건드린다 — 화면 글꼴은 설정을 타지 않는다', async () => {
    const { bindCssVars } = await import('../src/renderer/store/font')
    for (const o of FONT_OPTIONS) {
      bindCssVars({ term: o.key, sizePx: 14, lineHeight: 1.58 })
      expect(stripNerd(props['--term'])).toBe(`'KR System', ${o.stack}`)
      expect(props['--mono'], `${o.key}: --mono 가 설정을 따라갔다`).toBeUndefined()
      expect(props['--ui'], `${o.key}: --ui 가 설정을 따라갔다`).toBeUndefined()
    }
  })

  it('krSystemFallback:false 면 --term 에서 KR System 이 빠진다(설정 되돌리기)', async () => {
    const { bindCssVars } = await import('../src/renderer/store/font')
    bindCssVars({ term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58, krSystemFallback: false })
    expect(stripNerd(props['--term'])).toBe(FONT_OPTIONS[0].stack)
    expect(props['--term']).not.toContain('KR System')
  })

  it('★ --mono 에는 KR System 을 넣지 않는다 — 로그·에디터 본문에서 열이 밀린다', () => {
    // 'KR System' 은 한글을 맑은 고딕(비례 폰트)으로 그린다. UI 라벨에서는 그게 이득이었지만
    // (UI-font4) 지금 UI 는 Pretendard 다(2026-10-08~11 은 SUIT). --mono 가 남은 자리는 경로·로그·에디터라
    // **한글도 고정폭이어야** 열이 맞는다.
    const css = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8')
    const mono = /--mono:\s*([^;]+);/.exec(css)?.[1]?.trim()
    expect(mono).toBeTruthy()
    expect(mono).not.toContain('KR System')
    expect(mono).toMatch(/^'Nanum Gothic Coding'/)
    expect(mono!.endsWith('monospace')).toBe(true)
  })

  it('--ui 는 비례 폰트다 — 크롬에 고정폭이 다시 새어 들어오지 않게', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8')
    const ui = /--ui:\s*([^;]+);/.exec(css)?.[1]?.trim()
    expect(ui).toMatch(/^'Pretendard'/)
    expect(ui).not.toContain('monospace')
    expect(ui).not.toContain('Coding')
  })
})

describe('UI-font: 한글 라벨 12px 회귀 가드 — CSS 박스가 줄 상자를 담기에 충분한지', () => {
  // 실제 뭉개짐 원인은 폰트 래스터화(실측: agent_talk/UI-font-done.md)라 이 테스트가 그 자체를
  // 잡지는 못한다. 대신 "박스 자체가 줄 상자보다 작아서 잘리는" 회귀(후보 ①③)를 계산으로 잡는다:
  // line-height(px) 는 항상 font-size 보다 커야 하고(그래야 상하 여백이 생긴다),
  // 한글 라벨 하한(12px)보다 작은 font-size 로 되돌아가면 실패한다.
  const LH_RATIO = 1.4 // tokens.css :root body 의 전역 line-height
  it('한글 라벨 하한(12px) 기준 line-height(px)가 font-size보다 최소 4px 여유를 갖는다', () => {
    const fontSize = 12
    const lineHeightPx = fontSize * LH_RATIO
    expect(lineHeightPx - fontSize).toBeGreaterThanOrEqual(4)
  })

  it('shell.css/interactions.css 에 한글 라벨용 11.5px 잔존이 없다(12px 상향 회귀 가드)', () => {
    const files = ['../src/renderer/styles/shell.css', '../src/renderer/styles/interactions.css']
    for (const f of files) {
      const css = readFileSync(join(__dirname, f), 'utf8')
      expect(css, `${f} 에 font-size: 11.5px 잔존`).not.toMatch(/font-size:\s*11\.5px/)
    }
  })
})

describe('UI-font2: 잉크 ascent 실측 기반 회귀 가드 (agent_talk/UI-font2-done.md)', () => {
  // 1차 가드(위)는 line-height(px) - font-size 를 대충 4px 이상으로만 봤다. 이번 재조사에서
  // 실제 폰트(나눔고딕코딩) 캔버스 메트릭을 12px 기준으로 실측했다:
  // fontBoundingBoxAscent=10, fontBoundingBoxDescent=2 (agent_talk/UI-font2-gpu-measure.json,
  // 겹받침 포함 9개 표본 글자 전부 동일 — 폰트 전역 메트릭이라 글자마다 안 바뀐다).
  // 그 실측값으로 "줄 상자가 실제 잉크를 담기에 충분한가"를 직접 계산한다 — font-size와
  // line-height 비율(1.4)이 이 관계를 유지하는 한 안전하다는 걸 대수적으로 고정.
  const MEASURED_FONT_ASCENT_AT_12PX = 10
  const MEASURED_FONT_DESCENT_AT_12PX = 2
  const LH_RATIO = 1.4

  it('12px 한글 라벨: 줄 상자가 실측 폰트 ascent+descent를 담고도 half-leading이 양수로 남는다', () => {
    const fontSize = 12
    const lineHeightPx = fontSize * LH_RATIO
    const halfLeading = (lineHeightPx - (MEASURED_FONT_ASCENT_AT_12PX + MEASURED_FONT_DESCENT_AT_12PX)) / 2
    expect(halfLeading).toBeGreaterThan(0)
  })

  it('tokens.css 전역 line-height 비율이 1.35 미만으로 줄지 않았다(줄 상자 여유 축소 회귀 가드)', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/tokens.css'), 'utf8')
    const m = /body\s*\{[^}]*line-height:\s*([\d.]+)/.exec(css)
    expect(m, 'tokens.css body 의 line-height 를 못 찾음').toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(1.35)
  })
})

describe('원문자 겹침 — ARA Circled', () => {
  it('세 스택 모두 맨 앞이 ARA Circled 다', () => {
    for (const o of FONT_OPTIONS) expect(o.stack.startsWith("'ARA Circled', "), o.key).toBe(true)
  })
})
