/**
 * 켤 때 뜨는 한 줄(#139b) — 준영님: *"다양한 문구를 랜덤으로. 어쩔 때는 명언, 어쩔 때는 반가움, 인사."*
 *
 * **순수 함수다.** 무작위와 시각을 인자로 받는다 — 그래야 "같은 줄이 두 번 안 나온다" 같은 규칙을
 * 화면 없이 시험할 수 있다(안 그러면 눈으로 스무 번 켜 보는 수밖에 없다).
 *
 * **출처를 지어내지 않는다.** 명언은 출처가 분명한 것만 담았다. 널리 쓰이지만 누가 했는지
 * 애매한 말(예: "단순함은 궁극의 정교함이다")은 뺐다 — 매일 뜨는 화면에 틀린 출처를 박아 두면
 * 그게 사내에 그대로 퍼진다. 출처가 없는 것은 **속담**으로만 넣는다.
 */

export type Greet = {
  /** 화면에 뜰 한 줄. `{n}` 은 호칭으로 바뀐다. */
  text: string
  /** 명언일 때만. 없으면 안 그린다. */
  by?: string
}

/**
 * 인사 — 시각을 탄다. 새벽 세 시에 "좋은 아침"이면 화면이 사람을 안 보고 있는 것이다.
 * 시간대마다 **여러 개**를 둔다: 하나뿐이면 아침마다 같은 줄이라 "랜덤"이 무색해진다.
 */
const HELLO: readonly { from: number; to: number; lines: readonly string[] }[] = [
  { from: 5, to: 11, lines: ['좋은 아침입니다, {n}', '{n}, 오늘 첫 항해입니다', '이른 시간이네요, {n}'] },
  { from: 12, to: 13, lines: ['점심 잘 드셨습니까, {n}', '{n}, 오후 시작하시죠'] },
  { from: 14, to: 17, lines: ['오후도 힘내시죠, {n}', '{n}, 어디까지 하셨죠?', '{n}, 이어서 가시죠'] },
  { from: 18, to: 21, lines: ['수고 많으셨습니다, {n}', '{n}, 오늘은 여기까지일까요?', '저녁입니다, {n}'] },
  { from: 22, to: 23, lines: ['늦게까지 고생이 많으십니다, {n}', '{n}, 무리하지 마시고요'] },
  { from: 0, to: 4, lines: ['아직 안 주무셨군요, {n}', '{n}, 새벽입니다', '조용한 시간이네요, {n}'] }
]

/** 반가움 — 시각과 무관하게 아무 때나. */
const GLAD: readonly string[] = [
  'Welcome, {n}',
  '{n}, 다시 오셨군요',
  '{n}, 준비됐습니다',
  '어서 오세요, {n}',
  '{n}, 오늘도 함께하죠',
  '기다리고 있었습니다, {n}',
  '{n}, 무엇부터 볼까요',
  '항해를 시작하죠, {n}'
]

/** 명언 — **출처가 분명한 것만.** 없는 것은 속담으로 표시한다. */
const QUOTES: readonly Greet[] = [
  { text: '이른 최적화는 모든 악의 근원이다.', by: '도널드 커누스' },
  { text: '프로그램은 사람이 읽으라고 쓰는 것이다. 기계가 실행하는 것은 그다음이다.', by: 'SICP' },
  { text: '디버깅은 코드를 짜는 것보다 두 배 어렵다.', by: '브라이언 커니핸' },
  { text: '컴퓨터 과학의 어려운 문제는 둘이다 — 캐시 무효화와 이름 짓기.', by: '필 칼튼' },
  { text: '단순한 것이 복잡한 것보다 낫다.', by: 'PEP 20' },
  { text: '지금 하는 것이 안 하는 것보다 낫다. 하지만 서둘러 하는 것보다는 안 하는 것이 낫다.', by: 'PEP 20' },
  { text: '급할수록 돌아가라.', by: '속담' },
  { text: '아는 길도 물어 가라.', by: '속담' },
  { text: '천 리 길도 한 걸음부터.', by: '속담' }
]

/** 시각에 맞는 인사 하나. 범위가 자정을 넘는 것은 없다(0~4 로 따로 적었다). */
function helloAt(hour: number, rand: number): string {
  const h = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 12
  const slot = HELLO.find((x) => h >= x.from && h <= x.to) ?? HELLO[1]!
  return slot.lines[Math.floor(rand * slot.lines.length) % slot.lines.length]!
}

/**
 * 이번에 띄울 한 줄.
 *
 * - `rand` 는 0 이상 1 미만. 주입받는 이유는 위 주석 참고(검사 가능성).
 * - `avoid` 는 **직전에 띄운 줄**. 같은 것이 두 번 연속 나오면 "랜덤"으로 안 느껴진다 —
 *   한 번 다시 뽑고, 그래도 같으면 그냥 낸다(무한 루프를 만들지 않는다).
 * - 이름이 없으면 `{n}` 이 든 줄은 어색해진다(", " 만 남는다) → **명언 쪽에서만** 고른다.
 */
export function pickGreeting(o: { name: string; hour: number; rand: () => number; avoid?: string }): Greet {
  const named = o.name.trim() !== ''
  const draw = (): Greet => {
    if (!named) return QUOTES[Math.floor(o.rand() * QUOTES.length) % QUOTES.length]!
    const bucket = o.rand()
    // 인사 35% · 반가움 35% · 명언 30%. 명언만 계속 나오면 앱이 훈계처럼 느껴진다.
    if (bucket < 0.35) return { text: helloAt(o.hour, o.rand()) }
    if (bucket < 0.7) return { text: GLAD[Math.floor(o.rand() * GLAD.length) % GLAD.length]! }
    return QUOTES[Math.floor(o.rand() * QUOTES.length) % QUOTES.length]!
  }
  const first = draw()
  if (o.avoid === undefined || first.text !== o.avoid) return first
  const second = draw()
  return second
}

/** `{n}` 을 호칭으로 바꾼 최종 문장. */
export function greetText(g: Greet, call: string): string {
  return g.text.replace('{n}', call)
}
