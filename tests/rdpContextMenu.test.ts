import { describe, it, expect } from 'vitest'
import { treeMenu, wantsTerminalMenu } from '../src/renderer/interactions/actions'
import { rdpButtonOf } from '../src/renderer/components/rdpInput'

// 2026-10-13 준영님: "RDP 에서 우클릭하면 SSH 우클릭 리스트가 뜬다."
// 판정만 본다 — 조상 체인을 선택자 집합으로 흉내 낸다(closest 는 자기 자신 포함 조상 검색).
const el = (...ancestors: string[]) => ({ closest: (sel: string) => (ancestors.includes(sel) ? {} : null) })

describe('RDP 우클릭', () => {
  it('터미널 칸에서는 아라 메뉴를 띄운다', () => {
    expect(wantsTerminalMenu(el('.pane-grid'), '.pane-grid')).toBe(true)
  })

  it('그리드 안이라도 RDP 칸이면 띄우지 않는다(원격 우클릭으로 간다)', () => {
    expect(wantsTerminalMenu(el('.pane-grid', '.rdp-view'), '.pane-grid')).toBe(false)
  })

  it('그리드 밖·대상 없음은 띄우지 않는다', () => {
    expect(wantsTerminalMenu(el('.sidebar'), '.pane-grid')).toBe(false)
    expect(wantsTerminalMenu(null, '.pane-grid')).toBe(false)
  })

  it('오른쪽 버튼(2)은 원격으로 보낸다', () => {
    expect(rdpButtonOf(2)).toBe(2)
  })

  it('RDP 탭 메뉴엔 복제·새 창으로가 없다(SSH 탭엔 있다)', () => {
    const ids = (k: 'tab' | 'tabRdp') => treeMenu(k).map((m) => m.id)
    expect(ids('tabRdp')).toEqual(['session.rename', 'session.close', 'session.closeOthers'])
    expect(ids('tab')).toContain('session.duplicate')
    expect(ids('tab')).toContain('session.detach')
  })
})
