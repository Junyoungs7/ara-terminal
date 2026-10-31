// M2 작업 단위 — 렌더러 상태 저장소(zustand 5). Orca src/renderer/src/store/slices/repos.ts·worktrees.ts(orcaRef 7a7f46f8a3)의
// 슬라이스 모양·이름(repos · worktreesByRepo · activeWorktreeId · pendingWorktreeCreations)을 따른다. 1차 범위만:
// 메타(핀·정렬·읽음)·감지 스캔·호스트 소유·PR 연동은 뺐다(사이드바 라운드 WS-05·2차).
// 이 파일은 AI 작업 공간 청크(features/aiws)에 산다 — 처음 열 때만 불러오고, 그때 진행 이벤트를 한 번 구독한다.
import { create, type StateCreator } from 'zustand'
import type { CreateWorktreeProgressEvent, CreateWorktreeResult, Project, RemoveWorktreeResult, Worktree, WorktreeCheckoutProgress } from '@shared/worktrees'
import { composeWorktreeId } from '@shared/worktrees'

/** Orca PendingWorktreeCreation(src/renderer/src/lib/pending-worktree-creation.ts)의 1차 부분집합. */
export type PendingWorktreeCreation = {
  creationId: string
  repoId: string
  name: string
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

export type RepoSlice = {
  repos: Project[]
  fetchRepos: () => Promise<void>
  addRepo: (path: string) => Promise<Project | null>
  removeRepo: (repoId: string) => Promise<void>
}

export type WorktreeSlice = {
  worktreesByRepo: Record<string, Worktree[]>
  activeWorktreeId: string | null
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  fetchWorktrees: (repoId: string) => Promise<void>
  createWorktree: (args: { repoId: string; name: string; baseBranch?: string }) => Promise<CreateWorktreeResult>
  cancelWorktreeCreation: (creationId: string) => Promise<void>
  removePendingWorktreeCreation: (creationId: string) => void
  removeWorktree: (worktreeId: string, force?: boolean) => Promise<RemoveWorktreeResult>
  setActiveWorktree: (worktreeId: string | null) => void
  /** "워크트리 없이 열기" — 프로젝트 폴더 자체를 작업 단위로(git 호출 없음, 생성 시간 0). */
  openWithoutWorktree: (repoId: string) => string | null
  /** main 의 진행 이벤트 하나를 반영한다(구독자가 부른다 — 시험도 이것을 직접 부른다). */
  applyCreateProgress: (e: CreateWorktreeProgressEvent) => void
}

export type AiwsState = RepoSlice & WorktreeSlice

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
  removeRepo: async (repoId) => {
    await window.ev.repos.remove(repoId)
    set((s) => {
      const { [repoId]: _gone, ...rest } = s.worktreesByRepo
      const active = s.activeWorktreeId?.startsWith(repoId + '::') ? null : s.activeWorktreeId
      return { repos: s.repos.filter((p) => p.id !== repoId), worktreesByRepo: rest, activeWorktreeId: active }
    })
  }
})

const createWorktreeSlice: StateCreator<AiwsState, [], [], WorktreeSlice> = (set, get) => ({
  worktreesByRepo: {},
  activeWorktreeId: null,
  pendingWorktreeCreations: {},
  fetchWorktrees: async (repoId) => {
    const r = await window.ev.worktrees.list(repoId)
    // 못 읽으면 있던 목록을 지우지 않는다(일시적인 git 실패로 사이드바가 비지 않게).
    if (r.ok) set((s) => ({ worktreesByRepo: { ...s.worktreesByRepo, [repoId]: r.worktrees } }))
  },
  createWorktree: async ({ repoId, name, baseBranch }) => {
    const creationId = crypto.randomUUID()
    set((s) => ({
      pendingWorktreeCreations: {
        ...s.pendingWorktreeCreations,
        [creationId]: { creationId, repoId, name, startedAt: Date.now(), phase: 'start', output: '' }
      }
    }))
    // 결과는 진행 이벤트(done/failed)로도 온다 — 상태 반영은 applyCreateProgress 한 곳에서.
    return window.ev.worktrees.create({ creationId, repoId, name, baseBranch })
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
    if (r.ok) {
      set((s) => ({
        worktreesByRepo: { ...s.worktreesByRepo, [wt.repoId]: (s.worktreesByRepo[wt.repoId] ?? []).filter((w) => w.id !== worktreeId) },
        activeWorktreeId: s.activeWorktreeId === worktreeId ? null : s.activeWorktreeId
      }))
    }
    return r
  },
  setActiveWorktree: (worktreeId) => set({ activeWorktreeId: worktreeId }),
  openWithoutWorktree: (repoId) => {
    const repo = get().repos.find((p) => p.id === repoId)
    if (!repo) return null
    // 본 작업 폴더의 id 는 Orca getRepoMainWorktreeId 와 같다 — 목록의 본 폴더 줄과 같은 id 가 된다.
    const id = composeWorktreeId(repo.id, repo.path)
    set({ activeWorktreeId: id })
    return id
  },
  applyCreateProgress: (e) => {
    set((s) => {
      const prev = s.pendingWorktreeCreations[e.creationId]
      // 다른 창이 시작한 생성 — 이 창에도 진행이 보이게 받아 둔다.
      const base: PendingWorktreeCreation = prev ?? { creationId: e.creationId, repoId: e.repoId, name: '', startedAt: Date.now(), phase: 'start', output: '' }
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

export const useAiwsStore = create<AiwsState>()((...a) => ({ ...createRepoSlice(...a), ...createWorktreeSlice(...a) }))

// 모듈이 처음 불릴 때(= AI 작업 공간을 처음 열 때) 한 번 구독한다. 창이 사는 동안 유지한다.
// 시험(node)에는 window.ev 가 없다 — 그때는 건너뛴다.
if (typeof window !== 'undefined' && window.ev?.worktrees) {
  window.ev.worktrees.onCreateProgress((e) => useAiwsStore.getState().applyCreateProgress(e))
}

let loaded: Promise<void> | null = null
/** AI 작업 공간을 처음 열 때 한 번 — 프로젝트와 각 프로젝트의 워크트리를 불러온다. */
export function ensureAiwsLoaded(): Promise<void> {
  loaded ??= (async () => {
    const s = useAiwsStore.getState()
    await s.fetchRepos()
    await Promise.all(useAiwsStore.getState().repos.map((p) => s.fetchWorktrees(p.id)))
  })().catch(() => {
    loaded = null // 다음에 열 때 다시
  })
  return loaded
}
