// M2 라운드 2 WS-05 — 사이드바 줄 만들기(순수 함수, 화면 없이 시험한다).
// Orca src/shared/sidebar-list/*·components/sidebar/compute-visible-worktrees.ts(orcaRef 7a7f46f8a3)의 핵심만:
//  · 고정(pinned) 묶음이 맨 위 — 고정한 줄은 제 프로젝트 묶음에서 빠진다(Orca pinnedInGroups=false 기본값).
//  · 묶기 repo(프로젝트별 머리줄) | none(전체 한 묶음). 만드는 중(PENDING) 줄은 그 프로젝트 머리줄 바로 아래.
//  · 이름 검색 필터 — 워크트리 이름·브랜치·경로·프로젝트 이름 부분 일치(대소문자 무시).
//  · 정렬 — 본 작업 폴더가 먼저, 나머지는 이름순.
// M10: 프로젝트 그룹(WS-15 — Orca group-by-repo 골든의 `project-group:` 머리줄 아래 프로젝트 머리줄이 한 칸 들어감, 접으면 머리줄만),
//      보관(WS-16 — 보관한 줄은 빠지고, 보관함 보기면 보관한 줄만 한 묶음).
// M10 R2: 숨은 아라 밖 워크트리(WS-19 — 줄에서 빼고 프로젝트 머리줄 아래 "숨은 워크트리 n개" 카드 한 줄, Orca hidden worktrees card).
// M15 R2 WS-22: 호스트별 묶음(Orca host sections — 호스트 머리줄 아래 그 호스트의 고정·프로젝트 줄). 호스트가 둘 이상일 때만(로컬만이면 예전 그대로).
//   호스트 순서·이름은 store/hostSections.ts(터미널 사이드바 그룹과 같은 구현).
// 뺀 것: 그룹 중첩·계보(lineage) 들여쓰기·상태별 묶기·잠든 워크트리 숨기기(Orca 기본값 꺼짐)·수동 정렬.
import type { Project, ProjectGroup, Worktree } from '@shared/worktrees'
import { isMac } from '@shared/keymap'
import type { PendingWorktreeCreation, SidebarGroupBy } from './store'
import { LOCAL_HOST, type HostSection } from '../../store/hostSections'

export type SidebarRow =
  | { kind: 'header'; key: string; group: 'pinned' | 'all' | 'repo' | 'group' | 'archived' | 'host'; repo?: Project; projectGroup?: ProjectGroup; host?: HostSection; collapsed?: boolean; depth?: number; count: number }
  | { kind: 'item'; key: string; worktree: Worktree; repo: Project; pinned: boolean; showProject: boolean }
  | { kind: 'pending'; key: string; creation: PendingWorktreeCreation }
  | { kind: 'hidden'; key: string; repo: Project; count: number }

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
  /** M15 R2 WS-22 호스트 순서(hostSections). 둘 이상이면 호스트 머리줄로 묶는다. */
  hosts?: readonly HostSection[]
  /** 접은 호스트 key — 머리줄만 남는다. */
  collapsedHosts?: readonly string[]
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
  if (input.hosts && input.hosts.length > 1 && !input.showArchived) return hostRows(input, input.hosts)
  const q = input.query.trim().toLowerCase()
  const pins = new Set(input.pinnedIds)
  const repoById = new Map(input.repos.map((r) => [r.id, r]))
  const archivedView = input.showArchived === true
  const visible = (repo: Project) =>
    [...(input.worktreesByRepo[repo.id] ?? [])].filter((w) => !w.hidden && !!w.isArchived === archivedView && matchesQuery(q, w, repo)).sort(compareWorktrees)
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
    // 숨은 것은 검색과 무관하게 센다(보관한 것은 안 센다 — 보관함에 있다).
    const hidden = (input.worktreesByRepo[repo.id] ?? []).filter((w) => w.hidden && !w.isArchived).length
    return [
      { kind: 'header', key: `repo:${repo.id}`, group: 'repo', repo, depth, count: list.length },
      ...pend.map((p): SidebarRow => ({ kind: 'pending', key: `pending:${p.creationId}`, creation: p })),
      ...list.map((w) => item(w, repo, false, false, `repo:${repo.id}`)),
      ...(hidden > 0 && !q ? [{ kind: 'hidden', key: `hidden:${repo.id}`, repo, count: hidden } as const] : [])
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

/** 호스트마다 그 호스트 저장소만으로 줄을 만들고 머리줄을 얹는다. 키에 호스트를 붙인다(고정·전체 머리줄이 호스트마다 하나씩 생긴다). */
function hostRows(input: SidebarInput, hosts: readonly HostSection[]): SidebarRow[] {
  const folded = new Set(input.collapsedHosts ?? [])
  const searching = input.query.trim().length > 0
  const rows: SidebarRow[] = []
  for (const h of hosts) {
    const repos = input.repos.filter((r) => (r.host ?? LOCAL_HOST) === h.key)
    // 빈 프로젝트 그룹은 로컬 묶음에만(어느 호스트 것도 아니다) — 서버 묶음에는 그 서버 프로젝트가 든 그룹만.
    const groups = h.key === LOCAL_HOST ? input.groups : input.groups?.filter((g) => repos.some((r) => r.groupId === g.id))
    const sub = buildSidebarRows({ ...input, repos, groups, hosts: undefined })
    if (searching && sub.length === 0) continue
    const collapsed = folded.has(h.key)
    rows.push({ kind: 'header', key: `host:${h.key}`, group: 'host', host: h, collapsed, count: sub.filter((r) => r.kind === 'item').length })
    if (!collapsed) for (const r of sub) rows.push({ ...r, key: `${h.key}|${r.key}` } as SidebarRow)
  }
  return rows
}

/** M10 WS-17 Orca `workspace.delete` 기본 키(Mod+Shift+Backspace — 터미널의 D 분할 키를 피한 자리). 맥은 Cmd. */
export const DELETE_KEY_HINT = isMac() ? '⌘⇧⌫' : 'Ctrl+Shift+Backspace'
export function isDeleteWorkspaceKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>, mac = isMac()): boolean {
  return e.key === 'Backspace' && e.shiftKey && !e.altKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
}
