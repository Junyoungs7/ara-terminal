import { AI_ENTRY } from '@shared/features'
import { ACTIVITY_ITEMS, isBottomId, isRailId, type ActivityId } from '@shared/types'

// FB-ui2(FB-0006): 우측 액티비티 바(VS Code 스타일 세로 아이콘 바) 항목 — 순수 로직.
// ActivityBar.tsx 가 여기서 나온 목록을 그대로 매핑해 그린다. 아이콘·툴팁·클릭 배선은 컴포넌트가 갖고,
// 여기는 "무슨 항목이 어떤 순서로 보이는가"와 "지금 열려 있는가"만 둔다(단위 테스트 대상).
//
// 항목 정의(ActivityId·ACTIVITY_ITEMS)는 **shared/types.ts** 에 있다. 여기서 다시 내보내
// 기존 import 경로를 유지한다.
export { ACTIVITY_ITEMS, type ActivityId }

export type ActivityOpenState = Record<ActivityId, boolean>

/**
 * #87 ①(2026-08-16): 이 항목이 **어디에 열리는가**.
 *
 * 준영님이 처음 지적하신 "이 버튼을 눌렀는데 왜 다른 창이 켜지지?"의 마지막 잔재였다 —
 * 어떤 것은 아래, 어떤 것은 오른쪽, 어떤 것은 창인데 **눌러 봐야 알았다.**
 * 판정은 배치의 단일 출처(RAIL_IDS/BOTTOM_IDS)에서 파생한다 — 여기 목록을 또 만들지 않는다.
 *
 * 2026-08-30(FINISH-M6): ActivityBar.tsx 에 있던 것을 이리로 내렸다 — TSX 라 단위 검사가 못
 * 들어왔다. 같은 날 M7 이 설정 목록을 없애 부르는 곳은 툴팁 하나로 돌아갔지만, 판정이 순수
 * 함수로 검사되는 편이 낫다(레일에 무엇이 서는지가 이제 이 규칙에만 달려 있다).
 */
export type ActivitySlot = 'bottom' | 'rail' | 'window'
export function activitySlot(id: ActivityId): ActivitySlot {
  if (isBottomId(id)) return 'bottom'
  if (isRailId(id)) return 'rail'
  return 'window' // 작업대 창 · 설정 드로어 · 명령어 북
}

/**
 * "어디에 열림"을 말할 i18n 키 — 말할 것이 없으면 null.
 *
 * 설정·명령어 북은 **오버레이 그 자체가 목적지**라 어디에 열리는지 말할 것이 없다.
 * 문구가 아니라 **키**를 돌려준다: 이 판정은 순수 규칙이고, 번역은 부르는 쪽(툴팁)의 몫이다.
 */
export function activityWhereKey(id: ActivityId): string | null {
  return id === 'settings' || id === 'cmdbook' ? null : 'activity.where.' + activitySlot(id)
}

// 항목이 "열림(활성)" 표시를 받는지 — 상태 객체에서 그대로 읽는다. 항목은 서로 배타적이지 않다
// (아라 패널과 모니터 패널이 동시에 열려 있어도 된다 — 기존 미니 프리뷰/아라 패널 규칙과 같다).
export function isActivityOpen(id: ActivityId, state: ActivityOpenState): boolean {
  return state[id]
}

/**
 * 실제로 그릴 항목. **순서는 ACTIVITY_ITEMS 가 정한다** — 2026-08-30(FINISH-M7) 준영님 결정으로
 * 설정에서 순서를 바꾸고 항목을 숨기는 기능이 통째로 없어졌다(*"그냥 우측 아이콘바 설정하는건
 * 제거하자"*). 여기서 빼는 것은 **숨긴 기능** 하나뿐이다(features.AI_ENTRY — 아라 대화로 가는 문).
 * 되살리면 이 상수가 알아서 다시 늘어난다.
 */
export const SHOWN_ACTIVITIES: readonly ActivityId[] = ACTIVITY_ITEMS.filter((id) => AI_ENTRY || id !== 'ai')
