// M2 라운드 2 WS-05 — 사이드바 줄 만들기(순수 함수, 화면 없이 시험한다).
// Orca src/shared/sidebar-list/*·components/sidebar/compute-visible-worktrees.ts(orcaRef 7a7f46f8a3)의 핵심만:
//  · 고정(pinned) 묶음이 맨 위 — 고정한 줄은 제 프로젝트 묶음에서 빠진다(Orca pinnedInGroups=false 기본값).
//  · 묶기 repo(프로젝트별 머리줄) | none(전체 한 묶음). 만드는 중(PENDING) 줄은 그 프로젝트 머리줄 바로 아래.
//  · 이름 검색 필터 — 워크트리 이름·브랜치·경로·프로젝트 이름 부분 일치(대소문자 무시).
//  · 정렬 — 본 작업 폴더가 먼저, 나머지는 이름순.
// M10: 프로젝트 그룹(WS-15 — Orca group-by-repo 골든의 `project-group:` 머리줄 아래 프로젝트 머리줄이 한 칸 들어감, 접으면 머리줄만),
//      보관(WS-16 — 보관한 줄은 빠지고, 보관함 보기면 보관한 줄만 한 묶음).
// 뺀 것: 그룹 중첩·계보(lineage) 들여쓰기·상태별 묶기·잠든 워크트리 숨기기(Orca 기본값 꺼짐)·호스트별 갈래·수동 정렬.
import type { Project, ProjectGroup, Worktree } from '@shared/worktrees'
import { isMac } from '@shared/keymap'
import type { PendingWorktreeCreation, SidebarGroupBy } from './store'

export type SidebarRow =
  | { kind: 'header'; key: string; group: 'pinned' | 'all' | 'repo' | 'group' | 'archived'; repo?: Project; projectGroup?: ProjectGroup; depth?: number; count: number }
  | { kind: 'item'; key: string; worktree: Worktree; repo: Project; pinned: boolean; showProject: boolean }
  | { kind: 'pending'; key: string; creation: PendingWorktreeCreation }

export type SidebarInput = {
  repos: readonly Project[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
  pending: readonly PendingWorktreeCreation[]
  pinnedIds: readonly string[]
  query: string
  groupBy: SidebarGroupBy
  groups?: readonly ProjectGroup[]
  /** 보관함 보기 — 보관한 줄만. */
  showArchived?: boolean
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
  const archivedView = input.showArchived === true
  const visible = (repo: Project) =>
    [...(input.worktreesByRepo[repo.id] ?? [])].filter((w) => !!w.isArchived === archivedView && matchesQuery(q, w, repo)).sort(compareWorktrees)
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
  if (archivedView) {
    const list = input.repos.flatMap((repo) => visible(repo)).sort(compareWorktrees)
    if (list.length === 0) return rows
    rows.push({ kind: 'header', key: 'archived', group: 'archived', count: list.length })
    for (const w of list) rows.push(item(w, repoById.get(w.repoId) as Project, pins.has(w.id), true, 'archived'))
    return rows
  }
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

  const projectBlock = (repo: Project, depth: number): SidebarRow[] | null => {
    const list = visible(repo).filter((w) => !pins.has(w.id))
    const pend = pendingOf(repo.id)
    // 검색 중이면 맞는 줄이 없는 프로젝트는 머리줄도 숨긴다(검색이 아니면 빈 프로젝트도 보여야 + 를 누른다).
    if (q && list.length + pend.length === 0 && !repo.displayName.toLowerCase().includes(q)) return null
    return [
      { kind: 'header', key: `repo:${repo.id}`, group: 'repo', repo, depth, count: list.length },
      ...pend.map((p): SidebarRow => ({ kind: 'pending', key: `pending:${p.creationId}`, creation: p })),
      ...list.map((w) => item(w, repo, false, false, `repo:${repo.id}`))
    ]
  }
  const groups = input.groups ?? []
  const known = new Set(groups.map((g) => g.id))
  for (const g of groups) {
    const blocks = input.repos.filter((r) => r.groupId === g.id).flatMap((r) => projectBlock(r, 1) ?? [])
    const projects = blocks.filter((r) => r.kind === 'header').length
    // 검색 중엔 맞는 프로젝트가 없는 그룹을 숨긴다. 아니면 빈 그룹도 보인다(지우거나 프로젝트를 옮겨 넣게).
    if (q && projects === 0 && !g.name.toLowerCase().includes(q)) continue
    rows.push({ kind: 'header', key: `project-group:${g.id}`, group: 'group', projectGroup: g, count: projects })
    if (!g.isCollapsed) rows.push(...blocks)
  }
  for (const repo of input.repos) if (!repo.groupId || !known.has(repo.groupId)) rows.push(...(projectBlock(repo, 0) ?? []))
  return rows
}

/** M10 WS-17 Orca `workspace.delete` 기본 키(Mod+Shift+Backspace — 터미널의 D 분할 키를 피한 자리). 맥은 Cmd. */
export const DELETE_KEY_HINT = isMac() ? '⌘⇧⌫' : 'Ctrl+Shift+Backspace'
export function isDeleteWorkspaceKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>, mac = isMac()): boolean {
  return e.key === 'Backspace' && e.shiftKey && !e.altKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
}
