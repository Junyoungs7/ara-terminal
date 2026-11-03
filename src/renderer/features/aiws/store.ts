// M2 작업 단위 — 렌더러 상태 저장소(zustand 5). Orca src/renderer/src/store/slices/repos.ts·worktrees.ts(orcaRef 7a7f46f8a3)의
// 슬라이스 모양·이름(repos · worktreesByRepo · activeWorktreeId · pendingWorktreeCreations)을 따른다. 1차 범위만:
// 라운드 2(WS-05): 핀·묶기 방식·+/− 통계를 더했다. 읽음·감지 스캔·호스트 소유·PR 연동은 2차.
// 이 파일은 AI 작업 공간 청크(features/aiws)에 산다 — 처음 열 때만 불러오고, 그때 진행 이벤트를 한 번 구독한다.
import { create, type StateCreator } from 'zustand'
import type {
  CreateWorktreeProgressEvent,
  CreateWorktreeResult,
  PreservedBranch,
  Project,
  ProjectGroup,
  ProjectUpdate,
  RemoveWorktreeResult,
  Worktree,
  WorktreeCheckoutProgress,
  WorktreeMeta,
  WorktreeMetaUpdate,
  WorktreeStats
} from '@shared/worktrees'
import { WORKTREE_ID_SEPARATOR, composeWorktreeId } from '@shared/worktrees'
import { creatureNameTier, normalizeSuggestedName, suggestionPathBasename } from '@shared/worktreeNames'
import { pushNote } from '../../store/notify'
import { t } from '../../i18n'

/** M10 R2 WS-21 지운 작업 단위에서 git 이 남긴 브랜치 하나(Orca PreservedBranchCleanup). 이 창이 사는 동안만 — 브랜치는 저장소에 그대로 있다. */
export type PreservedBranchItem = PreservedBranch & { repoId: string; worktreeId: string; worktreeName: string }

/** Orca PendingWorktreeCreation(src/renderer/src/lib/pending-worktree-creation.ts)의 1차 부분집합. */
export type PendingWorktreeCreation = {
  creationId: string
  repoId: string
  name: string
  /** [다시] 가 같은 값으로 다시 만들 수 있게. */
  baseBranch?: string
  /** M10 WS-14 자동 이름이었나([다시]도 지운 이름을 건너뛰게). */
  nameWasGenerated?: boolean
  /** 3차 WS-24·27·23 [다시] 가 같은 부모·sparse 폴더·setup 으로 다시 만들게. */
  parentWorktreeId?: string
  sparseDirectories?: string[]
  runSetup?: boolean
  startedAt: number
  phase: CreateWorktreeProgressEvent['phase']
  path?: string
  branch?: string
  checkout?: WorktreeCheckoutProgress | null
  /** git 출력 꼬리(화면에 펼쳐 볼 수 있게). */
  output: string
  error?: string
}

// 출력은 꼬리만 — 큰 체크아웃이 진행 막대를 수천 줄 찍는다.
const OUTPUT_TAIL_CHARS = 4000

// 핀·묶기 방식은 이 PC 의 보기 설정이다(Orca 는 worktree meta 로 main 에 둔다 — 여러 창·기기 동기화가 필요해지면 옮긴다).
const PINS_KEY = 'aiws.pinnedWorktrees'
const GROUP_KEY = 'aiws.groupBy'
const HOSTS_FOLDED_KEY = 'aiws.collapsedHosts'
// 3차 WS-24 접은 부모(자식 줄 숨김) — Orca "N children" 칩의 접힘. 이 PC 의 보기 설정.
const LINEAGE_FOLDED_KEY = 'aiws.collapsedLineage'
export type SidebarGroupBy = 'repo' | 'none'

function readLocal<T>(key: string, fallback: T, ok: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key)
    const v: unknown = raw === null ? null : JSON.parse(raw)
    return ok(v) ? v : fallback
  } catch {
    return fallback
  }
}
function writeLocal(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    // 저장 못 해도 이번 창에서는 그대로 쓴다
  }
}
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isGroupBy = (v: unknown): v is SidebarGroupBy => v === 'repo' || v === 'none'

export type SidebarSlice = {
  pinnedIds: string[]
  groupBy: SidebarGroupBy
  statsById: Record<string, WorktreeStats>
  /** M10 WS-16 보관함 보기(보관한 작업 단위만 보이고 [복원]). 이 창의 보기 상태 — 저장 안 함. */
  showArchived: boolean
  setShowArchived: (on: boolean) => void
  togglePin: (worktreeId: string) => void
  setGroupBy: (g: SidebarGroupBy) => void
  /** M15 R2 WS-22 접은 호스트 묶음(이 PC 의 보기 설정 — 핀과 같은 자리). */
  collapsedHosts: string[]
  toggleHost: (hostKey: string) => void
  /** +/− 줄 수 · 커밋 앞(행마다 git 3번 — 목록을 다시 읽을 때만). */
  fetchStats: (w: Worktree) => Promise<void>
  /** 3차 WS-24 자식 줄을 접은 부모 id. */
  collapsedLineage: string[]
  toggleLineage: (worktreeId: string) => void
  /** 3차 WS-24 "하위 작업 만들기" — 새 작업 카드가 열릴 때 부모 칸에 미리 넣는다(카드가 읽고 비운다). */
  composerParentId: string | null
  setComposerParent: (worktreeId: string | null) => void
}

export type RepoSlice = {
  repos: Project[]
  fetchRepos: () => Promise<void>
  addRepo: (path: string) => Promise<Project | null>
  /** OS 폴더 고르기 → 등록 → 그 워크트리 불러오기. 취소면 null. */
  pickAndAddRepo: () => Promise<Project | null>
  /** M8 DM-04 관리형 서버의 원격 저장소 등록 → 그 워크트리 불러오기. 실패면 사유 글. */
  addRemoteRepo: (hostKey: string, path: string) => Promise<Project | string>
  removeRepo: (repoId: string) => Promise<void>
  /** M10 R2 WS-19·20 프로젝트 설정(아라 밖 워크트리 보이기·공유 경로) — 바꾸면 그 목록을 다시 읽는다(숨김이 바뀐다). */
  updateRepo: (repoId: string, updates: ProjectUpdate) => Promise<Project | null>
  /** M10 WS-15 프로젝트 그룹(Orca projectGroups 슬라이스 이름). */
  groups: ProjectGroup[]
  fetchGroups: () => Promise<void>
  createProjectGroup: (name: string) => Promise<ProjectGroup | null>
  updateProjectGroup: (groupId: string, updates: { name?: string; isCollapsed?: boolean }) => Promise<void>
  deleteProjectGroup: (groupId: string) => Promise<void>
  moveProjectToGroup: (projectId: string, groupId: string | null) => Promise<void>
}

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  activeWorktreeId: string | null
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  fetchWorktrees: (repoId: string) => Promise<void>
  createWorktree: (args: {
    repoId: string
    name: string
    baseBranch?: string
    creationId?: string
    nameWasGenerated?: boolean
    parentWorktreeId?: string
    sparseDirectories?: string[]
    runSetup?: boolean
  }) => Promise<CreateWorktreeResult>
  cancelWorktreeCreation: (creationId: string) => Promise<void>
  removePendingWorktreeCreation: (creationId: string) => void
  removeWorktree: (worktreeId: string, force?: boolean) => Promise<RemoveWorktreeResult>
  setActiveWorktree: (worktreeId: string | null) => void
  /** M10 WS-16 보관·잠든 탭을 main 에 남기고 이 창의 목록에도 얹는다. 실패면 null. */
  updateWorktreeMeta: (worktreeId: string, updates: WorktreeMetaUpdate) => Promise<WorktreeMeta | null>
  /** M10 R2 WS-21 git 이 남긴 브랜치들(Orca "Review N Branches") · 검토 대화상자 열림. */
  preservedBranches: PreservedBranchItem[]
  branchReviewOpen: boolean
  setBranchReviewOpen: (open: boolean) => void
  /** 고른 것을 강제로 지운다(Orca forceDeletePreservedBranchBatch — 저장소마다 차례로). 지운 것은 목록에서 빠지고, 못 지운 것과 사유를 돌려준다. */
  forceDeletePreservedBranches: (items: readonly PreservedBranchItem[]) => Promise<{ item: PreservedBranchItem; message: string }[]>
  /** 남겨 두기로 한 것 — 목록에서만 뺀다(브랜치는 저장소에 그대로). */
  dismissPreservedBranches: (items: readonly PreservedBranchItem[]) => void
  /** "워크트리 없이 열기" — 프로젝트 폴더 자체를 작업 단위로(git 호출 없음, 생성 시간 0). */
  openWithoutWorktree: (repoId: string) => string | null
  /** main 의 진행 이벤트 하나를 반영한다(구독자가 부른다 — 시험도 이것을 직접 부른다). */
  applyCreateProgress: (e: CreateWorktreeProgressEvent) => void
}

export type AiwsState = RepoSlice & WorktreeSlice & SidebarSlice

const createSidebarSlice: StateCreator<AiwsState, [], [], SidebarSlice> = (set) => ({
  pinnedIds: readLocal(PINS_KEY, [], isStringArray),
  groupBy: readLocal<SidebarGroupBy>(GROUP_KEY, 'repo', isGroupBy),
  collapsedHosts: readLocal(HOSTS_FOLDED_KEY, [], isStringArray),
  toggleHost: (key) =>
    set((s) => {
      const collapsedHosts = s.collapsedHosts.includes(key) ? s.collapsedHosts.filter((x) => x !== key) : [...s.collapsedHosts, key]
      writeLocal(HOSTS_FOLDED_KEY, collapsedHosts)
      return { collapsedHosts }
    }),
  statsById: {},
  collapsedLineage: readLocal(LINEAGE_FOLDED_KEY, [], isStringArray),
  toggleLineage: (id) =>
    set((s) => {
      const collapsedLineage = s.collapsedLineage.includes(id) ? s.collapsedLineage.filter((x) => x !== id) : [...s.collapsedLineage, id]
      writeLocal(LINEAGE_FOLDED_KEY, collapsedLineage)
      return { collapsedLineage }
    }),
  composerParentId: null,
  setComposerParent: (composerParentId) => set({ composerParentId }),
  showArchived: false,
  setShowArchived: (showArchived) => set({ showArchived }),
  togglePin: (id) =>
    set((s) => {
      const pinnedIds = s.pinnedIds.includes(id) ? s.pinnedIds.filter((x) => x !== id) : [...s.pinnedIds, id]
      writeLocal(PINS_KEY, pinnedIds)
      return { pinnedIds }
    }),
  setGroupBy: (groupBy) => {
    writeLocal(GROUP_KEY, groupBy)
    set({ groupBy })
  },
  fetchStats: async (w) => {
    const r = await window.ev.worktrees.stats(w.repoId, w.path)
    set((s) => ({ statsById: { ...s.statsById, [w.id]: r } }))
  }
})

const createRepoSlice: StateCreator<AiwsState, [], [], RepoSlice> = (set, get) => ({
  repos: [],
  fetchRepos: async () => {
    set({ repos: await window.ev.repos.list() })
  },
  addRepo: async (path) => {
    const r = await window.ev.repos.add(path)
    if (!r.ok) return null
    if (!get().repos.some((p) => p.id === r.project.id)) set((s) => ({ repos: [...s.repos, r.project] }))
    return r.project
  },
  pickAndAddRepo: async () => {
    const path = await window.ev.repos.pickFolder()
    if (!path) return null
    const project = await get().addRepo(path)
    if (project) await get().fetchWorktrees(project.id)
    return project
  },
  addRemoteRepo: async (hostKey, path) => {
    const r = await window.ev.repos.addRemote(hostKey, path)
    if (!r.ok) return r.message
    if (!get().repos.some((p) => p.id === r.project.id)) set((s) => ({ repos: [...s.repos, r.project] }))
    await get().fetchWorktrees(r.project.id)
    return r.project
  },
  updateRepo: async (repoId, updates) => {
    const p = await window.ev.repos.update(repoId, updates)
    if (!p) return null
    set((s) => ({ repos: s.repos.map((x) => (x.id === repoId ? p : x)) }))
    await get().fetchWorktrees(repoId)
    return p
  },
  removeRepo: async (repoId) => {
    await window.ev.repos.remove(repoId)
    set((s) => {
      const { [repoId]: _gone, ...rest } = s.worktreesByRepo
      const active = s.activeWorktreeId?.startsWith(repoId + '::') ? null : s.activeWorktreeId
      return { repos: s.repos.filter((p) => p.id !== repoId), worktreesByRepo: rest, activeWorktreeId: active }
    })
  },
  groups: [],
  fetchGroups: async () => {
    set({ groups: await window.ev.projectGroups.list() })
  },
  createProjectGroup: async (name) => {
    const g = await window.ev.projectGroups.create(name)
    if (g) set((s) => ({ groups: [...s.groups, g] }))
    return g
  },
  updateProjectGroup: async (groupId, updates) => {
    // 접기는 바로 보이게 먼저 바꾸고 main 답으로 맞춘다.
    set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, ...updates } : g)) }))
    const g = await window.ev.projectGroups.update(groupId, updates)
    if (g) set((s) => ({ groups: s.groups.map((x) => (x.id === groupId ? g : x)) }))
  },
  deleteProjectGroup: async (groupId) => {
    if (!(await window.ev.projectGroups.delete(groupId))) return
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== groupId),
      repos: s.repos.map((p) => (p.groupId === groupId ? { ...p, groupId: undefined } : p))
    }))
  },
  moveProjectToGroup: async (projectId, groupId) => {
    const p = await window.ev.projectGroups.moveProject(projectId, groupId)
    if (p) set((s) => ({ repos: s.repos.map((x) => (x.id === projectId ? p : x)) }))
  }
})

const createWorktreeSlice: StateCreator<AiwsState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  activeWorktreeId: null,
  pendingWorktreeCreations: {},
  fetchWorktrees: async (repoId) => {
    const r = await window.ev.worktrees.list(repoId)
    // 못 읽으면 있던 목록을 지우지 않는다(일시적인 git 실패로 사이드바가 비지 않게).
    if (!r.ok) return
    set((s) => ({ worktreesByRepo: { ...s.worktreesByRepo, [repoId]: r.worktrees } }))
    // 통계는 기다리지 않는다 — 목록이 먼저 보이고 +/− 는 뒤따라 찬다. 실패해도 목록은 그대로.
    for (const w of r.worktrees) void get().fetchStats(w).catch(() => {})
  },
  createWorktree: async ({ repoId, name, baseBranch, creationId = crypto.randomUUID(), nameWasGenerated, parentWorktreeId, sparseDirectories, runSetup }) => {
    // 3차: 부모(WS-24)·sparse(WS-27)·setup(WS-23)은 있을 때만 싣는다 — [다시] 도 같은 값으로.
    const extra = {
      ...(nameWasGenerated ? { nameWasGenerated } : {}),
      ...(parentWorktreeId ? { parentWorktreeId } : {}),
      ...(sparseDirectories?.length ? { sparseDirectories } : {}),
      ...(runSetup ? { runSetup } : {})
    }
    set((s) => ({
      pendingWorktreeCreations: {
        ...s.pendingWorktreeCreations,
        [creationId]: { creationId, repoId, name, baseBranch, ...extra, startedAt: Date.now(), phase: 'start', output: '' }
      }
    }))
    // 결과는 진행 이벤트(done/failed)로도 온다 — 상태 반영은 applyCreateProgress 한 곳에서.
    const r = await window.ev.worktrees.create({ creationId, repoId, name, baseBranch, ...extra })
    // WS-23 setup 을 못 돌렸거나(승인 안 됨) wait-for-setup 이 실패했다 — 작업 단위는 만들어졌다.
    if (r.ok && r.setupWarning) {
      pushNote({
        kind: 'info',
        space: 'ai',
        title: t(r.setupWarning === 'untrusted' ? 'aiws.yaml.untrusted' : 'aiws.yaml.setupFailed').replace('{w}', r.worktree.displayName),
        ...(r.setupWarning === 'untrusted' ? {} : { body: r.setupWarning })
      })
    }
    return r
  },
  cancelWorktreeCreation: async (creationId) => {
    await window.ev.worktrees.cancelCreate(creationId)
  },
  removePendingWorktreeCreation: (creationId) => {
    set((s) => {
      const { [creationId]: _gone, ...rest } = s.pendingWorktreeCreations
      return { pendingWorktreeCreations: rest }
    })
  },
  removeWorktree: async (worktreeId, force) => {
    const wt = Object.values(get().worktreesByRepo)
      .flat()
      .find((w) => w.id === worktreeId)
    if (!wt) return { ok: false, message: worktreeId }
    const r = await window.ev.worktrees.remove(wt.repoId, wt.path, force)
    if (r.ok && r.preservedBranch) {
      // WS-21 Orca preserved-branch-toast — 작업 폴더는 지웠고 브랜치는 남겼다. 누르면 검토 대화상자.
      const item: PreservedBranchItem = { ...r.preservedBranch, repoId: wt.repoId, worktreeId, worktreeName: wt.displayName }
      set((s) => ({ preservedBranches: [...s.preservedBranches.filter((b) => !(b.repoId === item.repoId && b.branchName === item.branchName)), item] }))
      pushNote({
        kind: 'info',
        space: 'ai',
        title: t('aiws.branch.kept').replace('{b}', item.branchName),
        body: t('aiws.branch.keptBody').replace('{b}', item.branchName).replace('{w}', item.worktreeName),
        go: () => get().setBranchReviewOpen(true)
      })
    }
    if (r.ok) {
      // M10 WS-14 main 이 자동 이름을 은퇴시켰다 — 이 창의 제안도 같은 이름을 피한다.
      const gone = normalizeSuggestedName(suggestionPathBasename(wt.path))
      set((s) => ({
        worktreesByRepo: { ...s.worktreesByRepo, [wt.repoId]: (s.worktreesByRepo[wt.repoId] ?? []).filter((w) => w.id !== worktreeId) },
        activeWorktreeId: s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId,
        repos:
          creatureNameTier(gone) === null
            ? s.repos
            : s.repos.map((p) => (p.id === wt.repoId && !p.retiredNames?.includes(gone) ? { ...p, retiredNames: [...(p.retiredNames ?? []), gone] } : p))
      }))
    }
    return r
  },
  setActiveWorktree: (worktreeId) => set({ activeWorktreeId: worktreeId }),
  preservedBranches: [],
  branchReviewOpen: false,
  setBranchReviewOpen: (branchReviewOpen) => set({ branchReviewOpen }),
  forceDeletePreservedBranches: async (items) => {
    const failed: { item: PreservedBranchItem; message: string }[] = []
    for (const item of items) {
      const r = await window.ev.worktrees.forceDeletePreservedBranch(item.repoId, item.branchName, item.head)
      if (r.ok) get().dismissPreservedBranches([item])
      else failed.push({ item, message: r.message })
    }
    return failed
  },
  dismissPreservedBranches: (items) =>
    set((s) => ({ preservedBranches: s.preservedBranches.filter((b) => !items.some((x) => x.repoId === b.repoId && x.branchName === b.branchName)) })),
  updateWorktreeMeta: async (worktreeId, updates) => {
    const meta = await window.ev.worktrees.updateMeta(worktreeId, updates)
    if (!meta) return null
    const repoId = worktreeId.split(WORKTREE_ID_SEPARATOR)[0]
    set((s) => ({
      worktreesByRepo: {
        ...s.worktreesByRepo,
        [repoId]: (s.worktreesByRepo[repoId] ?? []).map((w) => {
          if (w.id !== worktreeId) return w
          const { isArchived: _a, sleep: _s, comment: _c, workspaceStatus: _ws, ...rest } = w
          return { ...rest, ...meta }
        })
      },
      // 보관하면 고른 줄에서 내린다(목록에서 사라진다).
      activeWorktreeId: meta.isArchived && s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId
    }))
    return meta
  },
  openWithoutWorktree: (repoId) => {
    const repo = get().repos.find((p) => p.id === repoId)
    if (!repo) return null
    // 본 작업 폴더의 id 는 Orca getRepoMainWorktreeId 와 같다 — 목록의 본 폴더 줄과 같은 id 가 된다.
    const id = composeWorktreeId(repo.id, repo.path)
    set({ activeWorktreeId: id })
    return id
  },
  applyCreateProgress: (e) => {
    // WS-23 start-immediately 로 뒤에서 돈 setup 이 끝났다 — 만드는 중 줄은 이미 없다. 실패만 알린다.
    if (e.phase === 'setupDone') {
      if (!e.ok) {
        const w = (get().worktreesByRepo[e.repoId] ?? []).find((x) => x.id === e.worktreeId)
        pushNote({ kind: 'info', space: 'ai', title: t('aiws.yaml.setupFailed').replace('{w}', w?.displayName ?? e.worktreeId), ...(e.message ? { body: e.message } : {}) })
      }
      return
    }
    if (e.phase === 'done') void get().fetchStats(e.worktree).catch(() => {})
    set((s) => {
      const prev = s.pendingWorktreeCreations[e.creationId]
      // 다른 창이 시작한 생성 — 이 창에도 진행이 보이게 받아 둔다.
      const base: PendingWorktreeCreation = prev ?? { creationId: e.creationId, repoId: e.repoId, name: '', startedAt: Date.now(), phase: 'start', output: '' }
      // 사용자가 취소한 것은 실패 줄로 남기지 않는다 — 반쯤 만든 것은 main 이 이미 치웠다.
      if (e.phase === 'failed' && e.reason === 'canceled') {
        const { [e.creationId]: _gone, ...rest } = s.pendingWorktreeCreations
        return { pendingWorktreeCreations: rest }
      }
      if (e.phase === 'done') {
        const { [e.creationId]: _done, ...rest } = s.pendingWorktreeCreations
        const list = (s.worktreesByRepo[e.repoId] ?? []).filter((w) => w.id !== e.worktree.id)
        return { pendingWorktreeCreations: rest, worktreesByRepo: { ...s.worktreesByRepo, [e.repoId]: [...list, e.worktree] } }
      }
      let next: PendingWorktreeCreation
      if (e.phase === 'output') next = { ...base, output: (base.output + e.text).slice(-OUTPUT_TAIL_CHARS) }
      else if (e.phase === 'start') next = { ...base, phase: 'start', path: e.path, branch: e.branch }
      else if (e.phase === 'creating') next = { ...base, phase: 'creating', ...(e.checkout !== undefined ? { checkout: e.checkout } : {}) }
      else if (e.phase === 'failed') next = { ...base, phase: 'failed', error: e.message }
      else next = { ...base, phase: e.phase }
      // 실패한 것은 남겨 둔다 — 화면이 사유를 보여 주고 사용자가 닫는다(removePendingWorktreeCreation).
      return { pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [e.creationId]: next } }
    })
  }
})

export const useAiwsStore = create<AiwsState>()((...a) => ({ ...createRepoSlice(...a), ...createWorktreeSlice(...a), ...createSidebarSlice(...a) }))

// 모듈이 처음 불릴 때(= AI 작업 공간을 처음 열 때) 한 번 구독한다. 창이 사는 동안 유지한다.
// 시험(node)에는 window.ev 가 없다 — 그때는 건너뛴다.
if (typeof window !== 'undefined' && window.ev?.worktrees) {
  window.ev.worktrees.onCreateProgress((e) => useAiwsStore.getState().applyCreateProgress(e))
  // 3차 R2-B 브랜치 자동 개명 — 사이드바 이름(= 브랜치)을 새로.
  window.ev.worktrees.onBranchRenamed?.((e) => void useAiwsStore.getState().fetchWorktrees(e.repoId))
}

let loaded: Promise<void> | null = null
/** AI 작업 공간을 처음 열 때 한 번 — 프로젝트와 각 프로젝트의 워크트리를 불러온다. */
export function ensureAiwsLoaded(): Promise<void> {
  loaded ??= (async () => {
    const s = useAiwsStore.getState()
    // 그룹을 못 읽어도 목록은 보인다(그룹 밖으로).
    await Promise.all([s.fetchRepos(), s.fetchGroups().catch(() => {})])
    await Promise.all(useAiwsStore.getState().repos.map((p) => s.fetchWorktrees(p.id)))
  })().catch(() => {
    loaded = null // 다음에 열 때 다시
  })
  return loaded
}

/** M8 그 작업 단위가 원격 저장소의 것이면 서버 hostKey(id = `${repoId}::${path}`). */
export function hostOfWorktree(worktreeId: string): string | undefined {
  const repoId = worktreeId.split(WORKTREE_ID_SEPARATOR)[0]
  return useAiwsStore.getState().repos.find((r) => r.id === repoId)?.host
}
