// M2 작업 단위 — 렌더러 zustand 슬라이스(features/aiws/store.ts). window.ev 를 가짜로 세워 main 없이 돈다.
// 옮긴 Orca 시험: pending-worktree-creation 의 "진행 반영·끝나면 빠짐" 모양(worktrees-slice-test-harness 의 축소판).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '@shared/worktrees'

const project: Project = { id: 'r1', path: 'C:/repo', displayName: 'repo', kind: 'git', addedAt: 0 }
const main: Worktree = { id: 'r1::C:/repo', repoId: 'r1', path: 'C:/repo', head: 'a', branch: 'refs/heads/main', isBare: false, isMainWorktree: true, displayName: 'main' }
const feat: Worktree = { ...main, id: 'r1::C:/ws/feat', path: 'C:/ws/feat', branch: 'refs/heads/feat', isMainWorktree: false, displayName: 'feat' }

const ev = {
  repos: { list: vi.fn(async () => [project]), add: vi.fn(), remove: vi.fn(async () => ({ ok: true })), searchBaseRefs: vi.fn() },
  worktrees: {
    list: vi.fn(async () => ({ ok: true as const, worktrees: [main] })),
    create: vi.fn(async () => ({ ok: true as const, worktree: feat })),
    cancelCreate: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true as const })),
    onCreateProgress: vi.fn(() => () => {})
  }
}

// 이 저장소의 vitest 는 시험마다 mock 호출 기록을 지운다(clearMocks) — 구독 횟수는 불러온 직후에 잰다.
let subscribed = 0
let store: typeof import('../src/renderer/features/aiws/store')

beforeAll(async () => {
  ;(globalThis as unknown as { window: unknown }).window = { ev }
  store = await import('../src/renderer/features/aiws/store')
  subscribed = ev.worktrees.onCreateProgress.mock.calls.length
})

// 한 프로세스에서 파일들이 차례로 돈다(vitest maxWorkers 1) — 남의 시험이 가짜 window 를 보지 않게 치운다.
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

beforeEach(() => {
  store.useAiwsStore.setState({ repos: [], worktreesByRepo: {}, activeWorktreeId: null, pendingWorktreeCreations: {} })
})

describe('aiws store', () => {
  it('처음 열 때 한 번 — 프로젝트와 워크트리를 불러오고 진행 이벤트를 구독한다', async () => {
    expect(subscribed).toBe(1)
    await store.ensureAiwsLoaded()
    await store.ensureAiwsLoaded()
    expect(ev.repos.list).toHaveBeenCalledTimes(1)
    expect(store.useAiwsStore.getState().worktreesByRepo).toEqual({ r1: [main] })
  })

  it('생성 — 진행 이벤트로 pending 이 바뀌고, done 이면 빠지며 목록에 붙는다', async () => {
    const s = store.useAiwsStore.getState()
    await s.createWorktree({ repoId: 'r1', name: 'feat' })
    const [id] = Object.keys(store.useAiwsStore.getState().pendingWorktreeCreations)
    expect(ev.worktrees.create).toHaveBeenCalledWith({ creationId: id, repoId: 'r1', name: 'feat', baseBranch: undefined })
    s.applyCreateProgress({ creationId: id, repoId: 'r1', phase: 'start', path: 'C:/ws/feat', branch: 'feat' })
    s.applyCreateProgress({ creationId: id, repoId: 'r1', phase: 'creating', checkout: { percent: 50, completed: 1, total: 2 } })
    s.applyCreateProgress({ creationId: id, repoId: 'r1', phase: 'output', text: 'Updating files' })
    expect(store.useAiwsStore.getState().pendingWorktreeCreations[id]).toMatchObject({ phase: 'creating', branch: 'feat', checkout: { percent: 50 }, output: 'Updating files' })
    s.applyCreateProgress({ creationId: id, repoId: 'r1', phase: 'done', worktree: feat })
    expect(store.useAiwsStore.getState().pendingWorktreeCreations).toEqual({})
    expect(store.useAiwsStore.getState().worktreesByRepo.r1).toEqual([feat])
  })

  it('실패는 사유와 함께 남아 있다가 닫으면 빠진다', () => {
    const s = store.useAiwsStore.getState()
    s.applyCreateProgress({ creationId: 'x', repoId: 'r1', phase: 'failed', reason: 'git', message: 'boom' })
    expect(store.useAiwsStore.getState().pendingWorktreeCreations.x).toMatchObject({ phase: 'failed', error: 'boom' })
    s.removePendingWorktreeCreation('x')
    expect(store.useAiwsStore.getState().pendingWorktreeCreations).toEqual({})
  })

  it('워크트리 없이 열기 — git 호출 없이 본 폴더가 활성 작업 단위', async () => {
    await store.useAiwsStore.getState().fetchRepos()
    ev.worktrees.list.mockClear()
    expect(store.useAiwsStore.getState().openWithoutWorktree('r1')).toBe('r1::C:/repo')
    expect(store.useAiwsStore.getState().activeWorktreeId).toBe(main.id)
    expect(ev.worktrees.list).not.toHaveBeenCalled()
    expect(store.useAiwsStore.getState().openWithoutWorktree('nope')).toBeNull()
  })

  it('지우기 — 목록·활성에서 빠지고, 프로젝트를 빼면 그 워크트리도 빠진다', async () => {
    store.useAiwsStore.setState({ repos: [project], worktreesByRepo: { r1: [main, feat] }, activeWorktreeId: feat.id })
    expect((await store.useAiwsStore.getState().removeWorktree(feat.id)).ok).toBe(true)
    expect(ev.worktrees.remove).toHaveBeenCalledWith('r1', 'C:/ws/feat', undefined)
    expect(store.useAiwsStore.getState()).toMatchObject({ worktreesByRepo: { r1: [main] }, activeWorktreeId: null })
    await store.useAiwsStore.getState().removeRepo('r1')
    expect(store.useAiwsStore.getState()).toMatchObject({ repos: [], worktreesByRepo: {} })
  })
})
