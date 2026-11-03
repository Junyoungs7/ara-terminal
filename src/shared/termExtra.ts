// P3 R2-A 터미널 3차 설정 한 묶음(workspace.json ui.termExtra) — 렌더러 값은 신뢰 경계 밖이라 읽는 쪽이 termExtraOf 로 클램프한다.
//  · 셸 선택·인자(TM-09)   Orca terminalWindowsShell·terminalDefaultShell·terminalDefaultShellArgs(orcaRef ec112c6b01)
//  · 테마·대비 하한(TM-10)  Orca terminalThemeDark·terminalMinimumContrastRatio(미지정 = 자동: 밝은 배경 4.5 / 어두운 3)
//  · 가져온 테마(TM-11)     Orca terminalCustomThemes(Ghostty·Warp 가져오기)
//  · 인라인 이미지(TM-12)   Orca terminalInlineImages(기본 켬)
//  · OSC 52(TM-14)          Orca terminalAllowOsc52Clipboard — **아라는 기본 꺼짐**(결정 묶음 12)
import { isTerminalBackgroundLight } from './terminalTitleContrast'

/** 셸 프로필. '' = 자동(지금까지의 규칙: PWSH env → powershell.exe, mac/linux 는 $SHELL). 그 밖은 절대 경로(사용자 지정). */
export const BUILTIN_SHELLS = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'git-bash', 'wsl.exe'] as const
export type BuiltinShell = (typeof BUILTIN_SHELLS)[number]

/** 가져온 테마 한 벌 — xterm ITheme 모양(색 이름 → '#rrggbb'). */
export type ThemeColors = Record<string, string>

export type TermExtraPrefs = {
  shell: string
  /** 프로필별 인자(셸 id → argv). 없으면 그 셸의 기본 인자. 주면 기본 인자를 **바꾼다**(Orca terminalDefaultShellArgs 와 같음). */
  shellArgs: Record<string, string[]>
  /** '' = 아라 기본(토큰 팔레트). 그 밖은 라이브러리 이름 또는 'custom:<이름>'. */
  theme: string
  /** null = 자동. 1 = 끔. 1~21. */
  minimumContrastRatio: number | null
  customThemes: Record<string, ThemeColors>
  inlineImages: boolean
  osc52: boolean
}

export const DEFAULT_TERM_EXTRA: TermExtraPrefs = {
  shell: '',
  shellArgs: {},
  theme: '',
  minimumContrastRatio: null,
  customThemes: {},
  inlineImages: true,
  osc52: false
}

export const CUSTOM_THEME_PREFIX = 'custom:'
// Orca terminal-minimum-contrast-settings — xterm 이 받는 범위 1~21. 1 = 고치지 않음.
export const MIN_CONTRAST = 1
export const MAX_CONTRAST = 21
// Orca terminal-contrast-correction — 밝은 배경은 흰 ANSI 글자를 살리려 4.5, 어두운 배경은 진한 색을 씻지 않게 3.
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3

const MAX_ARGS = 32
const MAX_ARG_LEN = 1000
const MAX_PATH_LEN = 500
const MAX_THEMES = 50
const MAX_NAME = 80
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i
const THEME_KEYS = new Set([
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
])

const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max)

export function shellIdOf(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = clean(v, MAX_PATH_LEN)
  if ((BUILTIN_SHELLS as readonly string[]).includes(s)) return s
  // 사용자 지정은 절대 경로만(상대 이름은 실행 위치마다 다른 것을 집는다).
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(s) ? s : ''
}

export function themeColorsOf(v: unknown): ThemeColors | null {
  if (!v || typeof v !== 'object') return null
  const out: ThemeColors = {}
  for (const [k, c] of Object.entries(v as Record<string, unknown>)) if (THEME_KEYS.has(k) && typeof c === 'string' && HEX.test(c)) out[k] = c.toLowerCase()
  return out.background && out.foreground ? out : null
}

export function contrastOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, v))
}

export function termExtraOf(v: unknown): TermExtraPrefs {
  const o = v && typeof v === 'object' ? (v as Partial<Record<keyof TermExtraPrefs, unknown>>) : {}
  const d = DEFAULT_TERM_EXTRA
  const shellArgs: Record<string, string[]> = {}
  if (o.shellArgs && typeof o.shellArgs === 'object') {
    for (const [id, args] of Object.entries(o.shellArgs as Record<string, unknown>)) {
      const sid = shellIdOf(id) || (id === '' ? '' : null)
      if (sid === null || !Array.isArray(args)) continue
      shellArgs[sid] = args.filter((a): a is string => typeof a === 'string').map((a) => a.replace(/[\u0000]/g, '').slice(0, MAX_ARG_LEN)).slice(0, MAX_ARGS)
    }
  }
  const customThemes: Record<string, ThemeColors> = {}
  if (o.customThemes && typeof o.customThemes === 'object') {
    for (const [name, t] of Object.entries(o.customThemes as Record<string, unknown>).slice(0, MAX_THEMES)) {
      const n = clean(name, MAX_NAME)
      const c = themeColorsOf(t)
      if (n && c) customThemes[n] = c
    }
  }
  return {
    shell: shellIdOf(o.shell),
    shellArgs,
    theme: typeof o.theme === 'string' ? clean(o.theme, MAX_NAME + CUSTOM_THEME_PREFIX.length) : d.theme,
    minimumContrastRatio: contrastOf(o.minimumContrastRatio),
    customThemes,
    inlineImages: typeof o.inlineImages === 'boolean' ? o.inlineImages : d.inlineImages,
    // 기본 꺼짐 — true 만 켬.
    osc52: o.osc52 === true
  }
}

/** Orca resolveTerminalMinimumContrastRatio — 설정이 있으면 그 값, 없으면 배경 밝기로 4.5 / 3. */
export function resolveMinimumContrast(background: string | undefined, override: number | null): number {
  if (override !== null) return override
  return isTerminalBackgroundLight(background, { appSurface: 'dark' }) ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST
}

/**
 * 인자 칸 한 줄 → argv. 공백으로 가르고 "…"·'…' 는 한 덩어리(따옴표는 벗긴다). 셸 문법(변수·이스케이프)은 풀지 않는다 —
 * 셸을 거치지 않고 그대로 spawn 인자로 간다.
 */
export function parseShellArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out.slice(0, MAX_ARGS)
}

/** argv → 인자 칸에 보일 한 줄(공백·따옴표가 든 것만 감싼다). parseShellArgs 와 왕복한다. */
export function formatShellArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ')
}

/** TM-11 가져오기 미리 보기 한 벌(main termImport.ts → 설정 화면). [가져오기]를 누르면 colors 가 customThemes[name] 으로 간다. */
export type ImportedTheme = {
  name: string
  colors: ThemeColors
  source: 'ghostty' | 'warp'
  /** 옮기지 않은 키(아라에 없는 설정·풀 수 없는 값). */
  unsupported: string[]
  font?: { family?: string; sizePx?: number }
  cursor?: { style?: 'block' | 'bar' | 'underline'; blink?: boolean }
}
export type ImportResult = { found: boolean; items: ImportedTheme[]; paths: string[]; skipped?: string[]; error?: string }
export type ImportSource = 'ghostty' | 'warp'

/** TM-15 릴리스 채널(결정 묶음 12 "릴리스 채널(사내 베타)"). 'beta' = 사내 베타 피드(beta.yml). 기본 stable. */
export type UpdateChannel = 'stable' | 'beta'
export const updateChannelOf = (v: unknown): UpdateChannel => (v === 'beta' ? 'beta' : 'stable')

/** TM-09 설정 화면 셸 목록 한 줄(main shellProfiles.detectShells). path null = 이 PC 에 없음. */
export type ShellChoice = { id: string; label: string; path: string | null }
