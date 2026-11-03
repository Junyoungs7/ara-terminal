// P3 R2-A TM-10 테마 라이브러리 — Orca src/shared/terminal-themes 그대로(orcaRef ec112c6b01). 렌더러는 이 묶음을 테마를 고를 때만 지연 로드한다.
import { mergeTerminalThemeCatalogs } from './shared'
import { POPULAR_DARK_CORE_TERMINAL_THEMES } from './popular-dark-core'
import { POPULAR_DARK_EXTENDED_TERMINAL_THEMES } from './popular-dark-extended'

export const POPULAR_DARK_TERMINAL_THEMES = mergeTerminalThemeCatalogs(
  POPULAR_DARK_CORE_TERMINAL_THEMES,
  POPULAR_DARK_EXTENDED_TERMINAL_THEMES
)
