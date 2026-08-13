import { useCallback, useEffect, useState } from 'react'
import type { SidebarState } from '@shared/types'

// R4.3 사이드바 상태 단일 소스. ui.sidebar{width,collapsed,activeTab} 스키마는 F1부터 있었지만
// 아무도 읽지 않는 죽은 필드였고 폭은 CSS 고정이었다. useFont 와 같은 형태로:
// workspace.json ui.sidebar 하이드레이트 → 상태 → ui.setSidebar 로 영속(재시작 후 유지).
//
// 저장은 setFont 와 같은 좁은 필드 갱신(ui:setSidebar)이다. MainArea 의 전체 스냅샷 저장과
// 같은 필드를 두고 경쟁하지 않게 하려는 것 — 그쪽은 세션·레이아웃만 쓴다.

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480

export const DEFAULT_SIDEBAR: SidebarState = { collapsed: false, activeTab: 'conn', width: 264 }

export const clampSidebarWidth = (w: number): number =>
  Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

export function useSidebar() {
  const [sidebar, setSidebar] = useState<SidebarState>(DEFAULT_SIDEBAR)

  // 초기 하이드레이트. 옛 스냅샷에 sidebar 가 없거나 폭이 범위 밖이면 기본값으로 눌러 담는다.
  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => {
        const s = snap.ui.sidebar
        if (!s) return
        // FB-ui2: 옛 스냅샷의 activeTab='monitor'(이관 전 세 번째 탭)는 conn 으로 되돌린다 —
        // 안 그러면 두 탭 다 active 매치가 안 돼 사이드바가 빈 채로 뜬다.
        const activeTab = s.activeTab === 'file' ? 'file' : 'conn'
        setSidebar({ ...DEFAULT_SIDEBAR, ...s, activeTab, width: clampSidebarWidth(s.width ?? DEFAULT_SIDEBAR.width) })
      })
      .catch(() => {})
  }, [])

  // 갱신 + 영속. 함수형 patch 를 받는 이유: 접기 토글이 단축키 이펙트 안에서 현재 값을 필요로 한다.
  const update = useCallback((patch: Partial<SidebarState> | ((prev: SidebarState) => Partial<SidebarState>)) => {
    setSidebar((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      // 하네스(ui:setSidebar 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
      window.ev?.ui.setSidebar(next).catch(() => {})
      return next
    })
  }, [])

  // 드래그 중(매 mousemove)에는 저장하지 않고 화면만 바꾼다 — 놓을 때 update 로 한 번 저장한다.
  const preview = useCallback((width: number) => setSidebar((prev) => ({ ...prev, width })), [])

  return { sidebar, update, preview }
}
