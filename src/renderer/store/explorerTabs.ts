// 파일 탐색기 탭 — "위치 하나 = 탭 하나". 서버를 여러 개 열어 두고 오가며 복사·붙여넣기 하려는
// 요구(준영님 2026-08-07)의 뼈대다. 순수 로직만 두고 화면은 ExplorerView 가 그린다(단위 테스트 대상).
//
// 탭이 세션이 아니라 **타깃**을 들고 있는 이유: 같은 서버에 SSH 세션이 여러 개일 수 있는데 파일
// 탐색기 입장에선 다 같은 파일시스템이다 — 프로필당 한 탭이면 충분하고, 그래야 "이 서버 탭"이
// 세션을 닫아도 흔들리지 않는다.

export type ExpTarget = { kind: 'local' } | { kind: 'ssh'; profileId: string }

export type ExpTab = {
  id: string
  target: ExpTarget
  label: string
  /** 열자마자 갈 폴더(즐겨찾기·작업 프로필). 한 번 쓰고 나면 FileTree 가 자기 경로를 갖는다. */
  goto?: string
}

export const LOCAL_TARGET: ExpTarget = { kind: 'local' }

export function sameTarget(a: ExpTarget, b: ExpTarget): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'local' || a.profileId === (b as { profileId: string }).profileId
}

export function findTab(tabs: readonly ExpTab[], target: ExpTarget): ExpTab | undefined {
  return tabs.find((t) => sameTarget(t.target, target))
}

/**
 * 탭 열기. 같은 위치가 이미 있으면 새로 만들지 않고 그 탭을 활성화한다(탐색기 관례 — 같은 서버를
 * 두 번 눌렀다고 탭이 둘 생기면 금방 지저분해진다). goto 가 있으면 기존 탭도 그 폴더로 보낸다.
 */
export function openTab(tabs: readonly ExpTab[], tab: ExpTab): { tabs: ExpTab[]; activeId: string } {
  const found = findTab(tabs, tab.target)
  if (found) {
    const next = tab.goto ? tabs.map((t) => (t.id === found.id ? { ...t, goto: tab.goto } : t)) : [...tabs]
    return { tabs: next, activeId: found.id }
  }
  return { tabs: [...tabs, tab], activeId: tab.id }
}

/**
 * 탭 닫기. 마지막 한 장은 닫지 않는다 — 빈 창은 보여 줄 것이 없고, 사용자는 창 자체를 닫으면 된다.
 * 활성 탭을 닫으면 **오른쪽 이웃**으로 옮긴다(없으면 왼쪽) — 브라우저·편집기 공통 관례.
 */
export function closeTab(
  tabs: readonly ExpTab[],
  activeId: string,
  id: string
): { tabs: ExpTab[]; activeId: string } {
  if (tabs.length <= 1) return { tabs: [...tabs], activeId }
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return { tabs: [...tabs], activeId }
  const next = tabs.filter((t) => t.id !== id)
  if (id !== activeId) return { tabs: next, activeId }
  return { tabs: next, activeId: (next[idx] ?? next[idx - 1]).id }
}

// ── 창 위치·크기 ────────────────────────────────────────────────────────────
// 팝업 창이라 화면 밖으로 끌고 나갈 수 있다 — 제목줄이 남아 있어야 다시 잡을 수 있으므로
// 항상 일정 폭·높이는 화면 안에 남긴다.
export type Rect = { x: number; y: number; w: number; h: number }

export const EXP_MIN_W = 640
export const EXP_MIN_H = 380
const KEEP_VISIBLE = 120 // 화면 안에 반드시 남겨 둘 제목줄 폭
const HEADROOM = 4 // 제목줄이 위로 완전히 빠져나가지 않게

export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = Math.round(Math.min(Math.max(r.w, EXP_MIN_W), Math.max(EXP_MIN_W, vw)))
  const h = Math.round(Math.min(Math.max(r.h, EXP_MIN_H), Math.max(EXP_MIN_H, vh)))
  return {
    w,
    h,
    x: Math.round(Math.min(Math.max(r.x, KEEP_VISIBLE - w), vw - KEEP_VISIBLE)),
    y: Math.round(Math.min(Math.max(r.y, HEADROOM), Math.max(HEADROOM, vh - KEEP_VISIBLE)))
  }
}

/** 처음 열 때 — 화면의 대부분을 쓰되 뒤가 비치게 여백을 남긴다. */
export function initialRect(vw: number, vh: number): Rect {
  const w = Math.min(1040, Math.round(vw * 0.82))
  const h = Math.min(660, Math.round(vh * 0.8))
  return clampRect({ w, h, x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2) }, vw, vh)
}
