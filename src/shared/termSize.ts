/**
 * 터미널 치수가 **쓸 만한가** — 저장·복원·pty 에 넘기기 전에 한 번 거른다.
 *
 * 2026-09-28 준영님 제보(#2 오류 신고 — 이 기능으로 들어온 첫 신고다):
 * *"다시 실행 시 세션에서 줄바꿈 — `D:\AI\deadeye` 로 떠야 하는데 `D:\AI\` / `deadeye` 로 접힌다."*
 * 실제 스냅샷을 보니 세션 둘이 **9×4** 로 저장돼 있었다. 1.0.11 에서 복원을 "끌 때의 치수로" 열게
 * 했는데(`Session.cols` 주석), 그 치수는 **리사이즈마다** 기록된다 — 창이 작아진 한순간(최소화 등)의
 * 값이 그대로 저장돼 다음 부팅에 **9칸짜리 pty** 로 되살아났다. 80×24 기본값보다 훨씬 나쁘다.
 *
 * 규칙을 한 곳에 둔다 — 기록하는 곳(main resize) · 복원하는 곳(MainArea) · 여는 곳(PtyBackend·SSH)이
 * 각자 문턱을 정하면 한쪽만 바뀌는 날이 온다.
 *
 * ⚠️ 문턱 20×5: 이보다 좁은 칸에서는 프롬프트 한 줄도 안 들어가 쓸 수가 없다. 사람이 일부러 그렇게
 *    좁힐 일이 없고, 좁혀도 화면(xterm)은 그대로 그 크기로 그린다 — 거르는 것은 **pty 와 저장값**뿐이다.
 */
export const MIN_COLS = 20
export const MIN_ROWS = 5
const MAX = 2000

export function usableSize(cols: unknown, rows: unknown): boolean {
  const ok = (n: unknown, min: number): boolean => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX
  return ok(cols, MIN_COLS) && ok(rows, MIN_ROWS)
}
