/**
 * 앱이 셸에 **명령 한 줄을 대신 쳐 넣을 때**의 규칙.
 *
 * 2026-08-23 준영님 제보 7번:
 * ```
 * aiservice@kvt:~/data2/vllm$ nvcc --versiontmux new -s 'test'
 * nvcc fatal   : Unknown option '--versiontmux'
 * ```
 * [tmux ▸ 새 세션] 을 눌렀는데 **치다 만 줄 뒤에 그대로 이어붙었다.** `session.input` 은 사람이
 * 타이핑하는 것과 같은 채널이라(그 성질 덕에 su 뒤에도 동작한다) 지금 줄에 무엇이 있든 그 뒤에
 * 붙는다. 화면을 보고 있는 사람에게는 명백하지만 코드는 그 줄을 모른다.
 *
 * 그래서 **보내기 전에 줄을 비운다**: Ctrl+E(줄 끝으로) → Ctrl+U(줄 시작까지 지우기).
 * 둘 다 필요하다 — readline 의 Ctrl+U 는 **커서 앞쪽만** 지우므로, 커서가 줄 중간에 있으면
 * 뒤쪽이 남아 같은 사고가 난다.
 *
 * 지우는 것은 사용자가 치던 글자다. 그래도 이 편이 낫다: 눌린 것은 "이 명령을 실행하라"이고,
 * 그 결과가 뒤섞인 명령이 되는 것보다 화면에서 사라지는 편이 예측 가능하다(실행되지도 않는다).
 * 프롬프트가 아닌 자리(vim·비밀번호 입력 등)에서는 이 두 글자도 그 프로그램이 받는다 — 그런
 * 자리에서 "명령 보내기"를 누르는 것 자체가 성립하지 않으므로 더 방어하지 않는다.
 */
export const CLEAR_LINE = '\x05\x15'

/**
 * 오류 신고 #16(1.0.25): 위 두 글자는 **readline(posix)** 의 키다. PowerShell(PSReadLine 윈도우 모드)·cmd 는
 * 묶여 있지 않아 글자로 들어가 `^E^USet-Location` 이 되고 명령을 못 찾았다. 거기서 줄 비우기는 Esc 하나다
 * (PSReadLine 윈도우 모드 = RevertLine, cmd/conhost = 줄 지우기).
 * 🔴 **Esc 는 따로, 잠깐 뒤에 명령을 보낸다.** 같은 쓰기에 붙이면 ConPTY 가 `ESC W` 를 Alt+W 로 읽어
 * 줄이 안 지워지고 첫 글자를 먹는다(2026-10-13 node-pty + powershell 실측: 붙이면 실패, 80ms 띄우면 성공).
 * ponytail: PSReadLine 을 Emacs 모드로 바꾼 사람에게 Esc 는 Meta 접두다 — 그런 설정이 보이면 그때 셸 설정을 읽는다.
 */
export const CLEAR_LINE_WIN = '\x1b'
export const WIN_CLEAR_GAP_MS = 80

/** 줄을 비우고 명령을 **즉시 실행**한다(개행 포함). posix(원격 셸·tmux) 전용 — 윈도우 셸은 `commandChunks`. */
export function commandLine(command: string): string {
  return CLEAR_LINE + command + '\r'
}

/** 셸에 맞춰 보낼 조각들. 조각 사이는 `WIN_CLEAR_GAP_MS` 를 띄운다(윈도우 셸의 Esc 때문). */
export function commandChunks(command: string, shell: 'posix' | 'powershell' | 'cmd'): string[] {
  return shell === 'posix' ? [commandLine(command)] : [CLEAR_LINE_WIN, command + '\r']
}
