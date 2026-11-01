import { useCallback, useEffect, useState } from 'react'
import { cleanConnCollapsed, type SidebarState } from '@shared/types'

// R4.3 사이드바 상태 단일 소스. ui.sidebar{width,collapsed,activeTab} 스키마는 F1부터 있었지만
// 아무도 읽지 않는 죽은 필드였고 폭은 CSS 고정이었다. useFont 와 같은 형태로:
// workspace.json ui.sidebar 하이드레이트 → 상태 → ui.setSidebar 로 영속(재시작 후 유지).
//
// 저장은 setFont 와 같은 좁은 필드 갱신(ui:setSidebar)이다. MainArea 의 전체 스냅샷 저장과
// 같은 필드를 두고 경쟁하지 않게 하려는 것 — 그쪽은 세션·레이아웃만 쓴다.

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480

export const DEFAULT_SIDEBAR: SidebarState = { collapsed: false, activeTab: 'conn', width: 232 }

export const clampSidebarWidth = (w: number): number =>
  Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)))

/**
 * 왼쪽 아이콘 레일을 눌렀을 때의 다음 상태 — IntelliJ 툴윈도우 규칙(2026-08-19 준영님 확정).
 *
 * **같은 아이콘을 다시 누르면 닫는다.** 그래서 여는 자리와 닫는 자리가 같아지고, 예전 `.sb-toggle`
 * (경계에 붙어 있던 `‹`/`›` 손잡이)이 필요 없어진다 — 그 손잡이는 하단바와 겹쳐 잘 안 보였다.
 * 다른 아이콘은 갈아타며 연다(접혀 있었으면 펴면서).
 */
export function nextSidebar(
  prev: SidebarState,
  tab: SidebarState['activeTab'] | 'sidebar'
): Partial<SidebarState> {
  // 다듬기 R6: 레일의 [파일]은 머리 탭으로 갔고 남은 [연결] 아이콘은 사이드바 자체의 여닫이다.
  // 접혀 있으면 마지막 탭으로 펴고, 펴져 있으면 접는다 — 단 [지난 세션]을 보고 있으면 마지막 탭으로 돌아간다.
  if (tab === 'sidebar') {
    if (prev.activeTab === 'past') return { collapsed: false, activeTab: prev.lastTab ?? 'conn' }
    return { collapsed: !prev.collapsed }
  }
  if (!prev.collapsed && prev.activeTab === tab) return { collapsed: true }
  // [지난 세션]으로 갈 때 지금 탭을 기억해 둔다(위 'sidebar' 가 돌아갈 자리).
  if (tab === 'past' && prev.activeTab !== 'past') return { collapsed: false, activeTab: tab, lastTab: prev.activeTab }
  return { collapsed: false, activeTab: tab }
}

/**
 * **화면에 실제로 보이는 탭.** 저장된 activeTab 과 다를 수 있다: 파일 트리는 활성 세션의
 * 파일시스템을 읽으므로 세션이 없으면 보여 줄 것이 없어 [연결] 로 떨어진다(저장값은 건드리지
 * 않는다 — 접속하면 원래 보던 탭으로 돌아온다).
 *
 * 이 규칙은 예전에 `Sidebar.tsx` 안에만 있었다. 레일이 생기자 **레일은 [파일] 이 눌린 채인데
 * 패널은 연결 트리를 그리는** 어긋남이 났다(2026-08-19 스모크가 잡았다) — 둘이 같은 값을 봐야 한다.
 */
export function shownTab(activeTab: SidebarState['activeTab'], fileEnabled: boolean): SidebarState['activeTab'] {
  // 2.0 [지난 세션]은 로그 폴더를 읽는다 — 세션과 무관하다.
  if (activeTab === 'past') return activeTab
  return fileEnabled ? activeTab : 'conn'
}

/**
 * workspace.json 의 ui.sidebar(손으로 고쳤거나 옛 앱이 쓴 값)를 화면 상태로. 파일은 신뢰 경계 밖이다 —
 * 모르는 탭·범위 밖 폭·모르는 하단 탭은 기본값으로 눌러 담는다.
 */
export function hydrateSidebar(s: Partial<SidebarState>): SidebarState {
  // FB-ui2: 옛 스냅샷의 activeTab='monitor'(이관 전 세 번째 탭)는 conn 으로 되돌린다 —
  // 안 그러면 두 탭 다 active 매치가 안 돼 사이드바가 빈 채로 뜬다. M3 S1: 지운 [AI] 탭('ai')도 같다(제거 A9).
  const activeTab = s.activeTab === 'file' ? s.activeTab : 'conn'
  const next: SidebarState = {
    ...DEFAULT_SIDEBAR,
    ...s,
    collapsed: s.collapsed === true,
    activeTab,
    width: clampSidebarWidth(typeof s.width === 'number' ? s.width : DEFAULT_SIDEBAR.width)
  }
  // 2.0: 하단 패널 열림 상태는 복원하지 않는다(늘 닫힌 채 시작) — 옛 파일에 남은 값도 버린다.
  delete (next as { bottom?: unknown }).bottom
  // 다듬기 R6 lastTab: 모르는 값은 버린다(없으면 'sidebar' 가 conn 으로 돌아간다).
  if (!['conn', 'file'].includes(next.lastTab as string)) delete next.lastTab
  // #13 연결 트리 접힘: 모양·크기만 남긴다. 없으면 키도 없다(옛 파일 = 전부 펼침).
  if ('connCollapsed' in s) next.connCollapsed = cleanConnCollapsed(s.connCollapsed)
  return next
}

/**
 * #13 하이드레이트 경합. `workspace.load()` 가 끝나기 전에 update 가 불리면 그 결과는
 * DEFAULT_SIDEBAR 위에 얹힌 값이다 — 그걸 저장하면 디스크의 접힘이 기본값으로 덮인다.
 * 그래서 로드 전에는 **저장하지 않고 patch 만 모아 두었다가**, 로드가 끝나면 하이드레이트 값 위에
 * 다시 얹고 그때 한 번 저장한다.
 */
export function sidebarPersist(save: (s: SidebarState) => void) {
  let loaded = false
  let pending: Partial<SidebarState> | null = null
  return {
    /** update 가 바꾼 결과. 같은 delta 를 두 번 받아도(StrictMode) 결과가 같다. */
    changed(next: SidebarState, delta: Partial<SidebarState>): void {
      if (loaded) save(next)
      else pending = { ...pending, ...delta }
    },
    /** 로드 끝. 화면에 둘 값을 돌려준다. 두 번째 호출부터는(StrictMode 이중 이펙트) base 그대로. */
    hydrated(base: SidebarState): SidebarState {
      loaded = true
      if (!pending) return base
      const next = { ...base, ...pending }
      pending = null
      save(next)
      return next
    }
  }
}

export function useSidebar() {
  const [sidebar, setSidebar] = useState<SidebarState>(DEFAULT_SIDEBAR)
  // ① 자동 전환의 기억 둘. 상태가 아니라 **판정 재료**라 ref 다 — 바뀌었다고 다시 그릴 것이 없다.

  // #13: 하이드레이트가 끝났나. 하단 패널 저장·첫 세션 자동 열기가 이걸 기다린다 — 그 전에 돌면
  // 기본값(저장된 적 없음)으로 판정하고, 저장된 "접힘"을 덮어쓴다.
  const [loaded, setLoaded] = useState(false)
  // 하네스(ui:setSidebar 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
  const [persist] = useState(() => sidebarPersist((s) => void window.ev?.ui.setSidebar(s).catch(() => {})))

  // 초기 하이드레이트. 옛 스냅샷에 sidebar 가 없거나 폭이 범위 밖이면 기본값으로 눌러 담는다.
  useEffect(() => {
    if (!window.ev) {
      persist.hydrated(DEFAULT_SIDEBAR)
      return setLoaded(true)
    }
    window.ev.workspace
      .load()
      .then((snap) => snap.ui.sidebar)
      .catch(() => undefined)
      .then((s) => {
        setSidebar(persist.hydrated(s ? hydrateSidebar(s) : DEFAULT_SIDEBAR))
        setLoaded(true)
      })
  }, [persist])

  // 갱신 + 영속. 함수형 patch 를 받는 이유: 접기 토글이 단축키 이펙트 안에서 현재 값을 필요로 한다.
  const update = useCallback((patch: Partial<SidebarState> | ((prev: SidebarState) => Partial<SidebarState>)) => {
    setSidebar((prev) => {
      const delta = typeof patch === 'function' ? patch(prev) : patch
      const next = { ...prev, ...delta }
      persist.changed(next, delta)
      return next
    })
  }, [persist])

  // 드래그 중(매 mousemove)에는 저장하지 않고 화면만 바꾼다 — 놓을 때 update 로 한 번 저장한다.
  const preview = useCallback((width: number) => setSidebar((prev) => ({ ...prev, width })), [])

  return { sidebar, loaded, update, preview }
}
