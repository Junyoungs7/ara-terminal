// #80(2026-08-15) — 아라가 한 번에 보내는 **입력**의 상한. 순수 함수만(단위 테스트 대상).
//
// 왜 필요했나: 출력만 16,000 토큰으로 정해져 있었고 입력에는 상한이 아예 없었다.
// `AraSession.turns` 는 지우기 전까지 계속 쌓이고 매 요청마다 통째로 실려 갔으며,
// **옛 턴에 붙은 터미널 출력까지 매번 다시** 갔다. 이 앱은 로그·exec 결과를 붙여 묻는 기능이
// 있어 컨텍스트가 빨리 큰다 — 그대로 두면 모델 한도에 닿아 400 으로 죽는다.
//
// 준영님 결정(2026-08-15): **10만 토큰.** Claude 현세대는 200K 를 받지만 다 쓰면 느리고 비싸다.
// A4 150장쯤이라 실사용에서 부족할 일이 드물다.

/** 입력 토큰 예산. 모르는 모델(자유 입력·타사 프로바이더)도 이 값으로 본다 — 넘겨 잡기보다 낮게. */
export const INPUT_BUDGET_TOKENS = 100_000

// 토큰 추정. 정확한 토크나이저를 붙이지 않는 이유: 프로바이더가 넷이고 각자 토크나이저가 달라
// 정확도를 좇으면 의존성만 늘고 어차피 근사다. **넘겨 잡는 쪽으로만 틀리게** 만든다 —
// 과소평가하면 400 을 맞고, 과대평가하면 대화를 조금 일찍 줄일 뿐이다.
//
// 한글은 영어보다 토큰을 훨씬 많이 먹는다(영어 ~4자/토큰, 한글은 1자당 1토큰에 가깝다).
// 영어 기준 4로 나누면 한국어 대화에서 3~4배 과소평가한다 — 그래서 한글은 따로 센다.
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g

export function estimateTokens(text: string): number {
  if (!text) return 0
  const hangul = text.match(HANGUL)?.length ?? 0
  const rest = text.length - hangul
  // 한글 1자 = 1토큰, 나머지 3자 = 1토큰(영어 4자/토큰보다 보수적).
  return hangul + Math.ceil(rest / 3)
}

/** 예산 계산에 쓰는 한 턴의 모양. AiTurn 을 그대로 받지 않는 이유는 이 파일을 순수하게 두기 위해서다. */
export type BudgetTurn = { role: 'user' | 'assistant'; content: string }

export type TrimResult = {
  /** 실제로 보낼 턴들. */
  kept: BudgetTurn[]
  /** 앞에서 잘라낸 턴 수. 0 이 아니면 화면에 "이전 대화 N개 생략됨"을 띄운다. */
  dropped: number
}

/**
 * 예산 안에 들어오도록 **오래된 턴부터** 버린다.
 *
 * 지키는 것 둘:
 *  · **첫 사용자 턴은 남긴다** — 대개 거기에 과제 정의가 있다. 그것부터 버리면 대화가 길어질수록
 *    모델이 무엇을 하던 중인지 잊는다.
 *  · **마지막 턴은 무조건 남긴다** — 방금 한 질문을 버리면 보낼 이유가 없다. 그 하나가 예산을
 *    넘더라도 보낸다(자르는 것은 turn 단위라 여기서 더 할 수 있는 일이 없다. 첨부 출력은
 *    capContext 가 이미 줄여 놨다).
 *
 * 시스템 프롬프트는 여기 오지 않는다 — 호출부가 예산에서 먼저 빼고 준다.
 */
export function trimToBudget(turns: BudgetTurn[], budget: number): TrimResult {
  if (turns.length === 0) return { kept: [], dropped: 0 }

  const cost = turns.map((t) => estimateTokens(t.content))
  const total = cost.reduce((a, b) => a + b, 0)
  if (total <= budget) return { kept: turns, dropped: 0 }

  const first = turns[0]
  const firstCost = cost[0]
  const last = turns.length - 1

  // 뒤에서부터 담는다(최근 대화가 가장 쓸모 있다). 첫 턴 자리는 미리 떼어 둔다.
  const keepFirst = first.role === 'user' && turns.length > 1
  let room = budget - (keepFirst ? firstCost : 0)
  const tail: BudgetTurn[] = []
  for (let i = last; i >= (keepFirst ? 1 : 0); i--) {
    // 마지막 턴은 예산을 넘겨도 담는다 — 안 보내면 요청 자체가 성립하지 않는다.
    if (i !== last && cost[i] > room) break
    tail.unshift(turns[i])
    room -= cost[i]
  }

  const kept = keepFirst ? [first, ...tail] : tail
  return { kept, dropped: turns.length - kept.length }
}
