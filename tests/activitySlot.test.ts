import { describe, it, expect } from 'vitest'
import { ACTIVITY_ITEMS, BOTTOM_IDS, RAIL_IDS, isBottomId, isRailId, type ActivityId } from '../src/shared/types'

// #87 ①(2026-08-16) — 액티비티 항목이 **어디에 열리는가**.
//
// 준영님이 처음 지적하신 "이 버튼을 눌렀는데 왜 다른 창이 켜지지?"의 마지막 잔재였다:
// 아이콘 열넷 중 어떤 것은 아래, 어떤 것은 오른쪽, 어떤 것은 창인데 눌러 봐야 알았다.
//
// 화면(ActivityBar)은 이 판정을 **배치의 단일 출처**(RAIL_IDS/BOTTOM_IDS)에서 파생한다.
// 여기서 지키는 것은 그 파생이 성립한다는 것 — 두 목록이 겹치거나 어느 항목이 어디에도 없으면
// 툴팁이 거짓말을 하거나 구분선이 엉뚱한 자리에 생긴다.
//
// (activitySlot 자체는 ActivityBar.tsx 에 있고 TSX 라 여기서 import 하지 않는다 — 같은 규칙을
//  타입 수준에서 지키는 것이 목적이고, 실제 툴팁·구분선은 e2e 가 화면에서 본다.)

const slotOf = (id: ActivityId): 'bottom' | 'rail' | 'window' =>
  isBottomId(id) ? 'bottom' : isRailId(id) ? 'rail' : 'window'

describe('배치 슬롯 — 모든 항목이 정확히 한 자리에 속한다', () => {
  it('★ 아래와 오른쪽이 겹치지 않는다 — 겹치면 툴팁이 둘 중 아무 말이나 한다', () => {
    for (const id of BOTTOM_IDS) expect(isRailId(id), id).toBe(false)
    for (const id of RAIL_IDS) expect(isBottomId(id), id).toBe(false)
  })

  it('모든 액티비티 항목이 셋 중 하나로 떨어진다', () => {
    for (const id of ACTIVITY_ITEMS) {
      expect(['bottom', 'rail', 'window']).toContain(slotOf(id))
    }
  })

  // 레일도 하단도 아닌 것들 — 떠 있는 창(작업대)이거나 화면을 덮는 오버레이(설정·명령어 북)다.
  // 2026-08-22 제보 9번으로 명령어 북이 합류했다.
  it('★ 레일·하단이 아닌 것은 셋 — 작업대·설정·명령어 북', () => {
    const windows = ACTIVITY_ITEMS.filter((id) => slotOf(id) === 'window')
    expect([...windows].sort()).toEqual(['cmdbook', 'explorer', 'settings'])
  })

  it('배치 원칙(§4.8) 그대로 — 서버 것은 아래, 아라 것은 오른쪽', () => {
    // 아래: 서버 상태·기록. 오른쪽: 아라 대화·AI 세션·지난 세션·미니 프리뷰.
    expect([...BOTTOM_IDS].sort()).toEqual(['applog', 'ctr', 'disk', 'k8s', 'log', 'monitor', 'pkg', 'ps', 'svc', 'sys'])
    // #132(2026-08-25): aisess 를 뺐다 — 목록은 사이드바 [AI] 로 갔고 감시는 화면 없이 돈다.
    expect([...RAIL_IDS].sort()).toEqual(['ai', 'pastlog', 'preview'])
  })
})
