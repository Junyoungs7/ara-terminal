// M15 R2 TM-03 Reset Terminal — 터미널 입력 모드를 바닥 상태로 되돌리는 글(xterm 에 쓴다, 셸에는 안 보낸다).
// 출처: stablyai/orca @ec112c6b01 (MIT) src/shared/terminal-mode-reset-profiles.ts buildProcessBoundaryGround 그대로.
// 쓰임: TUI 가 죽으면서 마우스 추적·bracketed paste·대체 화면·kitty 키보드 같은 모드를 켠 채 남기면 셸에서 클릭이
// 이스케이프 글자로 찍히고 붙여넣기가 이상해진다 — 이 글을 터미널(화면 쪽)에 써서 그 모드들을 끈다. 화면 내용·셸은 그대로.

const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
const RESET_MODIFY_OTHER_KEYS = '\x1b[>4m'
const RESET_GRAPHIC_RENDITION = '\x1b[0m'
const SAVE_GROUNDED_CURSOR = '\x1b7'
const RESET_MOUSE_REPORTING = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'
const RELEASE_SYNCHRONIZED_OUTPUT = '\x1b[?2026l'
// ?1049l 은 정상 화면에서도 커서를 되돌린다 — 먼저 저장한다.
const LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR = `${SAVE_GROUNDED_CURSOR}\x1b[?1049l`
const RESET_LEGACY_MOUSE_ENCODINGS = '\x1b[?1005l\x1b[?1015l'
const RESET_FOCUS_REPORTING = '\x1b[?1004l'
const RESET_BRACKETED_PASTE = '\x1b[?2004l'
const RESET_APPLICATION_CURSOR_AND_KEYPAD = '\x1b[?1l\x1b[?66l'
const SHOW_CURSOR = '\x1b[?25h'

/** keepFocusReporting: Windows ConPTY 는 칸이 사는 동안 ?1004 를 켜 두고 쓴다(Orca 와 같이 로컬 Windows 셸에선 남긴다). */
export function buildProcessBoundaryGround(opts: { keepFocusReporting: boolean }): string {
  const focus = opts.keepFocusReporting ? '' : RESET_FOCUS_REPORTING
  return `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_KITTY_KEYBOARD_PROTOCOL}${LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR}${RESET_MOUSE_REPORTING}${RESET_LEGACY_MOUSE_ENCODINGS}${focus}${RESET_BRACKETED_PASTE}${RESET_APPLICATION_CURSOR_AND_KEYPAD}${SHOW_CURSOR}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}${RESET_MODIFY_OTHER_KEYS}${RESET_GRAPHIC_RENDITION}${SAVE_GROUNDED_CURSOR}`
}
