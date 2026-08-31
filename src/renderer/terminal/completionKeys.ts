// F11 자동완성 **키 판정** — "이 키를 우리가 가로챌까, 셸로 그냥 보낼까" 하나만 정한다.
// xterm 배선(TerminalPane)에서 떼어 둔 이유는 검사다: 상태 → 행동이 전부라 DOM 도 pty 도 필요 없다.
//
// 규칙의 뿌리는 하나다 — **앱이 셸의 키를 뺏지 않는다.** 가로채는 것은 자동완성이 그 키의
// 본래 뜻보다 확실히 나을 때뿐이고, 애매하면 셸로 보낸다(R3.8 정책).

/** 키를 누른 순간의 자동완성 상태. 전부 TerminalPane 이 이미 들고 있는 값 그대로다. */
export type CompState = {
  /** KeyboardEvent.key. 수식자(Ctrl·Alt·Shift·⌘)가 눌린 경우는 부르는 쪽에서 이미 걸러 온다. */
  key: string
  /** 고스트가 떠 있나(= 넣을 나머지가 있나). 없으면 우리가 가로챌 것 자체가 없다. */
  ghost: boolean
  /** 지금 목록에 든 후보 수. 2 이상일 때만 목록이 화면에 있다(하나면 고스트만 뜬다). */
  items: number
  /**
   * 사용자가 ↑↓ 로 후보를 **직접 골랐나**.
   *
   * 이것이 `Enter` 가로채기의 유일한 조건이다. 목록은 타이핑하는 동안 **저절로** 뜨므로,
   * 떠 있다는 것만으로 Enter 를 가져가면 사용자가 다 친 명령이 실행되지 않는다 —
   * `ls` 를 치면 히스토리의 `ls -la`·`ls -l` 때문에 목록이 뜨고, Enter 는 `ls` 를 실행하는 대신
   * `ls -la` 를 집어넣는다. 그 다음 Enter 는 **내가 안 친 명령**을 실행한다.
   * 저절로 뜬 것은 저절로 Enter 를 가져가지 않는다 — ↑↓ 로 손을 댔을 때만 목록의 Enter 다.
   */
  chosen: boolean
  /**
   * 커서가 줄 끝인가 — `→` 로 고스트를 받는 유일한 조건.
   * `→` 는 터미널에서 **커서 이동**이라는 본래 뜻이 있다. 줄 가운데서 그것을 뺏으면 오른쪽으로
   * 움직일 방법이 없어진다(fish·zsh-autosuggestions 도 줄 끝에서만 제안을 받는다).
   */
  atLineEnd: boolean
}

/** 'pass' = 우리가 손대지 않는다(셸로 간다). 나머지는 TerminalPane 의 같은 이름 동작. */
export type CompAction = 'accept' | 'next' | 'prev' | 'dismiss' | 'pass'

export function completionKey(s: CompState): CompAction {
  // 고스트가 없으면 Tab 은 셸 자동완성, ESC 는 인터럽트, 방향키는 히스토리 탐색 그대로다.
  if (!s.ghost) return 'pass'
  switch (s.key) {
    case 'Tab':
      return 'accept'
    case 'Escape':
      return 'dismiss' // 가로채는 것을 만들었으면 빠져나갈 문이 있어야 한다
    case 'ArrowRight':
      return s.atLineEnd ? 'accept' : 'pass'
    case 'ArrowDown':
      return s.items > 1 ? 'next' : 'pass'
    case 'ArrowUp':
      return s.items > 1 ? 'prev' : 'pass'
    case 'Enter':
      return s.items > 1 && s.chosen ? 'accept' : 'pass'
    default:
      return 'pass'
  }
}
