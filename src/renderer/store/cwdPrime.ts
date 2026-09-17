import type { Session } from '@shared/types'

/**
 * main 이 아는 cwd 로 **빈 자리만** 채운다 — 순수 함수(검사는 tests/cwdPrime.test.ts).
 *
 * 왜 필요한가(2026-09-17 준영님 제보): 렌더러의 `cwdBy` 는 **OSC7 이벤트로만** 채워져서,
 * 복원 직후에는 비어 있다. 터미널은 저장된 cwd(예: `D:/work`)로 떠 있는데 파일 트리는 그 값을
 * 몰라 홈을 그린다 — **화면 둘이 서로 다른 곳을 가리킨다.**
 *
 * 🔴 **이미 아는 것은 덮지 않는다.** 이벤트로 받은 값이 더 최신이다 — main 에 물어보는 사이에
 * OSC7 이 먼저 닿을 수 있고, 그때 응답이 옛 값으로 되돌리면 **사용자가 방금 `cd` 한 자리가
 * 튕겨 나간다.** 이 규칙이 이 함수의 전부다.
 *
 * 바뀐 게 없으면 **같은 객체를 돌려준다** — 새 객체를 만들면 React 가 헛 렌더를 한 번 돈다.
 */
export function primeCwd(cur: Record<string, string>, list: readonly Session[]): Record<string, string> {
  let changed = false
  const next = { ...cur }
  for (const s of list) {
    if (s.cwd && !next[s.id]) {
      next[s.id] = s.cwd
      changed = true
    }
  }
  return changed ? next : cur
}
