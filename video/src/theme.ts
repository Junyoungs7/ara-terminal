/**
 * 영상 팔레트 — 제품 토큰(src/renderer/styles/tokens.css)과 같은 값이다.
 * 영상이 제품과 다른 색을 쓰면 "이 화면이 그 앱 맞나" 하는 순간이 생긴다.
 */
export const C = {
  abyss: '#171618',
  canvas: '#1e1e20',
  surface: '#242327',
  raised: '#2b2a2f',
  overlay: '#343338',
  terminal: '#19181a',

  line: 'rgba(255,255,255,.05)',
  lineStrong: 'rgba(255,255,255,.09)',

  hi: '#e0dfde',
  mid: '#aaa8a5',
  lo: '#8f8d88',
  dim: '#797772',

  accent: '#c9a26d',
  accentBright: '#d8bc96',
  accentDeep: '#b68543',
  glow: 'rgba(201,162,109,.15)',
  accentLine: 'rgba(201,162,109,.4)',

  ok: '#8faa8b',
  warn: '#d0b072',
  err: '#c1786e',
  info: '#7f9dc4'
} as const

export const UI = "'Pretendard', 'Malgun Gothic', sans-serif"
export const MONO = "'D2Coding', Consolas, monospace"

export const FPS = 30
export const W = 1920
export const H = 1080

/**
 * 창 목업의 좌표표 — **한 곳에서만 정한다.**
 * 강조(스포트라이트)가 이 값을 그대로 읽어 사각형을 그리므로, 레이아웃을 바꾸면 강조도 같이 따라온다.
 */
export const L = {
  win: { x: 150, y: 132, w: 1620, h: 800, r: 18 },
  titlebar: 46,
  sidebar: 288,
  rail: 58,
  tabs: 42,
  status: 30,
  bottom: 268
} as const

/** 강조할 수 있는 자리. `spot()` 이 이름을 사각형으로 바꾼다. */
export type Region = 'sidebar' | 'tabs' | 'term' | 'bottom' | 'rail' | 'titlebar' | 'status' | 'win'

export function spot(region: Region): { x: number; y: number; w: number; h: number } {
  const { win, titlebar, sidebar, rail, tabs, status, bottom } = L
  const mainX = win.x + sidebar
  const mainW = win.w - sidebar - rail
  const bodyY = win.y + titlebar
  const bodyH = win.h - titlebar
  switch (region) {
    case 'titlebar':
      return { x: win.x, y: win.y, w: win.w, h: titlebar }
    case 'sidebar':
      return { x: win.x, y: bodyY, w: sidebar, h: bodyH }
    case 'rail':
      return { x: win.x + win.w - rail, y: bodyY, w: rail, h: bodyH }
    case 'tabs':
      return { x: mainX, y: bodyY, w: mainW, h: tabs }
    case 'term':
      return { x: mainX, y: bodyY + tabs, w: mainW, h: bodyH - tabs - status - bottom }
    case 'bottom':
      return { x: mainX, y: bodyY + bodyH - status - bottom, w: mainW, h: bottom }
    case 'status':
      return { x: win.x, y: win.y + win.h - status, w: win.w, h: status }
    default:
      return { x: win.x, y: win.y, w: win.w, h: win.h }
  }
}
