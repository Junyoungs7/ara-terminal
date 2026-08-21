import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_ITEMS,
  activityHiddenOf,
  activityOrderOf,
  isActivityOpen,
  moveActivity,
  toggleActivityHidden,
  visibleActivities,
  type ActivityId,
  type ActivityOpenState
} from '../src/renderer/store/activityBar'
import { BOTTOM_IDS } from '../src/shared/types'

// FB-ui2(FB-0006) 우측 액티비티 바 — 항목 정의·활성 판정의 순수 로직.

describe('액티비티 바 항목 정의', () => {
  it('열다섯 항목을 이 순서로 갖는다', () => {
    // F26: 서버 콘솔(console)은 탐색기 다음 자리 — 둘 다 서버를 마우스로 다루는 떠 있는 창이다.
    // F29: 시스템 모니터(sys)는 포트 모니터 바로 다음 — 둘 다 "지금 이 서버가 어떤 상태인가"다.
    // #84: 서버 콘솔의 표 다섯(ps·svc·disk·pkg·ctr)이 하단 탭이 되면서 여기 합류했다.
    //   sys 바로 뒤에 모아 둔다 — **하단에 열리는 것끼리** 붙어 있어야 바에서도 한 덩어리로 읽힌다
    //   (log 는 그 아래지만 성격이 달라 aisess 뒤 자기 자리를 지킨다).
    //   순서가 바뀌면 저장된 activityOrder 는 그대로고 **새 항목만 뒤에 붙는다**(migrateOrder) —
    //   기존 사용자에게 안 보이는 사고는 그쪽이 막는다.
    expect(ACTIVITY_ITEMS).toEqual([
      'ai',
      'monitor',
      'sys',
      'ps',
      'svc',
      'disk',
      'pkg',
      'ctr',
      'aisess',
      'log',
      'pastlog',
      'preview',
      'explorer',
      // 2026-08-22 제보 9번 — 명령어 북이 아이콘으로 올라왔다.
      'cmdbook',
      'settings'
    ])
  })

  // #84: 하단 탭 여덟이 전부 액티비티 항목이어야 설정에서 끄고 순서를 바꿀 수 있다
  // (탭바가 좁을 때의 유일한 해법이고, 하단만의 새 설정을 만들지 않기로 한 근거다).
  it('★ 하단 탭은 전부 액티비티 항목이다 — 설정의 순서·숨김이 그대로 먹는다', () => {
    for (const id of BOTTOM_IDS) expect(ACTIVITY_ITEMS).toContain(id)
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
    aisess: false,
    log: true,
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

// 2026-08-13 준영님 요청: 우측 바 항목을 껐다 켜고 순서도 바꾼다. 저장값은 신뢰 경계 밖이라
// 읽는 쪽에서 손보는 규칙이 이 블록의 검증 대상이다.
describe('저장된 순서 읽기(activityOrderOf)', () => {
  it('저장된 것이 없으면 기본 순서 그대로', () => {
    expect(activityOrderOf(undefined)).toEqual([...ACTIVITY_ITEMS])
    expect(activityOrderOf([])).toEqual([...ACTIVITY_ITEMS])
    expect(activityOrderOf('쓰레기')).toEqual([...ACTIVITY_ITEMS])
  })

  it('모르는 이름은 버리고 중복은 하나만 남긴다', () => {
    const got = activityOrderOf(['log', '없는항목', 'log', 'ai'])
    expect(got.filter((x) => x === 'log')).toHaveLength(1)
    expect(got).not.toContain('없는항목')
    expect(got.slice(0, 2)).toEqual(['log', 'ai']) // 저장해 둔 순서가 앞에 그대로
  })

  it('★ 빠진 항목을 기본 순서 자리에 끼워 넣는다 — 새 기능이 영영 안 보이면 안 된다', () => {
    // 사용자가 예전에 세 개만 저장해 뒀다고 하자. 나머지가 전부 살아 있어야 한다.
    const got = activityOrderOf(['explorer', 'ai', 'log'])
    expect([...got].sort()).toEqual([...ACTIVITY_ITEMS].sort())
    // 저장해 둔 순서는 그대로 지킨다.
    expect(got.indexOf('explorer')).toBeLessThan(got.indexOf('ai'))
    expect(got.indexOf('ai')).toBeLessThan(got.indexOf('log'))
  })

  // #91: 'console' 은 없어졌다(서버 콘솔 창이 [서버 작업대]에 흡수됐다). 옛 스냅샷에 남아 있어도
  // 모르는 이름으로 버려져야 한다 — 안 그러면 눌러도 아무 일 없는 아이콘이 바에 남는다.
  it('★ 없어진 항목(console)은 저장값에 남아 있어도 버린다', () => {
    const got = activityOrderOf(['console', 'ai'])
    expect(got).not.toContain('console')
    expect([...got].sort()).toEqual([...ACTIVITY_ITEMS].sort())
  })

  it('빠진 항목은 기본 순서대로 뒤에 붙는다(예측 가능하게)', () => {
    const got = activityOrderOf(['monitor', 'explorer'])
    expect(got.slice(0, 2)).toEqual(['monitor', 'explorer'])
    // 나머지는 기본 순서 그대로 뒤에.
    expect(got.slice(2)).toEqual(ACTIVITY_ITEMS.filter((x) => x !== 'monitor' && x !== 'explorer'))
  })
})

describe('숨김·순서 바꾸기', () => {
  it('숨긴 항목만 바에서 빠진다(순서는 그대로)', () => {
    const order = [...ACTIVITY_ITEMS]
    expect(visibleActivities(order, ['log', 'preview'])).toEqual(order.filter((x) => x !== 'log' && x !== 'preview'))
  })

  it('★ 껐다 켜면 원래 자리로 돌아온다 — 순서 배열을 건드리지 않기 때문', () => {
    const order = [...ACTIVITY_ITEMS]
    const off = toggleActivityHidden([], 'sys')
    expect(visibleActivities(order, off)).not.toContain('sys')
    const on = toggleActivityHidden(off, 'sys')
    expect(visibleActivities(order, on)).toEqual(order)
  })

  it('한 칸씩 옮기고, 끝에서는 그대로 둔다(감아 돌지 않는다)', () => {
    const order: ActivityId[] = ['ai', 'monitor', 'sys']
    expect(moveActivity(order, 'monitor', -1)).toEqual(['monitor', 'ai', 'sys'])
    expect(moveActivity(order, 'monitor', 1)).toEqual(['ai', 'sys', 'monitor'])
    expect(moveActivity(order, 'ai', -1)).toEqual(order) // 맨 위에서 위로
    expect(moveActivity(order, 'sys', 1)).toEqual(order) // 맨 아래에서 아래로
  })

  it('숨김 목록도 모르는 이름을 버린다', () => {
    expect(activityHiddenOf(['log', '없는항목', 'log'])).toEqual(['log'])
    expect(activityHiddenOf(undefined)).toEqual([])
  })

  it('전부 숨기는 것도 허용한다 — 바가 빈 채로 남는다(설정은 Ctrl+, 로 연다)', () => {
    expect(visibleActivities([...ACTIVITY_ITEMS], [...ACTIVITY_ITEMS])).toEqual([])
  })
})
