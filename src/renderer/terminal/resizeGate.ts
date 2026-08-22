/**
 * 터미널 리사이즈 잠깐 멈춤 — **끄는 동안은 미루고, 놓을 때 한 번**.
 *
 * 왜 필요한가 (2026-08-22 준영님 결정, 제보 14·15):
 * 하단바가 터미널을 **덮는** 대신 **밀어내는** 배치로 돌아왔다. 가려서 프롬프트가 안 보이는 쪽이
 * 더 나쁘기 때문이다. 그런데 밀어내면 경계를 끄는 동안 터미널 높이가 매 프레임 바뀌고,
 * 그때마다 `fit()` → `term.resize()` → pty `resize` IPC 가 나간다. 분할해서 네 칸을 띄워 두면
 * 초당 수백 번이다 — 2026-08-17 에 "덮는 방식"으로 도망갔던 바로 그 이유다.
 *
 * 이 게이트가 그 이유를 없앤다: 끄는 동안 fit 을 **모아 두었다가** 놓을 때 한 번만 흘린다.
 * 화면(하단바·터미널 칸)은 그동안에도 CSS 로 따라 움직인다 — 멈추는 것은 xterm 의 재계산뿐이다.
 *
 * 전역 하나로 두는 이유: 끄는 사람은 하나(하단바 손잡이)이고 영향을 받는 쪽은 열려 있는 모든
 * 터미널이다. 각 TerminalPane 이 "지금 누가 끌고 있나"를 알 방법을 따로 만들 이유가 없다.
 */
let held = 0
/** 밀린 fit 들. 같은 pane 의 콜백은 하나뿐이라(effect 안에서 한 번 만든다) Set 이면 중복이 없다. */
const pending = new Set<() => void>()

/** 리사이즈를 붙든다. 돌려받은 함수를 부르면 풀리고 밀린 것들이 한 번씩 실행된다. */
export function holdTermResize(): () => void {
  held += 1
  let released = false
  return () => {
    if (released) return // 같은 손잡이가 두 번 놓아도 카운트가 음수로 가지 않게
    released = true
    held -= 1
    if (held > 0) return
    const run = [...pending]
    pending.clear()
    for (const f of run) f()
  }
}

/** 지금 해도 되면 바로, 붙들려 있으면 풀릴 때. */
export function whenResizeAllowed(fn: () => void): void {
  if (held > 0) pending.add(fn)
  else fn()
}

/** 테스트용 — 붙들린 상태인지. */
export function isResizeHeld(): boolean {
  return held > 0
}
