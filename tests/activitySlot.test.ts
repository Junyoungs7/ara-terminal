import { describe, it, expect } from 'vitest'
import { ACTIVITY_ITEMS, BOTTOM_IDS, RAIL_IDS, isBottomId, isRailId } from '../src/shared/types'
import { activitySlot, activityWhereKey } from '../src/renderer/store/activityBar'

// #87 ①(2026-08-16) — 액티비티 항목이 **어디에 열리는가**.
//
// 준영님이 처음 지적하신 "이 버튼을 눌렀는데 왜 다른 창이 켜지지?"의 마지막 잔재였다:
// 어떤 것은 아래, 어떤 것은 오른쪽, 어떤 것은 창인데 눌러 봐야 알았다.
//
// 화면(ActivityBar 툴팁·구분선)은 이 판정을 **배치의 단일 출처**(RAIL_IDS/BOTTOM_IDS)에서
// 파생한다. 두 목록이 겹치거나 어느 항목이 어디에도 없으면 툴팁이 거짓말을 하거나 구분선이
// 엉뚱한 자리에 생긴다.
//
// FINISH-M6(2026-08-30): 전에는 `activitySlot` 이 ActivityBar.tsx 에 있어 여기서 못 불렀고,
// 그래서 이 파일이 **같은 규칙을 한 벌 더 적어** 두고 있었다(그 사본이 진짜와 어긋나도 초록이었다).
// 규칙을 store/activityBar.ts 로 내리면서 진짜를 부른다.

const slotOf = activitySlot

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
    expect([...RAIL_IDS].sort()).toEqual(['ai', 'pastlog'])
  })
})

/**
 * 툴팁 꼬리표 — 이름 뒤에 붙는 `· 오른쪽에 열림` 같은 말. 지킬 것은 "꼬리표가 붙는 항목"과
 * "안 붙는 항목"이 갈리는 규칙 하나다.
 *
 * FINISH-M7(2026-08-30): 이 규칙을 두 번째로 쓰던 설정 목록이 없어져 부르는 곳은 툴팁뿐이고,
 * 툴팁은 레일 항목에만 걸린다 — **`activity.where.bottom` 은 화면에 안 나온다.** 그래도 아래
 * 하단 검사는 남긴다: 판정이 배치에서 파생된다는 것을 재는 자리이고, 하단 항목이 어느 날 다시
 * 바에 서면 그때 바로 옳은 말을 해야 한다.
 */
describe('어디에 열림 꼬리표(activityWhereKey)', () => {
  it('하단 항목은 [아래에 열림] 을 받는다(오늘은 화면에 안 나온다 — 위 주석)', () => {
    for (const id of BOTTOM_IDS) expect(activityWhereKey(id), id).toBe('activity.where.bottom')
  })

  it('레일 항목은 [오른쪽에 열림]', () => {
    for (const id of RAIL_IDS) expect(activityWhereKey(id), id).toBe('activity.where.rail')
  })

  // 오버레이는 그 자체가 목적지라 "어디에 열리는지"를 말할 것이 없다(툴팁도 같은 규칙).
  it('설정·명령어 북은 꼬리표가 없다 / 작업대는 [창으로 열림]', () => {
    expect(activityWhereKey('settings')).toBeNull()
    expect(activityWhereKey('cmdbook')).toBeNull()
    expect(activityWhereKey('explorer')).toBe('activity.where.window')
  })

  it('★ 꼬리표 키는 전부 ko.json 에 있다 — 없으면 화면에 키 문자열이 그대로 찍힌다', async () => {
    const ko = (await import('../src/renderer/i18n/ko.json')).default as Record<string, string>
    for (const id of ACTIVITY_ITEMS) {
      const key = activityWhereKey(id)
      if (key) expect(ko[key], `${id} → ${key}`).toBeTruthy()
    }
  })
})
