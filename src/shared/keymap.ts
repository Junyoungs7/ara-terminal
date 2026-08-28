// 단축키 단일 진실 소스 (계획서 §B.8). 치트시트·핸들러가 이 표에서 파생한다.
//
// ── 충돌 정책 (R3.8) ──
// 셸/리드라인이 쓰는 단일 `Ctrl+문자` 조합은 앱이 절대 가로채지 않는다:
//   C 인터럽트 · D EOF · Z 서스펜드 · L 클리어 · R 역검색 · W 단어삭제 · U/K 라인킬 ·
//   A/E 줄 처음·끝 · T transpose · S/Q 흐름제어 · B/F 커서 이동 · \ SIGQUIT.
// 앱 전용 키는 Ctrl+Shift+* / Alt+* / F-키에서만 고른다.
// #67(2026-08-14): 유일한 예외였던 palette.smart(Ctrl+K)가 없어졌다 — 스마트 팔레트를 지우면서
// Ctrl+K 를 리드라인 라인킬로 셸에 돌려줬다. 이제 정책에 예외가 없다.

export type KeymapAction =
  | 'split.horizontal'
  | 'split.vertical'
  | 'pane.close'
  | 'pane.maximize'
  | 'focus.move'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.byNumber'
  | 'session.new'
  | 'session.duplicate'
  | 'terminal.search'
  | 'clipboard.copy'
  | 'clipboard.paste'
  | 'ai.ask'
  | 'ai.toggle'
  | 'voice.toggle'
  | 'ai.cli'
  | 'fileTree.toggle'
  | 'sidebar.collapse'
  | 'preview.toggle'
  | 'explorer.toggle'
  | 'log.save'
  | 'connection.manager'
  | 'terminal.toggle'
  | 'cheatsheet'
  | 'settings.open'
  | 'commandBook.toggle'
  // F31: 통합 검색(커맨드 팔레트) — 앱 전체 기능·프로필을 이름으로 찾는 곳.
  // (#67 이전에는 우클릭 자리의 8칸 격자 palette.smart 가 따로 있어 이름이 헷갈렸다. 지금은 하나다.)
  | 'palette.all'

import { AI_ENTRY, VOICE } from './features'

export type KeymapCategory =
  | 'panel'
  | 'tab'
  | 'search'
  | 'clipboard'
  | 'ai'
  | 'view'
  | 'file'
  | 'connection'
  | 'help'

export type KeyBinding = {
  action: KeymapAction
  category: KeymapCategory
  labelKo: string
  win: string
  mac: string
  // 실제로 핸들러에 배선된 키만 true. 치트시트는 true 인 것만 보여 준다(R2.5) — 눌러도 아무 일도
  // 없는 키를 문서화하지 않기 위해서다. 미구현 기능(F12 로그 저장·F16 AI·터미널 검색)은 false.
  implemented: boolean
}

const ALL_KEYS: readonly KeyBinding[] = [
  { action: 'split.horizontal', category: 'panel', labelKo: '가로 분할', win: 'Ctrl+Shift+-', mac: 'Cmd+Shift+-', implemented: true },
  // Ctrl+\ 단독은 SIGQUIT 다 — Shift 를 얹어 셸에 돌려준다.
  { action: 'split.vertical', category: 'panel', labelKo: '세로 분할', win: 'Ctrl+Shift+\\', mac: 'Cmd+Shift+\\', implemented: true },
  // Ctrl+W 단독은 리드라인 단어 삭제다.
  // 이력(뒤집힌 결정이라 남긴다):
  //  · FB-ui2(FB-0005) 당시엔 detach 였다 — 패널만 빠지고 세션은 탭에 남아 다시 클릭하면 붙었다.
  //    "패널 닫기"라는 라벨이 세션 종료처럼 들린다는 제보에 라벨만 고쳤었다.
  //  · **2026-08-11 준영님 결정으로 뒤집혔다**: "탭을 껐으면 세션도 꺼지고 해당 창도 꺼져야 한다.
  //    다시 붙는 건 없다." 지금은 세션을 실제로 종료한다(MainArea.tsx 의 destroySessions 경로).
  //    그래서 라벨도 종료를 말한다 — danger tint 는 이제 정확하다.
  { action: 'pane.close', category: 'panel', labelKo: '이 칸 닫기(세션 종료)', win: 'Ctrl+Shift+W', mac: 'Cmd+Shift+W', implemented: true },
  { action: 'pane.maximize', category: 'panel', labelKo: '패널 최대화', win: 'Ctrl+Up', mac: 'Cmd+Up', implemented: true },
  { action: 'focus.move', category: 'panel', labelKo: '포커스 이동', win: 'Alt+Arrow', mac: 'Opt+Arrow', implemented: true },
  // Ctrl+]/[ 는 bash 문자검색(Ctrl+]) 과 ESC 별칭(Ctrl+[) 이다. 탭 순환은 Ctrl+Tab 계열로 옮긴다.
  { action: 'tab.next', category: 'tab', labelKo: '다음 탭', win: 'Ctrl+Tab', mac: 'Ctrl+Tab', implemented: true },
  { action: 'tab.prev', category: 'tab', labelKo: '이전 탭', win: 'Ctrl+Shift+Tab', mac: 'Ctrl+Shift+Tab', implemented: true },
  { action: 'tab.byNumber', category: 'tab', labelKo: '탭 번호 이동', win: 'Ctrl+1-9', mac: 'Cmd+1-9', implemented: true },
  { action: 'session.new', category: 'tab', labelKo: '새 세션', win: 'Ctrl+Shift+T', mac: 'Cmd+Shift+T', implemented: true },
  // Ctrl+D 단독은 EOF(셸 종료) 다 — R2 에서 가로챈 것을 셸에 돌려준다.
  { action: 'session.duplicate', category: 'tab', labelKo: '세션 복제', win: 'Ctrl+Shift+D', mac: 'Cmd+Shift+D', implemented: true },
  // Ctrl+F 단독은 리드라인 커서 오른쪽 이동.
  { action: 'terminal.search', category: 'search', labelKo: '터미널 내 검색', win: 'Ctrl+Shift+F', mac: 'Cmd+Shift+F', implemented: true },
  { action: 'clipboard.copy', category: 'clipboard', labelKo: '복사', win: 'Ctrl+Shift+C', mac: 'Cmd+Shift+C', implemented: true },
  { action: 'clipboard.paste', category: 'clipboard', labelKo: '붙여넣기', win: 'Ctrl+Shift+V', mac: 'Cmd+Shift+V', implemented: true },
  // F16(W3): 배선 완료. ai.ask 는 선택 텍스트를 아는 MainArea 가, ai.toggle 은 패널 상태를 가진
  // Shell 이 받는다. 새 조합을 만들지 않고 예약돼 있던 둘을 그대로 켰다 — 치트시트·설정 [단축키]·
  // 메뉴바가 implemented 를 보고 자동으로 따라온다.
  { action: 'ai.ask', category: 'ai', labelKo: 'AI에게 질문', win: 'Ctrl+Shift+A', mac: 'Cmd+Shift+A', implemented: true },
  { action: 'ai.toggle', category: 'ai', labelKo: 'AI 창 토글', win: 'Alt+A', mac: 'Opt+A', implemented: true },
  // 2026-08-27 음성 — Ctrl+Shift+V 는 붙여넣기다. AI 창(Alt+A)과 같은 갈래로 Alt+V 를 쓴다.
  { action: 'voice.toggle', category: 'ai', labelKo: '음성으로 말하기', win: 'Alt+V', mac: 'Opt+V', implemented: true },
  // F27: AI CLI 한 번에 시작. Ctrl+Shift+L(Launch) — 미사용 Ctrl+Shift+* 조합이라 R3.8 정책 그대로다
  // (Ctrl+L 단독은 셸 화면 지우기라 건드리지 않는다).
  { action: 'ai.cli', category: 'ai', labelKo: 'AI CLI 시작', win: 'Ctrl+Shift+L', mac: 'Cmd+Shift+L', implemented: true },
  // Ctrl+B 는 tmux prefix 이자 리드라인 커서 왼쪽 이동이었다. VS Code 탐색기 관례(Ctrl+Shift+E)로 옮기고 배선한다.
  { action: 'fileTree.toggle', category: 'view', labelKo: '파일 트리 토글', win: 'Ctrl+Shift+E', mac: 'Cmd+Shift+E', implemented: true },
  { action: 'sidebar.collapse', category: 'view', labelKo: '사이드바 접기', win: 'Ctrl+Shift+B', mac: 'Cmd+Shift+B', implemented: true },
  // F15 미니 프리뷰(우측 레일). Ctrl+P 단독은 리드라인 이전 명령이라 Shift 를 얹는다.
  { action: 'preview.toggle', category: 'view', labelKo: '미니 프리뷰', win: 'Ctrl+Shift+P', mac: 'Cmd+Shift+P', implemented: true },
  // W4sat F20: 파일 탐색기 전체화면 2패널 모드. Ctrl+O 단독은 리드라인에 바인딩이 없어 자유롭지만
  // R3.8 정책(단일 Ctrl+문자 금지)을 그대로 지켜 Shift 를 얹는다.
  { action: 'explorer.toggle', category: 'view', labelKo: '탐색기 모드', win: 'Ctrl+Shift+O', mac: 'Cmd+Shift+O', implemented: true },
  // Ctrl+S 단독은 터미널 흐름제어(XOFF — 화면이 멈춘 것처럼 보인다).
  // 2026-08-13 감사: `implemented:false` 인데 실제로는 로그 패널의 [내려받기]가 동작했다 —
  // "추후 지원" 토스트만 내고 있었다. 패널을 여는 것으로 배선한다.
  { action: 'log.save', category: 'file', labelKo: '로그 저장', win: 'Ctrl+Shift+S', mac: 'Cmd+Shift+S', implemented: true },
  // Ctrl+Shift+C 는 복사(터미널 표준)로 넘겼다 — 연결 관리자는 M(anager).
  { action: 'connection.manager', category: 'connection', labelKo: '연결 관리자', win: 'Ctrl+Shift+M', mac: 'Cmd+Shift+M', implemented: true },
  { action: 'terminal.toggle', category: 'panel', labelKo: '터미널 토글', win: 'Ctrl+`', mac: 'Cmd+`', implemented: true },
  { action: 'cheatsheet', category: 'help', labelKo: '치트시트', win: '?', mac: '?', implemented: true },
  // R5 설정 창. Ctrl+, 는 셸/리드라인이 쓰지 않는 조합이라 R3.8 충돌 정책 예외가 필요 없다.
  { action: 'settings.open', category: 'view', labelKo: '설정', win: 'Ctrl+,', mac: 'Cmd+,', implemented: true },
  // W3sat F18: 명령어 북(검색형 치트시트). Ctrl+Shift+* 미사용 조합.
  { action: 'commandBook.toggle', category: 'help', labelKo: '명령어 북', win: 'Ctrl+Shift+K', mac: 'Cmd+Shift+K', implemented: true },
  // F31 통합 검색. **Ctrl+Shift+P 가 아니라 F1 이다** — 그 조합은 이미 미니 프리뷰가 쓰고 있고,
  // 쓰던 사람 손버릇을 빼앗을 이유가 없다. F1 은 VS Code 에서도 같은 팔레트를 여는 키이고
  // (Show All Commands), F-키는 셸 충돌 정책이 열어 둔 자리다.
  { action: 'palette.all', category: 'search', labelKo: '통합 검색', win: 'F1', mac: 'F1', implemented: true }
] as const

/**
 * 실제로 쓰는 키 목록. 숨긴 기능의 키는 **여기서 빠진다** — 치트시트·설정 [단축키]·matchBinding 이
 * 전부 이 배열 하나를 보므로, 목록에서 빠지면 눌러도 아무 일이 없고 문서에도 안 나온다
 * (features.AI_ENTRY 참고 — 되살리면 저절로 돌아온다).
 */
export const KEYMAP: readonly KeyBinding[] = ALL_KEYS.filter(
  (k) =>
    (AI_ENTRY || (k.action !== 'ai.ask' && k.action !== 'ai.toggle')) &&
    // 2026-08-28 음성은 숨김 — 치트시트에도 안 뜨고 matchBinding 도 안 걸린다.
    (VOICE || k.action !== 'voice.toggle')
)

// 렌더러 공용 — 단축키 표기(⌘)와 OS 이름이 들어가는 라벨(Finder/탐색기)이 같은 판정을 쓴다.
export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

// KEYMAP 표기(사람이 읽는 쪽) → KeyboardEvent.key 표기. 'Ctrl+Up' 이 'ArrowUp' 과 안 맞아
// 패널 최대화가 죽어 있던 원인(R2.5).
const KEY_ALIAS: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright'
}

// Shift 를 누르면 기호 키의 e.key 가 상단 문자로 바뀐다(- → _, \ → |). 'Ctrl+Shift+-' 같은 표기를
// 실제 이벤트와 맞추려면 두 문자를 모두 인정해야 한다 — 안 그러면 R3.8 재배치가 통째로 죽는다.
// ponytail: US 배열 기준 표. 다른 배열까지 필요해지면 e.code 기반으로 승격.
const SHIFTED: Record<string, string> = { '-': '_', '\\': '|', '[': '{', ']': '}', '`': '~' }

type Combo = { key: string; ctrl: boolean; shift: boolean; alt: boolean }

function parseCombo(combo: string): Combo {
  const parts = combo.split('+')
  const raw = parts[parts.length - 1].toLowerCase()
  return {
    key: KEY_ALIAS[raw] ?? raw,
    ctrl: parts.includes('Ctrl') || parts.includes('Cmd'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt') || parts.includes('Opt')
  }
}

function comboFor(action: KeymapAction): Combo | null {
  const b = KEYMAP.find((k) => k.action === action)
  if (!b) return null
  return parseCombo(isMac() ? b.mac : b.win)
}

function modifiersMatch(e: KeyboardEvent, c: Combo): boolean {
  const primary = isMac() ? e.metaKey : e.ctrlKey
  if (c.ctrl) {
    if (!primary) return false
  } else if (e.ctrlKey || e.metaKey) {
    return false
  }
  return e.shiftKey === c.shift && e.altKey === c.alt
}

// 'Ctrl+1-9' 같은 숫자 범위 표기.
const RANGE = /^(\d)-(\d)$/

// KeyboardEvent가 해당 action의 바인딩과 일치하는지 판정(렌더러 단축키 배선용).
// 단일 키(문자·기호·방향키)만 다룬다. 'Alt+Arrow'(방향 무관)는 matchArrow, 'Ctrl+1-9'는 matchNumber.
export function matchBinding(e: KeyboardEvent, action: KeymapAction): boolean {
  const c = comboFor(action)
  if (!c || c.key === 'arrow' || RANGE.test(c.key)) return false
  if (!modifiersMatch(e, c)) return false
  const k = e.key.toLowerCase()
  return k === c.key || (c.shift && SHIFTED[c.key] === k)
}

// Alt+Arrow(포커스 이동) 등 화살표 조합 판정. 일치하면 방향, 아니면 null.
// KEYMAP 은 화살표를 'Arrow' 로 표기(예: 'Alt+Arrow') — modifier 만 맞으면 실제 방향키를 매핑한다.
export function matchArrow(
  e: KeyboardEvent,
  action: KeymapAction
): 'left' | 'right' | 'up' | 'down' | null {
  const c = comboFor(action)
  if (!c || c.key !== 'arrow') return null
  if (!modifiersMatch(e, c)) return null
  switch (e.key) {
    case 'ArrowLeft':
      return 'left'
    case 'ArrowRight':
      return 'right'
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    default:
      return null
  }
}

// 'Ctrl+1-9'(탭 번호 이동) 판정. 일치하면 눌린 숫자, 아니면 null.
export function matchNumber(e: KeyboardEvent, action: KeymapAction): number | null {
  const c = comboFor(action)
  if (!c) return null
  const range = RANGE.exec(c.key)
  if (!range || !modifiersMatch(e, c)) return null
  if (e.key.length !== 1) return null
  const n = Number(e.key)
  if (!Number.isInteger(n)) return null
  return n >= Number(range[1]) && n <= Number(range[2]) ? n : null
}

// 메뉴바 항목 클릭(R4.1) → 그 액션의 단축키를 실제로 누른 것과 같은 keydown 을 window 에 쏜다.
// 메뉴가 동작을 따로 배선하지 않게 하는 장치다: 실행 경로는 기존 keydown 핸들러(MainArea/Shell)
// 한 곳뿐이라 "메뉴에서만 되는 기능" / "단축키에서만 되는 기능" 이 생길 수 없다.
// 화살표(focus.move)·숫자 범위(tab.byNumber)는 방향/번호가 없으면 뜻이 없어 메뉴에 싣지 않는다.
export function dispatchAction(action: KeymapAction): void {
  const c = comboFor(action)
  if (!c || c.key === 'arrow' || RANGE.test(c.key)) return
  const mac = isMac()
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: c.key,
      ctrlKey: c.ctrl && !mac,
      metaKey: c.ctrl && mac,
      shiftKey: c.shift,
      altKey: c.alt,
      bubbles: true
    })
  )
}

// 터미널(xterm)이 셸로 흘려보내면 안 되는 앱 단축키인지 — attachCustomKeyEventHandler 용.
// 배선된 키만 가로채고 미구현 키는 그대로 셸로 보낸다. R3.8 정책 이후 앱 키는 Ctrl+Shift+*/Alt+*
// 뿐이고 #67 에서 유일한 예외(Ctrl+K)마저 없어졌다 — 단일 Ctrl+문자는 이제 전부 셸로 통과한다.
export function isAppShortcut(e: KeyboardEvent): boolean {
  return KEYMAP.some(
    (b) =>
      b.implemented &&
      (matchBinding(e, b.action) || matchArrow(e, b.action) !== null || matchNumber(e, b.action) !== null)
  )
}
