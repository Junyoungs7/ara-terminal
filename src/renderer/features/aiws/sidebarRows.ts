// M2 라운드 2 WS-05 — 사이드바 줄 만들기(순수 함수, 화면 없이 시험한다).
// Orca src/shared/sidebar-list/*·components/sidebar/compute-visible-worktrees.ts(orcaRef 7a7f46f8a3)의 핵심만:
//  · 고정(pinned) 묶음이 맨 위 — 고정한 줄은 제 프로젝트 묶음에서 빠진다(Orca pinnedInGroups=false 기본값).
//  · 묶기 repo(프로젝트별 머리줄) | none(전체 한 묶음). 만드는 중(PENDING) 줄은 그 프로젝트 머리줄 바로 아래.
//  · 이름 검색 필터 — 워크트리 이름·브랜치·경로·프로젝트 이름 부분 일치(대소문자 무시).
//  · 정렬 — 본 작업 폴더가 먼저, 나머지는 이름순.
// 뺀 것: 프로젝트 그룹(폴더 묶음)·계보(lineage) 들여쓰기·상태별 묶기·잠든 워크트리 숨기기·호스트별 갈래·수동 정렬.
import type { Project, Worktree } from '@shared/worktrees'
import type { PendingWorktreeCreation, SidebarGroupBy } from './store'

export type SidebarRow =
  | { kind: 'header'; key: string; group: 'pinned' | 'all' | 'repo'; repo?: Project; count: number }
  | { kind: 'item'; key: string; worktree: Worktree; repo: Project; pinned: boolean; showProject: boolean }
  | { kind: 'pending'; key: string; creation: PendingWorktreeCreation }

export type SidebarInput = {
  repos: readonly Project[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
  pending: readonly PendingWorktreeCreation[]
  pinnedIds: readonly string[]
  query: string
  groupBy: SidebarGroupBy
}

export const shortBranch = (w: Pick<Worktree, 'branch'>): string => w.branch.replace(/^refs\/heads\//, '')

export function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMainWorktree !== b.isMainWorktree) return a.isMainWorktree ? -1 : 1
  return a.displayName.localeCompare(b.displayName, 'ko') || a.path.localeCompare(b.path)
}

export function matchesQuery(q: string, w: Worktree, repo: Project): boolean {
  if (!q) return true
  return [w.displayName, shortBranch(w), w.path, repo.displayName].some((s) => s.toLowerCase().includes(q))
}

export function buildSidebarRows(input: SidebarInput): SidebarRow[] {
  const q = input.query.trim().toLowerCase()
  const pins = new Set(input.pinnedIds)
  const repoById = new Map(input.repos.map((r) => [r.id, r]))
  const visible = (repo: Project) => [...(input.worktreesByRepo[repo.id] ?? [])].filter((w) => matchesQuery(q, w, repo)).sort(compareWorktrees)
  const pendingOf = (repoId: string) =>
    input.pending.filter((p) => p.repoId === repoId && (!q || p.name.toLowerCase().includes(q))).sort((a, b) => a.startedAt - b.startedAt)
  const item = (w: Worktree, repo: Project, pinned: boolean, showProject: boolean, prefix: string): SidebarRow => ({
    kind: 'item',
    key: `${prefix}|${w.id}`,
    worktree: w,
    repo,
    pinned,
    showProject
  })

  const rows: SidebarRow[] = []
  // 고정 — 프로젝트를 섞어 담으니 줄마다 프로젝트 이름을 붙인다.
  const pinned = input.repos
    .flatMap((repo) => visible(repo).filter((w) => pins.has(w.id)))
    .sort(compareWorktrees)
  if (pinned.length > 0) {
    rows.push({ kind: 'header', key: 'pinned', group: 'pinned', count: pinned.length })
    for (const w of pinned) rows.push(item(w, repoById.get(w.repoId) as Project, true, true, 'pinned'))
  }

  if (input.groupBy === 'none') {
    const rest = input.repos.flatMap((repo) => visible(repo).filter((w) => !pins.has(w.id))).sort(compareWorktrees)
    const pend = input.repos.flatMap((repo) => pendingOf(repo.id))
    if (rest.length + pend.length === 0) return rows
    rows.push({ kind: 'header', key: 'all', group: 'all', count: rest.length })
    for (const p of pend) rows.push({ kind: 'pending', key: `pending:${p.creationId}`, creation: p })
    for (const w of rest) rows.push(item(w, repoById.get(w.repoId) as Project, false, true, 'all'))
    return rows
  }

  for (const repo of input.repos) {
    const list = visible(repo).filter((w) => !pins.has(w.id))
    const pend = pendingOf(repo.id)
    // 검색 중이면 맞는 줄이 없는 프로젝트는 머리줄도 숨긴다(검색이 아니면 빈 프로젝트도 보여야 + 를 누른다).
    if (q && list.length + pend.length === 0 && !repo.displayName.toLowerCase().includes(q)) continue
    rows.push({ kind: 'header', key: `repo:${repo.id}`, group: 'repo', repo, count: list.length })
    for (const p of pend) rows.push({ kind: 'pending', key: `pending:${p.creationId}`, creation: p })
    for (const w of list) rows.push(item(w, repo, false, false, `repo:${repo.id}`))
  }
  return rows
}
