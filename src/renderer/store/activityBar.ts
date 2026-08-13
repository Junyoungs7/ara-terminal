import { ACTIVITY_ITEMS, type ActivityId } from '@shared/types'

// FB-ui2(FB-0006): 우측 액티비티 바(VS Code 스타일 세로 아이콘 바) 항목 — 순수 로직.
// ActivityBar.tsx 가 여기서 나온 목록을 그대로 매핑해 그린다. 아이콘·툴팁·클릭 배선은 컴포넌트가 갖고,
// 여기는 "무슨 항목이 어떤 순서로 보이는가"와 "지금 열려 있는가"만 둔다(단위 테스트 대상).
//
// 항목 정의(ActivityId·ACTIVITY_ITEMS)는 **shared/types.ts** 에 있다 — 2026-08-13 부터 순서·숨김이
// 설정으로 저장돼(ui.activityOrder/activityHidden) main 도 같은 스키마를 보기 때문이다.
// 여기서 다시 내보내 기존 import 경로를 유지한다.
export { ACTIVITY_ITEMS, type ActivityId }

export type ActivityOpenState = Record<ActivityId, boolean>

// 항목이 "열림(활성)" 표시를 받는지 — 상태 객체에서 그대로 읽는다. 항목은 서로 배타적이지 않다
// (아라 패널과 모니터 패널이 동시에 열려 있어도 된다 — 기존 미니 프리뷰/아라 패널 규칙과 같다).
export function isActivityOpen(id: ActivityId, state: ActivityOpenState): boolean {
  return state[id]
}

const known = (v: unknown): v is ActivityId => ACTIVITY_ITEMS.includes(v as ActivityId)

/**
 * 저장된 순서 → 쓸 수 있는 순서. 저장값은 신뢰 경계 밖이라 세 가지를 손본다:
 *  · 모르는 이름은 버린다(옛 스냅샷에 남은, 없어진 항목).
 *  · 중복은 첫 번째만 남긴다.
 *  · **빠진 항목은 뒤에 붙인다** — 이게 핵심이다. 새 기능이 액티비티 바에 추가돼도, 한 번이라도
 *    순서를 저장한 사용자에게는 영영 안 보이는 사고를 막는다.
 *
 * 빠진 것을 "기본 순서의 이웃 뒤에" 꽂는 방식도 해 봤는데(설계 의도인 묶음을 지키려고) 결과가
 * 뒤엉켰다 — 저장된 두어 개 사이로 새 항목이 파고들어 순서를 눈으로 못 따라간다. 어차피 평소에는
 * 전체 목록이 저장돼 있어 이 보정이 도는 때는 **새 항목이 생겼을 때뿐**이고, 그때는 맨 뒤에
 * 조용히 붙는 편이 예측 가능하다(원하면 설정에서 옮기면 된다).
 */
export function activityOrderOf(raw: unknown): ActivityId[] {
  const saved = Array.isArray(raw) ? raw.filter(known) : []
  const out: ActivityId[] = []
  for (const id of saved) if (!out.includes(id)) out.push(id)
  if (out.length === 0) return [...ACTIVITY_ITEMS]
  for (const id of ACTIVITY_ITEMS) if (!out.includes(id)) out.push(id)
  return out
}

/** 저장된 숨김 목록 → 아는 이름만. 전부 숨기는 것도 허용한다(바는 빈 채로 남는다). */
export function activityHiddenOf(raw: unknown): ActivityId[] {
  const saved = Array.isArray(raw) ? raw.filter(known) : []
  return [...new Set(saved)]
}

/** 실제로 바에 그릴 목록. */
export function visibleActivities(order: readonly ActivityId[], hidden: readonly ActivityId[]): ActivityId[] {
  return order.filter((id) => !hidden.includes(id))
}

/**
 * 한 칸 위·아래로 옮긴다. 끝에서 더 가면 **그대로 둔다**(감아 돌지 않는다) — 목록이 눈에 다 보이는
 * 설정 화면에서 맨 위 항목이 갑자기 맨 아래로 튀면 실수로밖에 안 읽힌다.
 * 숨긴 항목도 자리를 지킨 채 같이 움직인다(껐다 켜면 원래 자리로 돌아온다).
 */
export function moveActivity(order: readonly ActivityId[], id: ActivityId, delta: -1 | 1): ActivityId[] {
  const from = order.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

/** 숨김 토글. 순서는 건드리지 않는다 — 다시 켜면 있던 자리에 그대로 나온다. */
export function toggleActivityHidden(hidden: readonly ActivityId[], id: ActivityId): ActivityId[] {
  return hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]
}
