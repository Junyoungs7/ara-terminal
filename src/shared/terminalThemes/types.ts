// P3 R2-A TM-10 테마 라이브러리 — Orca src/shared/terminal-themes 그대로(orcaRef ec112c6b01). 렌더러는 이 묶음을 테마를 고를 때만 지연 로드한다.
import type { ITheme } from '@xterm/xterm'

export type TerminalThemeMap = Record<string, ITheme>
