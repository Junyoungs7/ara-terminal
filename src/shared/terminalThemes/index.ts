// P3 R2-A TM-10 테마 라이브러리 — Orca src/shared/terminal-themes 그대로(orcaRef ec112c6b01). 렌더러는 이 묶음을 테마를 고를 때만 지연 로드한다.
import { CLASSIC_TERMINAL_THEMES } from './classic'
import { DEFAULT_TERMINAL_THEMES } from './defaults'
import { POPULAR_DARK_TERMINAL_THEMES } from './popular-dark'
import { POPULAR_LIGHT_TERMINAL_THEMES } from './popular-light'
import { mergeTerminalThemeCatalogs } from './shared'
import type { TerminalThemeMap } from './types'

const THEME_CATEGORIES: readonly TerminalThemeMap[] = [
  DEFAULT_TERMINAL_THEMES,
  POPULAR_DARK_TERMINAL_THEMES,
  POPULAR_LIGHT_TERMINAL_THEMES,
  CLASSIC_TERMINAL_THEMES
]

export const TERMINAL_THEME_CATALOG: TerminalThemeMap = mergeTerminalThemeCatalogs(
  ...THEME_CATEGORIES
)
