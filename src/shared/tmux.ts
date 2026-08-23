// F19 tmux 헬퍼 — 원격 tmux 사용을 GUI 로 보조하는 **입력 매크로**. tmux 프로토콜을 파싱하지 않는다:
// 여기서 만드는 것은 터미널에 보낼 문자열뿐이고, 결과(성공·오류 메시지·"command not found")는
// 그 터미널 화면에 그대로 나타난다 — 조용히 사라지는 오류가 없다는 요구사항을 화면 자체가 만족한다.
//
// new/list/attach 는 사용자가 실제로 실행할 명령줄이라(cdCommand 와 같은 판단으로) 개행(\r)을
// 붙여 즉시 실행한다. detach/창 전환은 명령이 아니라 **키 조합 전송**이라 개행이 없다 — tmux 기본
// prefix Ctrl+b(\x02) 뒤에 키 하나를 그대로 흘려보낸다(F16 [터미널로 보내기]의 "삽입만" 규칙과는
// 무관하다 — 그건 AI 가 지어낸 명령을 사용자 확인 없이 실행하지 못하게 막는 규칙이고, 여기 다섯
// 액션은 전부 이 파일이 고정한 것들이라 사용자가 버튼을 누르는 제스처 자체가 확인이다).

import { commandLine } from './shellInput'

export type TmuxAction =
  | { kind: 'new'; name: string }
  | { kind: 'list' }
  | { kind: 'attach'; name: string }
  | { kind: 'detach' }
  | { kind: 'nextWindow' }
  | { kind: 'prevWindow' }

// tmux 세션 이름 검증: 빈 값·줄바꿈만 막는다(그 외엔 quoteShellArg 가 셸 특수문자를 전부 감싼다).
export function isValidTmuxName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !/[\r\n]/.test(trimmed)
}

// POSIX 셸 단일 인용 — 원격 세션은 리눅스 셸이 대상이다(F19 는 SSH 세션 전용). 작은따옴표 안에서는
// 백슬래시도 특별하지 않으므로 내부 작은따옴표만 '\'' 로 끊어 이어붙이면 임의의 문자열이 안전하다.
export function quoteShellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// tmux 기본 prefix. 커스텀 prefix(.tmux.conf 재정의)까지는 다루지 않는다 — 그건 서버 설정을
// 읽어야 하는 일이라 "입력 매크로 수준"을 넘는다.
const PREFIX = '\x02' // Ctrl+b

// 액션 → 터미널에 보낼 문자열. 이름이 필요한 액션에 빈/줄바꿈 이름이 오면 null(호출측이 취소로 처리).
export function buildTmuxInput(action: TmuxAction): string | null {
  switch (action.kind) {
    // 명령 셋은 **줄을 비우고** 나간다(commandLine — 2026-08-23 제보 7번: 치던 줄에 이어붙었다).
    // 아래 키 조합 셋에는 안 붙인다: 그것들은 명령이 아니라 tmux prefix 키라 줄과 무관하고,
    // 오히려 줄을 지우면 쓰던 입력만 잃는다.
    case 'new':
      return isValidTmuxName(action.name) ? commandLine(`tmux new -s ${quoteShellArg(action.name.trim())}`) : null
    case 'list':
      return commandLine('tmux ls')
    case 'attach':
      return isValidTmuxName(action.name) ? commandLine(`tmux a -t ${quoteShellArg(action.name.trim())}`) : null
    case 'detach':
      return `${PREFIX}d`
    case 'nextWindow':
      return `${PREFIX}n`
    case 'prevWindow':
      return `${PREFIX}p`
  }
}
