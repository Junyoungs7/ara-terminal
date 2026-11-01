// M12 CV-03 워크트리 점프 목록 — 순수(단위 시험 대상). 출처: stablyai/orca @fdfcfb3551 (MIT) src/renderer/src/lib/order-empty-query-worktrees.ts·worktree-palette-search.ts.
import type { Project, Worktree } from '@shared/worktrees'
import { scoreQuickOpen } from '@shared/codeSearch'
import { shortBranch } from './sidebarRows'

/** 점프 목록 — 순수(단위 시험 대상). 빈 검색: 지금 것을 빼고 다녀간 것(최근 순) → 나머지(이름 순). 검색: 이름·브랜치·저장소·호스트 퍼지 점수 순. */
export function jumpList(
  worktrees: readonly Worktree[],
  repos: readonly Pick<Project, 'id' | 'displayName' | 'host'>[],
  activeId: string | null,
  query: string,
  visitedAt: ReadonlyMap<string, number>
): Worktree[] {
  const others = worktrees.filter((w) => w.id !== activeId)
  if (!query.trim()) {
    return [...others].sort((a, b) => {
      const va = visitedAt.get(a.id)
      const vb = visitedAt.get(b.id)
      if (va !== undefined && vb !== undefined) return vb - va
      if (va !== undefined) return -1
      if (vb !== undefined) return 1
      return a.displayName.localeCompare(b.displayName, 'ko', { numeric: true })
    })
  }
  const hay = (w: Worktree): string => {
    const r = repos.find((x) => x.id === w.repoId)
    return [r?.displayName, w.displayName, shortBranch(w), r?.host].filter(Boolean).join(' ')
  }
  return others
    .map((w) => ({ w, s: scoreQuickOpen(query, hay(w)) }))
    .filter((x): x is { w: Worktree; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.w)
}

