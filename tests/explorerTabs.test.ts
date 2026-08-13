// 파일 탐색기 탭·창 기하. 탭이 중복 생기거나 창이 화면 밖으로 빠져나가면 사용자는 되돌릴 방법이
// 없다(제목줄을 못 잡으면 창을 옮길 수도 닫을 수도 없다) — 그 두 가지를 여기서 못 박는다.
import { describe, it, expect } from 'vitest'
import {
  EXP_MIN_H,
  EXP_MIN_W,
  LOCAL_TARGET,
  clampRect,
  closeTab,
  findTab,
  initialRect,
  openTab,
  sameTarget,
  type ExpTab
} from '../src/renderer/store/explorerTabs'

const local = (id: string): ExpTab => ({ id, target: LOCAL_TARGET, label: '내 PC' })
const ssh = (id: string, profileId: string): ExpTab => ({ id, target: { kind: 'ssh', profileId }, label: profileId })

describe('타깃 동일성', () => {
  it('로컬끼리는 같다 — 내 PC 탭이 여러 장 생기면 안 된다', () => {
    expect(sameTarget(LOCAL_TARGET, { kind: 'local' })).toBe(true)
  })
  it('프로필이 다르면 다른 서버다', () => {
    expect(sameTarget({ kind: 'ssh', profileId: 'a' }, { kind: 'ssh', profileId: 'b' })).toBe(false)
    expect(sameTarget({ kind: 'ssh', profileId: 'a' }, { kind: 'ssh', profileId: 'a' })).toBe(true)
  })
  it('로컬과 서버는 다르다', () => {
    expect(sameTarget(LOCAL_TARGET, { kind: 'ssh', profileId: 'a' })).toBe(false)
  })
})

describe('탭 열기', () => {
  it('새 위치는 탭이 늘고 그 탭이 활성이 된다', () => {
    const r = openTab([local('t1')], ssh('t2', 'kvt'))
    expect(r.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(r.activeId).toBe('t2')
  })

  it('같은 서버를 또 누르면 탭이 안 늘고 기존 탭으로 간다', () => {
    const r = openTab([local('t1'), ssh('t2', 'kvt')], ssh('t9', 'kvt'))
    expect(r.tabs).toHaveLength(2)
    expect(r.activeId).toBe('t2')
  })

  it('즐겨찾기로 같은 서버를 열면 기존 탭이 그 폴더로 이동한다(새 탭 아님)', () => {
    const r = openTab([ssh('t2', 'kvt')], { ...ssh('t9', 'kvt'), goto: '/var/log' })
    expect(r.tabs).toHaveLength(1)
    expect(r.tabs[0].id).toBe('t2')
    expect(r.tabs[0].goto).toBe('/var/log')
  })

  it('goto 없이 다시 열면 기존 탭의 폴더를 건드리지 않는다', () => {
    const r = openTab([{ ...ssh('t2', 'kvt'), goto: '/var/log' }], ssh('t9', 'kvt'))
    expect(r.tabs[0].goto).toBe('/var/log')
  })
})

describe('탭 닫기', () => {
  const tabs = [local('t1'), ssh('t2', 'a'), ssh('t3', 'b')]

  it('비활성 탭을 닫아도 활성 탭은 그대로', () => {
    const r = closeTab(tabs, 't2', 't3')
    expect(r.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(r.activeId).toBe('t2')
  })

  it('활성 탭을 닫으면 오른쪽 이웃으로 간다', () => {
    expect(closeTab(tabs, 't2', 't2').activeId).toBe('t3')
  })

  it('마지막 탭을 닫으면 왼쪽으로 간다(오른쪽이 없다)', () => {
    expect(closeTab(tabs, 't3', 't3').activeId).toBe('t2')
  })

  it('한 장만 남으면 닫히지 않는다 — 빈 창은 보여 줄 게 없다', () => {
    const r = closeTab([local('t1')], 't1', 't1')
    expect(r.tabs).toHaveLength(1)
    expect(r.activeId).toBe('t1')
  })

  it('없는 id 는 무시한다', () => {
    expect(closeTab(tabs, 't1', 'nope').tabs).toHaveLength(3)
  })
})

describe('findTab', () => {
  it('타깃으로 찾는다', () => {
    expect(findTab([local('t1'), ssh('t2', 'a')], { kind: 'ssh', profileId: 'a' })?.id).toBe('t2')
    expect(findTab([local('t1')], { kind: 'ssh', profileId: 'a' })).toBeUndefined()
  })
})

describe('창 기하', () => {
  const VW = 1600
  const VH = 900

  it('최소 크기 아래로는 안 줄어든다', () => {
    const r = clampRect({ x: 0, y: 0, w: 10, h: 10 }, VW, VH)
    expect(r.w).toBe(EXP_MIN_W)
    expect(r.h).toBe(EXP_MIN_H)
  })

  it('화면보다 커지지 않는다', () => {
    const r = clampRect({ x: 0, y: 0, w: 9999, h: 9999 }, VW, VH)
    expect(r.w).toBe(VW)
    expect(r.h).toBe(VH)
  })

  it('왼쪽으로 끌고 나가도 제목줄 일부는 화면에 남는다(다시 잡을 수 있어야 한다)', () => {
    const r = clampRect({ x: -5000, y: 100, w: 800, h: 500 }, VW, VH)
    expect(r.x + r.w).toBeGreaterThanOrEqual(120)
  })

  it('오른쪽으로 끌고 나가도 마찬가지', () => {
    const r = clampRect({ x: 9999, y: 100, w: 800, h: 500 }, VW, VH)
    expect(r.x).toBeLessThanOrEqual(VW - 120)
  })

  it('제목줄이 화면 위로 사라지지 않는다', () => {
    expect(clampRect({ x: 0, y: -900, w: 800, h: 500 }, VW, VH).y).toBeGreaterThanOrEqual(0)
  })

  it('아래로 끌어도 제목줄은 남는다', () => {
    expect(clampRect({ x: 0, y: 9999, w: 800, h: 500 }, VW, VH).y).toBeLessThanOrEqual(VH - 120)
  })

  it('정수 픽셀로 떨어진다 — 소수면 리사이즈가 떨린다', () => {
    const r = clampRect({ x: 10.4, y: 20.6, w: 800.5, h: 500.5 }, VW, VH)
    expect(Object.values(r).every(Number.isInteger)).toBe(true)
  })

  it('처음 크기는 화면 안에 들어오고 가운데 정렬이다', () => {
    const r = initialRect(VW, VH)
    expect(r.x).toBeGreaterThan(0)
    expect(r.x + r.w).toBeLessThanOrEqual(VW)
    expect(r.y + r.h).toBeLessThanOrEqual(VH)
    expect(Math.abs(r.x - (VW - r.w) / 2)).toBeLessThanOrEqual(1)
  })

  it('작은 화면에서도 최소 크기를 지키고 좌표가 NaN 이 되지 않는다', () => {
    const r = initialRect(400, 300)
    expect(r.w).toBe(EXP_MIN_W)
    expect(r.h).toBe(EXP_MIN_H)
    expect(Object.values(r).every(Number.isFinite)).toBe(true)
  })
})
