// P3 R2-A TM-10 테마 라이브러리 — Orca src/shared/terminal-themes 그대로(orcaRef ec112c6b01). 렌더러는 이 묶음을 테마를 고를 때만 지연 로드한다.
import type { TerminalThemeMap } from './types'

export function mergeTerminalThemeCatalogs(
  ...catalogs: readonly TerminalThemeMap[]
): TerminalThemeMap {
  const merged: TerminalThemeMap = {}

  for (const catalog of catalogs) {
    for (const [name, theme] of Object.entries(catalog)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`Duplicate terminal theme name: ${name}`)
      }
      merged[name] = theme
    }
  }

  return merged
}
