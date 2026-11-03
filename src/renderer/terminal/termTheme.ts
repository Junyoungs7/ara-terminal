// P3 R2-A TM-10 테마 라이브러리·대비 하한 — xterm 테마를 고르는 곳 하나.
//  · '' = 아라 기본: tokens.css 변수에서 파생한 팔레트(ansiTheme). 글라스는 터미널을 불투명으로 두므로(styles/glass.css "불투명" 층)
//    라이브러리 테마는 xterm 과 그 칸(.term-pane) 배경에만 닿는다 — --gl-*·--sig-*·--sel-bg 같은 글라스 토큰은 건드리지 않는다.
//  · 라이브러리 이름 = Orca 카탈로그(shared/terminalThemes, 약 800줄)는 **고를 때만** 지연 로드한다. 처음 그리는 순간 아직 안 왔으면
//    기본 팔레트로 그리고 도착하면 바꾼다(한 번뿐 — 그 뒤로는 캐시).
//  · 'custom:<이름>' = Ghostty·Warp 에서 가져온 것(termExtra.customThemes).
//  · 대비 하한: Orca 와 같게 xterm minimumContrastRatio. 미지정 = 배경 밝기로 4.5 / 3.
import type { ITheme, Terminal } from '@xterm/xterm'
import { CUSTOM_THEME_PREFIX, resolveMinimumContrast, type TermExtraPrefs } from '@shared/termExtra'

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// R3.5 ANSI 16색 — design-system §1.6 팔레트를 xterm 테마로 옮긴다. 8 normal 은 문서의 토큰 그대로,
// 8 bright 는 같은 색상의 밝은 파생(--t-*-b)이다. black/white 는 표면·텍스트 토큰을 재사용해
// 터미널 배경과 한 계열로 유지한다. 2.0: 전경은 --text-hi, white(7)는 --t-fg — 시안 Z-final 의 ANSI 16색. 폴백 HEX 는 CSS 가 아직 없는 순간(테스트 하네스)용 최후 수단.
// (P3 R2-A 에 TerminalPane 에서 그대로 옮겼다.)
export function ansiTheme(): ITheme {
  const v = (name: string, fallback: string) => readVar(name) || fallback
  return {
    background: v('--bg-terminal', '#15171a'),
    foreground: v('--text-hi', '#e4e7eb'),
    cursor: v('--accent', '#3d9bff'),
    // 커서 위 글자색 — 배경과 같게 둬야 블록 커서 안 글자가 읽힌다.
    cursorAccent: v('--bg-terminal', '#15171a'),
    selectionBackground: v('--sel-bg', 'rgba(61,155,255,0.25)'),
    selectionForeground: v('--text-hi', '#e4e7eb'),
    black: v('--t-black', '#1d2024'),
    red: v('--t-red', '#e0766e'),
    green: v('--t-green', '#6bbf8a'),
    yellow: v('--t-yellow', '#e2c35f'),
    blue: v('--t-blue', '#3d9bff'),
    magenta: v('--t-purple', '#c08cf0'),
    cyan: v('--t-cyan', '#4fc4d0'),
    white: v('--t-fg', '#b2b9c1'),
    brightBlack: v('--t-gray', '#5c6570'),
    brightRed: v('--t-red-b', '#ff8f86'),
    brightGreen: v('--t-green-b', '#86d9a3'),
    brightYellow: v('--t-yellow-b', '#f2d27a'),
    brightBlue: v('--t-blue-b', '#74b6ff'),
    brightMagenta: v('--t-purple-b', '#d8acff'),
    brightCyan: v('--t-cyan-b', '#7fe0e9'),
    brightWhite: v('--text-hi', '#e4e7eb')
  }
}

type Catalog = Record<string, ITheme>
let catalog: Catalog | null = null
let loading: Promise<Catalog> | null = null

/** Orca 테마 카탈로그(지연 로드, 한 번). 설정 화면 목록도 이걸 쓴다. */
export function loadThemeCatalog(): Promise<Catalog> {
  if (catalog) return Promise.resolve(catalog)
  loading ??= import('@shared/terminalThemes/index').then((m) => (catalog = m.TERMINAL_THEME_CATALOG))
  return loading
}

/** 고른 테마. null = 아직 카탈로그가 없다(부르는 쪽이 기본으로 그리고 loadThemeCatalog 뒤에 다시). 모르는 이름은 기본. */
export function pickTheme(extra: TermExtraPrefs): ITheme | null {
  const id = extra.theme
  if (!id) return ansiTheme()
  if (id.startsWith(CUSTOM_THEME_PREFIX)) {
    const c = extra.customThemes[id.slice(CUSTOM_THEME_PREFIX.length)]
    return c ? { ...c } : ansiTheme()
  }
  if (!catalog) return null
  return catalog[id] ?? ansiTheme()
}

/** 한 xterm 에 테마·대비 하한을 입힌다. host = .term-pane(xterm 패딩 둘레가 같은 배경이 되게 — 아라 기본이면 CSS 로 돌려준다). */
const lastAsked = new WeakMap<Terminal, TermExtraPrefs>()
export function applyTermTheme(term: Terminal, host: HTMLElement | undefined, extra: TermExtraPrefs): void {
  lastAsked.set(term, extra)
  const put = (theme: ITheme): void => {
    term.options.theme = theme
    term.options.minimumContrastRatio = resolveMinimumContrast(theme.background, extra.minimumContrastRatio)
    if (host) host.style.background = extra.theme ? (theme.background ?? '') : ''
  }
  const now = pickTheme(extra)
  if (now) return put(now)
  put(ansiTheme())
  void loadThemeCatalog().then(() => {
    // 그 사이 다른 테마를 골랐으면 늦게 온 옛 선택을 덮지 않는다.
    const later = lastAsked.get(term) === extra ? pickTheme(extra) : null
    if (later) put(later)
  })
}
