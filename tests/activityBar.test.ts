import { describe, it, expect } from 'vitest'
import { AI_ENTRY } from '../src/shared/features'
import {
  ACTIVITY_ITEMS,
  isActivityOpen,
  SHOWN_ACTIVITIES,
  type ActivityOpenState
} from '../src/renderer/store/activityBar'
import { BOTTOM_IDS, isBottomId } from '../src/shared/types'

// FB-ui2(FB-0006) 우측 액티비티 바 — 항목 정의·활성 판정의 순수 로직.

describe('액티비티 바 항목 정의', () => {
  it('열여섯 항목을 이 순서로 갖는다', () => {
    // F26: 서버 콘솔(console)은 탐색기 다음 자리 — 둘 다 서버를 마우스로 다루는 떠 있는 창이다.
    // F29: 시스템 모니터(sys)는 포트 모니터 바로 다음 — 둘 다 "지금 이 서버가 어떤 상태인가"다.
    // #84: 서버 콘솔의 표 다섯(ps·svc·disk·pkg·ctr)이 하단 탭이 되면서 여기 합류했다.
    //   sys 바로 뒤에 모아 둔다 — 하단에 열리는 것끼리 붙어 있어야 탭줄에서 한 덩어리로 읽힌다
    //   (log 는 그 아래지만 성격이 달라 k8s 뒤 자기 자리를 지킨다).
    //   2026-08-30(FINISH-M7): 이 배열이 **화면 순서의 유일한 정의부**가 됐다(설정에서 순서를
    //   바꾸는 기능이 없어졌다). 여기를 고치면 그것이 곧 사용자 화면이라, 이 기대값이 곧 계약이다.
    expect(ACTIVITY_ITEMS).toEqual([
      'ai',
      'monitor',
      'sys',
      'ps',
      'svc',
      'disk',
      'pkg',
      'ctr',
      'k8s',
      'log',
      // 2026-08-27: [서버 로그] — 세션 기록(log) 바로 뒤. 둘 다 "로그"라 이름이 붙어 있어야
      // 무엇이 무엇인지 바에서 한눈에 갈린다(그쪽은 내가 친 것, 이쪽은 서버가 뱉는 것).
      'applog',
      'pastlog',
      'preview',
      'explorer',
      // 2026-08-22 제보 9번 — 명령어 북이 아이콘으로 올라왔다.
      'cmdbook',
      'settings'
    ])
  })

  // #84: 하단 탭은 전부 액티비티 항목이다 — 배치의 단일 출처가 하나라는 뜻이다.
  it('★ 하단 탭은 전부 액티비티 항목이다', () => {
    for (const id of BOTTOM_IDS) expect(ACTIVITY_ITEMS).toContain(id)
  })
})

/**
 * 2026-08-30(FINISH-M7): 설정에서 순서·숨김을 고치는 기능이 없어지면서 **화면에 나오는 목록은
 * 전적으로 이 배열에서 파생**된다. 사람이 손댈 손잡이가 없어졌으니, 파생이 틀리면 아무도
 * 되돌릴 수 없다 — 그 파생을 여기서 굳힌다.
 */
describe('그리는 목록은 ACTIVITY_ITEMS 에서만 나온다', () => {
  it('레일 = isBottomId 아닌 것, 순서 보존', () => {
    // ActivityBar.tsx 가 items.filter(id => !isBottomId(id)) 로 그린다.
    expect(SHOWN_ACTIVITIES.filter((id) => !isBottomId(id))).toEqual(
      ACTIVITY_ITEMS.filter((id) => !isBottomId(id) && (AI_ENTRY || id !== 'ai'))
    )
  })

  it('하단 탭 = BOTTOM_IDS, 순서 보존', () => {
    // BottomPanel 의 기본값이 BOTTOM_IDS 그대로다(Shell 이 ids 를 넘기지 않는다).
    expect(SHOWN_ACTIVITIES.filter(isBottomId)).toEqual([...BOTTOM_IDS])
  })

  it('★ 레일 ∪ 하단 = 전체 — 어느 화면에도 안 나오는 도구가 없다', () => {
    const rail = SHOWN_ACTIVITIES.filter((id) => !isBottomId(id))
    const bottom = SHOWN_ACTIVITIES.filter(isBottomId)
    expect([...rail, ...bottom].sort()).toEqual([...SHOWN_ACTIVITIES].sort())
    expect(rail.filter((id) => bottom.includes(id as never))).toEqual([]) // 둘 다에 있으면 화면에 두 번 나온다
  })

  it('숨긴 기능만 빠진다(features.AI_ENTRY) — 그 외에는 전부 그린다', () => {
    expect(SHOWN_ACTIVITIES).toEqual(AI_ENTRY ? [...ACTIVITY_ITEMS] : ACTIVITY_ITEMS.filter((x) => x !== 'ai'))
  })
})

describe('활성 판정(isActivityOpen)', () => {
  const state: ActivityOpenState = {
    ai: true,
    monitor: false,
    sys: false,
    // #84: 서버 콘솔의 표 다섯이 하단 탭이 되면서 액티비티 항목이 됐다.
    ps: false,
    svc: false,
    disk: false,
    pkg: false,
    ctr: false,
    k8s: false,
    log: true,
    applog: false,
    pastlog: false,
    preview: false,
    explorer: false,
    // 2026-08-22 제보 9번: 명령어 북이 액티비티 항목이 됐다(설정과 같은 부류 — 오버레이).
    cmdbook: false,
    settings: false
  }

  it('각 항목은 상태 객체의 자기 값만 그대로 읽는다(서로 배타적이지 않음)', () => {
    expect(isActivityOpen('ai', state)).toBe(true)
    expect(isActivityOpen('monitor', state)).toBe(false)
    expect(isActivityOpen('log', state)).toBe(true)
    expect(isActivityOpen('settings', state)).toBe(false)
  })

  it('둘 다 열려 있어도(아라+로그) 서로 간섭하지 않는다', () => {
    for (const id of ACTIVITY_ITEMS) {
      expect(isActivityOpen(id, state)).toBe(state[id])
    }
  })
})
