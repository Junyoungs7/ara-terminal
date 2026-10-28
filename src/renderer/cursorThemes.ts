import type { MouseCursor } from '@shared/types'

/**
 * 2.0 4단계 — 마우스 커서 테마(설정 › 모양 › 마우스 커서).
 *
 * 적용은 **루트 속성 하나**(`<html data-cursor="mac">`)와 CSS 변수 다섯(`--cur-arrow` 등)이다.
 * CSS 쪽은 `cursor: var(--cur-hand, pointer)` 처럼 표준값을 폴백으로 들고 있어서, 시스템 기본이면
 * 변수가 없고 → 표준값 그대로다(커스텀 규칙이 하나도 안 걸린다). 테마 전용 규칙(본문·입력칸·xterm)은
 * `:root[data-cursor]` 아래에만 산다(shell.css "마우스 커서 테마").
 *
 * SVG 는 시안 `mockups/v2/Z-cursor.html` 의 것을 **그대로** 옮겼다(퍼센트 인코딩 그대로).
 * 값마다 `url(...) x y, <표준값>` — 이미지를 못 그리면 브라우저가 표준 커서로 내려간다.
 * ⚠️ 행 크기 조절(row-resize)·이동·금지·도움말 커서는 시안에 그림이 없어 표준 커서로 남는다.
 */
export const CURSOR_KINDS = ['arrow', 'hand', 'text', 'ew', 'wait'] as const
export type CursorKind = (typeof CURSOR_KINDS)[number]

const FALLBACK: Record<CursorKind, string> = {
  arrow: 'default',
  hand: 'pointer',
  text: 'text',
  ew: 'col-resize',
  wait: 'wait'
}

/** [퍼센트 인코딩된 SVG, 핫스팟 x, y] */
type Shape = [string, number, number]

export const CURSOR_SVGS: Record<Exclude<MouseCursor, 'system'>, Record<CursorKind, Shape>> = {
  mac: {
    arrow: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cdefs%3E%3Cfilter id=%22ms%22 x=%22-40%25%22 y=%22-40%25%22 width=%22180%25%22 height=%22180%25%22%3E%3CfeDropShadow dx=%220%22 dy=%221%22 stdDeviation=%22.9%22 flood-opacity=%22.4%22/%3E%3C/filter%3E%3C/defs%3E%3Cpath d=%22M3 2v17l4.5-4.2 2.9 6.4 2.6-1.2-2.8-6.2h6z%22 fill=%22%23000%22 stroke=%22%23fff%22 stroke-width=%221.3%22 stroke-linejoin=%22round%22 filter=%22url%28%23ms%29%22/%3E%3C/svg%3E', 3, 2],
    hand: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cdefs%3E%3Cfilter id=%22ms%22 x=%22-40%25%22 y=%22-40%25%22 width=%22180%25%22 height=%22180%25%22%3E%3CfeDropShadow dx=%220%22 dy=%221%22 stdDeviation=%22.9%22 flood-opacity=%22.4%22/%3E%3C/filter%3E%3C/defs%3E%3Cpath d=%22M7.5 3.5a1.5 1.5 0 0 1 3 0v6.1a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v5.3a5.5 5.5 0 0 1-5.5 5.5h-.9a5.5 5.5 0 0 1-4.3-2.1l-3.4-4.3a1.4 1.4 0 0 1 2.1-1.8l1.5 1.5z%22 fill=%22%23000%22 stroke=%22%23fff%22 stroke-width=%221.2%22 stroke-linejoin=%22round%22 filter=%22url%28%23ms%29%22/%3E%3Cpath d=%22M10.5 10v3M13 10.8v2.2M15.5 11.6v1.4%22 stroke=%22%23fff%22 stroke-width=%22.8%22 stroke-linecap=%22round%22 opacity=%22.55%22/%3E%3C/svg%3E', 9, 2],
    text: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cdefs%3E%3Cfilter id=%22ms%22 x=%22-40%25%22 y=%22-40%25%22 width=%22180%25%22 height=%22180%25%22%3E%3CfeDropShadow dx=%220%22 dy=%221%22 stdDeviation=%22.9%22 flood-opacity=%22.4%22/%3E%3C/filter%3E%3C/defs%3E%3Cg filter=%22url%28%23ms%29%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M8.5 3.5h1.5a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1.5M12 5.5v13M8.5 20.5h1.5a2 2 0 0 0 2-2 2 2 0 0 0 2 2h1.5M10 12h4%22 stroke=%22%23fff%22 stroke-width=%223.2%22/%3E%3Cpath d=%22M8.5 3.5h1.5a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1.5M12 5.5v13M8.5 20.5h1.5a2 2 0 0 0 2-2 2 2 0 0 0 2 2h1.5M10 12h4%22 stroke=%22%23000%22 stroke-width=%221.4%22/%3E%3C/g%3E%3C/g%3E%3C/svg%3E', 12, 12],
    ew: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cdefs%3E%3Cfilter id=%22ms%22 x=%22-40%25%22 y=%22-40%25%22 width=%22180%25%22 height=%22180%25%22%3E%3CfeDropShadow dx=%220%22 dy=%221%22 stdDeviation=%22.9%22 flood-opacity=%22.4%22/%3E%3C/filter%3E%3C/defs%3E%3Cpath d=%22M1.5 12l5-5v3h11V7l5 5-5 5v-3h-11v3z%22 fill=%22%23000%22 stroke=%22%23fff%22 stroke-width=%221.2%22 stroke-linejoin=%22round%22 filter=%22url%28%23ms%29%22/%3E%3C/svg%3E', 12, 12],
    wait: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cdefs%3E%3Cfilter id=%22ms%22 x=%22-40%25%22 y=%22-40%25%22 width=%22180%25%22 height=%22180%25%22%3E%3CfeDropShadow dx=%220%22 dy=%221%22 stdDeviation=%22.9%22 flood-opacity=%22.4%22/%3E%3C/filter%3E%3C/defs%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227.5%22 fill=%22%23000%22 stroke=%22%23fff%22 stroke-width=%221.2%22 filter=%22url%28%23ms%29%22/%3E%3Cpath d=%22M12 7.5a4.5 4.5 0 0 1 4.5 4.5%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%222%22 stroke-linecap=%22round%22/%3E%3C/svg%3E', 12, 12],
  },
  thin: {
    arrow: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M3 2v17l4.5-4.2 2.9 6.4 2.6-1.2-2.8-6.2h6z%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M3 2v17l4.5-4.2 2.9 6.4 2.6-1.2-2.8-6.2h6z%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 3, 2],
    hand: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M7.5 3.5a1.5 1.5 0 0 1 3 0v6.1a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v5.3a5.5 5.5 0 0 1-5.5 5.5h-.9a5.5 5.5 0 0 1-4.3-2.1l-3.4-4.3a1.4 1.4 0 0 1 2.1-1.8l1.5 1.5z%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M7.5 3.5a1.5 1.5 0 0 1 3 0v6.1a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v5.3a5.5 5.5 0 0 1-5.5 5.5h-.9a5.5 5.5 0 0 1-4.3-2.1l-3.4-4.3a1.4 1.4 0 0 1 2.1-1.8l1.5 1.5z%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 9, 2],
    text: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 12, 12],
    ew: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M1.5 12l5-5v3h11V7l5 5-5 5v-3h-11v3z%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M1.5 12l5-5v3h11V7l5 5-5 5v-3h-11v3z%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 12, 12],
    wait: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227%22 fill=%22none%22 stroke=%22%23fff%22 stroke-opacity=%22.3%22 stroke-width=%221.5%22/%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 5a7 7 0 0 1 7 7%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M12 5a7 7 0 0 1 7 7%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 12, 12],
  },
  dot: {
    arrow: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%225%22 fill=%22%23fff%22 stroke=%22%2315171a%22 stroke-width=%221.5%22/%3E%3C/svg%3E', 12, 12],
    hand: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%229%22 fill=%22%23fff%22 fill-opacity=%22.18%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%229%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/svg%3E', 12, 12],
    text: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Crect x=%2211%22 y=%224%22 width=%222%22 height=%2216%22 rx=%221%22 fill=%22%23fff%22 stroke=%22%2315171a%22 stroke-width=%221%22/%3E%3C/svg%3E', 12, 12],
    ew: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%223.5%22 fill=%22%23fff%22 stroke=%22%2315171a%22 stroke-width=%221.5%22/%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223%22/%3E%3Cpath d=%22M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5%22 stroke=%22%23fff%22 stroke-width=%221.5%22/%3E%3C/g%3E%3C/svg%3E', 12, 12],
    wait: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%226%22 fill=%22none%22 stroke=%22%23fff%22 stroke-opacity=%22.3%22 stroke-width=%222%22/%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 6a6 6 0 0 1 6 6%22 stroke=%22rgba%280,0,0,.35%29%22 stroke-width=%223.5%22/%3E%3Cpath d=%22M12 6a6 6 0 0 1 6 6%22 stroke=%22%23fff%22 stroke-width=%222%22/%3E%3C/g%3E%3C/svg%3E', 12, 12],
  },
  big: {
    arrow: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M3 2v17l4.5-4.2 2.9 6.4 2.6-1.2-2.8-6.2h6z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221.5%22 stroke-linejoin=%22miter%22/%3E%3C/svg%3E', 4, 3],
    hand: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M7.5 3.5a1.5 1.5 0 0 1 3 0v6.1a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v5.3a5.5 5.5 0 0 1-5.5 5.5h-.9a5.5 5.5 0 0 1-4.3-2.1l-3.4-4.3a1.4 1.4 0 0 1 2.1-1.8l1.5 1.5z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221.5%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M10.5 10v3M13 10.8v2.2M15.5 11.6v1.4%22 stroke=%22%23000%22 stroke-width=%22.8%22 stroke-linecap=%22round%22 opacity=%22.5%22/%3E%3C/svg%3E', 13, 3],
    text: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22%23fff%22 stroke-width=%223.4%22/%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22%23000%22 stroke-width=%221.4%22/%3E%3C/g%3E%3C/svg%3E', 18, 18],
    ew: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M1.5 12l5-5v3h11V7l5 5-5 5v-3h-11v3z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221.5%22 stroke-linejoin=%22miter%22/%3E%3C/svg%3E', 18, 18],
    wait: ['%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2236%22 height=%2236%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%224.8%22/%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%222.6%22/%3E%3Cpath d=%22M12 5a7 7 0 0 1 7 7%22 fill=%22none%22 stroke=%22%230078d4%22 stroke-width=%222.6%22/%3E%3C/svg%3E', 18, 18],
  },
}

/**
 * "시스템 기본" 견본 — 표준 Windows 모양을 그린 **그림일 뿐**이다(다듬기 R2: 견본 다섯 칸이 비어 있었다).
 * 실제 커서는 여전히 OS 의 것이다(cursorValue 가 표준 키워드를 준다). 시안 Z-cursor 의 SVG 그대로.
 */
const SYSTEM_SAMPLES: Record<CursorKind, string> = {
  arrow: '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M3 2v17l4.5-4.2 2.9 6.4 2.6-1.2-2.8-6.2h6z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221%22 stroke-linejoin=%22miter%22/%3E%3C/svg%3E',
  hand: '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M7.5 3.5a1.5 1.5 0 0 1 3 0v6.1a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v.8a1.25 1.25 0 0 1 2.5 0v5.3a5.5 5.5 0 0 1-5.5 5.5h-.9a5.5 5.5 0 0 1-4.3-2.1l-3.4-4.3a1.4 1.4 0 0 1 2.1-1.8l1.5 1.5z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M10.5 10v3M13 10.8v2.2M15.5 11.6v1.4%22 stroke=%22%23000%22 stroke-width=%22.8%22 stroke-linecap=%22round%22 opacity=%22.5%22/%3E%3C/svg%3E',
  text: '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cg fill=%22none%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22%23fff%22 stroke-width=%223.4%22/%3E%3Cpath d=%22M9 3.5h6M12 3.5v17M9 20.5h6%22 stroke=%22%23000%22 stroke-width=%221.4%22/%3E%3C/g%3E%3C/svg%3E',
  ew: '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M1.5 12l5-5v3h11V7l5 5-5 5v-3h-11v3z%22 fill=%22%23fff%22 stroke=%22%23000%22 stroke-width=%221%22 stroke-linejoin=%22miter%22/%3E%3C/svg%3E',
  wait: '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%224.8%22/%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%227%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%222.6%22/%3E%3Cpath d=%22M12 5a7 7 0 0 1 7 7%22 fill=%22none%22 stroke=%22%230078d4%22 stroke-width=%222.6%22/%3E%3C/svg%3E',
}

/** 설정 화면 견본용 이미지 주소. */
export const cursorSrc = (theme: MouseCursor, kind: CursorKind): string =>
  'data:image/svg+xml,' + (theme === 'system' ? SYSTEM_SAMPLES[kind] : CURSOR_SVGS[theme][kind][0])

/** CSS `cursor` 값 — 시스템 기본이면 표준 키워드, 아니면 `url(...) x y, <표준값>`. */
export function cursorValue(theme: MouseCursor, kind: CursorKind): string {
  if (theme === 'system') return FALLBACK[kind]
  const [svg, x, y] = CURSOR_SVGS[theme][kind]
  return `url("data:image/svg+xml,${svg}") ${x} ${y}, ${FALLBACK[kind]}`
}

export function applyMouseCursor(theme: MouseCursor): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const k of CURSOR_KINDS) root.style.removeProperty('--cur-' + k)
  if (theme === 'system') {
    delete root.dataset.cursor
    return
  }
  root.dataset.cursor = theme
  for (const k of CURSOR_KINDS) root.style.setProperty('--cur-' + k, cursorValue(theme, k))
}
