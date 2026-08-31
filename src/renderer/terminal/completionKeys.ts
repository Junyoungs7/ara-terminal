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
    /**
     * 목록이 떠 있으면 `Enter` 는 **고르기**다 — 실행이 아니다(2026-08-31 준영님 결정, IDE 감각).
     *
     * 대가를 알고 고른 것이라 여기 적어 둔다. 목록은 타이핑하는 동안 **저절로** 뜨므로,
     * 히스토리에 `ls -la`·`ls -l` 이 있으면 **`ls` 를 치는 순간 목록이 뜬다.** 그 상태의 `Enter`
     * 는 `ls` 를 실행하지 않고 `ls -la` 를 줄에 넣는다 — **친 그대로 실행하려면 `Esc` 로 목록을
     * 먼저 닫아야 한다.** 그것이 이 동작의 탈출구이고, 안내 문구(`term.comp.hint`)가 `Esc` 를
     * 맨 앞에 두는 이유다.
     *
     * ⚠️ 그러니 `Esc` 를 절대 막지 마라 — 막으면 다 친 명령을 실행할 길이 없어진다.
     * 되돌리려면(= 저절로 뜬 목록은 Enter 를 안 가져가게) `&& s.chosen`(사용자가 ↑↓ 로 골랐나)
     * 한 조각을 되살리면 된다. 그 판단은 이미 한 번 내려졌다 — 되돌리기 전에 준영님께 물어라.
     */
    case 'Enter':
      return s.items > 1 ? 'accept' : 'pass'
    default:
      return 'pass'
  }
}
