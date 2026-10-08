import { useCallback, useEffect, useRef, useState } from 'react'
import { isBottomId, type BottomId, type SidebarState } from '@shared/types'

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

/**
 * 왼쪽 아이콘 레일을 눌렀을 때의 다음 상태 — IntelliJ 툴윈도우 규칙(2026-08-19 준영님 확정).
 *
 * **같은 아이콘을 다시 누르면 닫는다.** 그래서 여는 자리와 닫는 자리가 같아지고, 예전 `.sb-toggle`
 * (경계에 붙어 있던 `‹`/`›` 손잡이)이 필요 없어진다 — 그 손잡이는 하단바와 겹쳐 잘 안 보였다.
 * 다른 아이콘은 갈아타며 연다(접혀 있었으면 펴면서).
 */
export function nextSidebar(prev: SidebarState, tab: SidebarState['activeTab']): Partial<SidebarState> {
  if (!prev.collapsed && prev.activeTab === tab) return { collapsed: true }
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
  // #129 [AI] 작업대 목록은 세션이 없어도 읽을 것이 있다(껐다 켜도 남는 목록이다) — 안 떨어뜨린다.
  if (activeTab === 'ai') return 'ai'
  return fileEnabled ? activeTab : 'conn'
}

/**
 * 사이드바를 [AI] 아닌 것으로 바꾼 직후 자동 전환을 쉬는 시간. **짧게** 잡는다: 길면
 * "새 셸을 열고 claude 를 쳤는데 안 따라온다"가 되어 기능이 고장 난 것처럼 보인다.
 */
export const AI_REVEAL_GRACE_MS = 10_000

/**
 * ① AI 를 켜면 사이드바가 [AI] 로 간다(2026-09-01 준영님).
 *
 * ⚠️ 옮기는 것은 **사이드바 뷰뿐**이다. 터미널 탭은 그 자리에 둔다 — `docs/orca-analysis.md` §3 이
 * 그걸 명시적으로 거부한다("탭이 AI 영역으로 이동하면 사용자 밑에서 물건이 움직인다"). 여기서
 * 하는 일은 **방금 시작된 AI 가 목록에 뜬 것을 보여 주는 것**이다.
 *
 * 화면을 뺏는 기능이라 규칙이 곧 전부다:
 *  ① 이미 [AI] 를 보고 있으면 아무 일도 하지 않는다
 *  ② 사이드바를 방금 다른 것으로 바꿨으면 쉰다 — **파일을 뒤지는 중에 화면이 바뀌는 것이 제일 나쁘다**
 *  ③ **접힘을 건드리지 않는다.** 접은 것은 의도다 — 접힌 채로 [AI] 를 활성만 해 둔다
 *     (그래서 patch 에 `collapsed` 가 없다. 다음에 펴면 [AI] 가 나온다)
 *  ④ 처음 한 번만. claude 는 도구를 부를 때마다 상태를 보내므로, 매번 튀면 못 쓴다
 *
 * 돌려주는 `known` 은 **지금 목록에 있는 것 전부**다: 사라진 세션은 잊는다(그 id 는 다시 오지
 * 않고, 안 잊으면 집합이 앱 수명 동안 자란다).
 */
export function revealAiTab(args: {
  /** 지금 AI 가 도는 세션 id 들 — 작업대 목록에 줄이 있는 것(훅이 말을 걸어 온 것 포함). */
  live: readonly string[]
  /** 이미 한 번 본 id 들. */
  known: ReadonlySet<string>
  activeTab: SidebarState['activeTab']
  /** 사이드바를 [AI] 아닌 것으로 바꾼 마지막 시각(0 = 없음). */
  switchedAt: number
  now: number
}): { patch: Partial<SidebarState> | null; known: Set<string> } {
  const known = new Set(args.live)
  const fresh = args.live.some((id) => !args.known.has(id))
  const go = fresh && args.activeTab !== 'ai' && args.now - args.switchedAt >= AI_REVEAL_GRACE_MS
  return { patch: go ? { activeTab: 'ai' } : null, known }
}

/**
 * workspace.json 의 ui.sidebar(손으로 고쳤거나 옛 앱이 쓴 값)를 화면 상태로. 파일은 신뢰 경계 밖이다 —
 * 모르는 탭·범위 밖 폭·모르는 하단 탭은 기본값으로 눌러 담는다.
 */
export function hydrateSidebar(s: Partial<SidebarState>): SidebarState {
  // FB-ui2: 옛 스냅샷의 activeTab='monitor'(이관 전 세 번째 탭)는 conn 으로 되돌린다 —
  // 안 그러면 두 탭 다 active 매치가 안 돼 사이드바가 빈 채로 뜬다.
  const activeTab = s.activeTab === 'file' || s.activeTab === 'ai' ? s.activeTab : 'conn'
  const next: SidebarState = {
    ...DEFAULT_SIDEBAR,
    ...s,
    collapsed: s.collapsed === true,
    activeTab,
    width: clampSidebarWidth(typeof s.width === 'number' ? s.width : DEFAULT_SIDEBAR.width)
  }
  // #13: null(접힘)·알려진 탭만 남긴다. 그 밖은 "저장된 적 없음"으로 — 옛 동작으로 돌아간다.
  if (!(s.bottom === null || (typeof s.bottom === 'string' && isBottomId(s.bottom as BottomId)))) delete next.bottom
  return next
}

/**
 * #13 첫 세션이 생길 때 하단 패널을 무엇으로 열까. 지난번에 **접고 끝냈으면(null) 열지 않는다** —
 * 사용자가 끈 것을 앱이 되돌리면 안 된다. 저장된 적 없으면(undefined) 옛 동작(보던 탭 = fallback).
 */
export function bootBottom(saved: BottomId | null | undefined, fallback: BottomId): BottomId | null {
  return saved === null ? null : (saved ?? fallback)
}

export function useSidebar() {
  const [sidebar, setSidebar] = useState<SidebarState>(DEFAULT_SIDEBAR)
  // ① 자동 전환의 기억 둘. 상태가 아니라 **판정 재료**라 ref 다 — 바뀌었다고 다시 그릴 것이 없다.
  const switchedAt = useRef(0)
  const knownAi = useRef<ReadonlySet<string>>(new Set())
  // 판정은 setState 업데이터 **밖에서** 한다: 안에서 하면 StrictMode 의 이중 호출이 knownAi 를
  // 두 번 갱신해 두 번째가 "새 것 없음"이 되고, 개발 중에만 기능이 죽는다.
  const cur = useRef(sidebar)
  cur.current = sidebar

  // #13: 하이드레이트가 끝났나. 하단 패널 저장·첫 세션 자동 열기가 이걸 기다린다 — 그 전에 돌면
  // 기본값(저장된 적 없음)으로 판정하고, 저장된 "접힘"을 덮어쓴다.
  const [loaded, setLoaded] = useState(false)

  // 초기 하이드레이트. 옛 스냅샷에 sidebar 가 없거나 폭이 범위 밖이면 기본값으로 눌러 담는다.
  useEffect(() => {
    if (!window.ev) return setLoaded(true)
    window.ev.workspace
      .load()
      .then((snap) => {
        const s = snap.ui.sidebar
        if (s) setSidebar(hydrateSidebar(s))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // 갱신 + 영속. 함수형 patch 를 받는 이유: 접기 토글이 단축키 이펙트 안에서 현재 값을 필요로 한다.
  const update = useCallback((patch: Partial<SidebarState> | ((prev: SidebarState) => Partial<SidebarState>)) => {
    setSidebar((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      // ① 자동 전환이 이걸 뺏지 않게, **[AI] 아닌 것으로 바꾼** 순간을 기억한다. 손으로 고른 것
      // (레일·단축키)만이 아니라 앱이 보여 주기로 한 것(붙여넣기 업로드 → [파일])도 같이 센다 —
      // 둘 다 "지금 사용자 눈이 거기 있다"는 뜻이고, 뺏으면 안 되는 이유가 같다.
      // 같은 prev 를 두 번 봐도 결과가 같아(멱등) StrictMode 이중 호출이 문제되지 않는다.
      if (next.activeTab !== prev.activeTab && next.activeTab !== 'ai') switchedAt.current = Date.now()
      // 하네스(ui:setSidebar 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
      window.ev?.ui.setSidebar(next).catch(() => {})
      return next
    })
  }, [])

  /**
   * ① AI 가 목록에 새로 떴다 — 사이드바를 [AI] 로. 판정은 `revealAiTab` 혼자 한다.
   * **매 tick 불러도 된다**: 새 세션 id 가 없으면 아무 일도 일어나지 않는다(함정 ④).
   */
  const revealAi = useCallback(
    (live: readonly string[]) => {
      const r = revealAiTab({
        live,
        known: knownAi.current,
        activeTab: cur.current.activeTab,
        switchedAt: switchedAt.current,
        now: Date.now()
      })
      knownAi.current = r.known
      if (r.patch) update(r.patch)
    },
    [update]
  )

  // 드래그 중(매 mousemove)에는 저장하지 않고 화면만 바꾼다 — 놓을 때 update 로 한 번 저장한다.
  const preview = useCallback((width: number) => setSidebar((prev) => ({ ...prev, width })), [])

  return { sidebar, loaded, update, preview, revealAi }
}
