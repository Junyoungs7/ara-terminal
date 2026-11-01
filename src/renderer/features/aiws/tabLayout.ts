// M11 R2 앱 재시작·업데이트 뒤 에이전트 탭 레이아웃(탭 순서 · 작업 단위마다 고른 탭 · 고른 작업 단위)을 되살린다(Orca: 패인 배치·포커스 복원).
// 세션은 main(데몬·콜드 복원)이 되살리고, 자리는 여기 — 이 PC 의 보기 상태라 localStorage(핀·묶기와 같은 자리).
// 콜드 복원으로 다시 띄운 탭은 id 가 바뀐다 — idMap(옛 → 새)으로 자리를 찾는다.
export const TAB_LAYOUT_KEY = 'aiws.agentTabLayout'

export type TabLayout = { order: string[]; active: Record<string, string>; worktree: string | null }

const isLayout = (v: unknown): v is TabLayout => {
  const x = v as TabLayout | null
  return !!x && Array.isArray(x.order) && x.order.every((s) => typeof s === 'string') && !!x.active && typeof x.active === 'object' && (x.worktree === null || typeof x.worktree === 'string')
}

export function readTabLayout(): TabLayout | null {
  try {
    const raw = localStorage.getItem(TAB_LAYOUT_KEY)
    const v: unknown = raw === null ? null : JSON.parse(raw)
    return isLayout(v) ? v : null
  } catch {
    return null
  }
}

export function writeTabLayout(l: TabLayout): void {
  try {
    localStorage.setItem(TAB_LAYOUT_KEY, JSON.stringify(l))
  } catch {
    // 저장 못 해도 이번 창은 그대로
  }
}

/** 저장한 순서로 탭을 세운다. 저장에 없던 탭은 지금 순서 그대로 뒤에. */
export function orderTabs<T extends { sessionId: string }>(tabs: readonly T[], layout: TabLayout, idMap: ReadonlyMap<string, string>): T[] {
  const rank = new Map(layout.order.map((id, i) => [idMap.get(id) ?? id, i]))
  const at = (t: T, i: number): number => rank.get(t.sessionId) ?? layout.order.length + i
  return tabs.map((t, i) => [t, at(t, i)] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0])
}

/** 작업 단위마다 고른 탭 — 저장한 것이 지금 그 작업 단위에 있으면 그것, 아니면 지금 값. */
export function restoreActive(tabs: readonly { sessionId: string; worktreeId: string }[], layout: TabLayout, idMap: ReadonlyMap<string, string>, current: Record<string, string>): Record<string, string> {
  const out = { ...current }
  for (const [wt, old] of Object.entries(layout.active)) {
    const id = idMap.get(old) ?? old
    if (tabs.some((t) => t.sessionId === id && t.worktreeId === wt)) out[wt] = id
  }
  return out
}

/** 저장할 레이아웃. 아직 자리를 못 찾은 탭(워크트리 목록이 늦음)의 순서·고른 탭·고른 작업 단위는 지난 것을 그대로 들고 간다 — 덮어써 잃지 않게. */
export function layoutOf(tabs: readonly { sessionId: string }[], active: Record<string, string>, worktree: string | null, prev: TabLayout | null, pending: ReadonlySet<string>): TabLayout {
  const kept = (prev?.order ?? []).filter((id) => pending.has(id))
  const keptActive = Object.fromEntries(Object.entries(prev?.active ?? {}).filter(([, id]) => pending.has(id)))
  return { order: [...tabs.map((t) => t.sessionId), ...kept], active: { ...keptActive, ...active }, worktree: worktree ?? (pending.size ? (prev?.worktree ?? null) : null) }
}
