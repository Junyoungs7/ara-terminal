import { describe, it, expect } from 'vitest'
import { bootBottom, DEFAULT_SIDEBAR, hydrateSidebar } from '../src/renderer/store/sidebar'
import type { SidebarState } from '../src/shared/types'

// #13(2026-10-08): 왼쪽 사이드바·하단 패널의 접힘이 재시작 후에도 남는다.
// 저장은 ui.sidebar 하나(ui:setSidebar) — JSON 왕복을 거쳐 같은 값으로 돌아와야 한다.
const roundTrip = (s: SidebarState): SidebarState => hydrateSidebar(JSON.parse(JSON.stringify(s)))

describe('#13 접힘 상태 영속', () => {
  it('사이드바 접힘·하단 접힘(null)이 저장 → 복원 왕복으로 남는다', () => {
    const saved: SidebarState = { collapsed: true, activeTab: 'file', width: 300, bottom: null }
    expect(roundTrip(saved)).toEqual(saved)
  })

  it('하단이 열린 탭으로 끝났으면 그 탭이 남는다', () => {
    expect(roundTrip({ ...DEFAULT_SIDEBAR, bottom: 'sys' }).bottom).toBe('sys')
  })

  it('값이 없으면(옛 파일) 기본값 그대로 — 하단은 "저장된 적 없음"', () => {
    const h = hydrateSidebar({})
    expect(h).toEqual(DEFAULT_SIDEBAR)
    expect('bottom' in h).toBe(false)
  })

  it('위반 — 모르는 하단 탭·문자열 접힘·이상한 폭은 기본으로 눌러 담는다', () => {
    const h = hydrateSidebar({ bottom: 'nope', collapsed: 'yes', width: 'x' } as never)
    expect('bottom' in h).toBe(false)
    expect(h.collapsed).toBe(false)
    expect(h.width).toBe(DEFAULT_SIDEBAR.width)
  })

  it('첫 세션 자동 열기: 접고 끝냈으면 안 열고, 저장된 탭이면 그 탭, 없으면 옛 동작', () => {
    expect(bootBottom(null, 'monitor')).toBeNull()
    expect(bootBottom('ps', 'monitor')).toBe('ps')
    expect(bootBottom(undefined, 'monitor')).toBe('monitor')
  })
})
