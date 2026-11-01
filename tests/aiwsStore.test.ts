// M2 작업 단위 — 렌더러 zustand 슬라이스(features/aiws/store.ts). window.ev 를 가짜로 세워 main 없이 돈다.
// 옮긴 Orca 시험: pending-worktree-creation 의 "진행 반영·끝나면 빠짐" 모양(worktrees-slice-test-harness 의 축소판).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '@shared/worktrees'

const project: Project = { id: 'r1', path: 'C:/repo', displayName: 'repo', kind: 'git', addedAt: 0 }
const main: Worktree = { id: 'r1::C:/repo', repoId: 'r1', path: 'C:/repo', head: 'a', branch: 'refs/heads/main', isBare: false, isMainWorktree: true, displayName: 'main' }
const feat: Worktree = { ...main, id: 'r1::C:/ws/feat', path: 'C:/ws/feat', branch: 'refs/heads/feat', isMainWorktree: false, displayName: 'feat' }

const ev = {
  repos: {
    list: vi.fn(async () => [project]),
    pickFolder: vi.fn(async (): Promise<string | null> => 'C:/repo/sub'),
    add: vi.fn(async () => ({ ok: true as const, project })),
    remove: vi.fn(async () => ({ ok: true })), searchBaseRefs: vi.fn(),
    update: vi.fn(async (_id: string, u: object) => ({ ...project, ...u })) },
  worktrees: {
    list: vi.fn(async () => ({ ok: true as const, worktrees: [main] })),
    create: vi.fn(async () => ({ ok: true as const, worktree: feat })),
    cancelCreate: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async (): Promise<{ ok: true; preservedBranch?: { branchName: string; head: string } }> => ({ ok: true as const })),
    forceDeletePreservedBranch: vi.fn(async (): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true })),
    stats: vi.fn(async () => ({ ok: true as const, base: 'main', ahead: 2, added: 5, removed: 1 })),
    onCreateProgress: vi.fn(() => () => {}),
    updateMeta: vi.fn(async (_id: string, u: { isArchived?: boolean; sleep?: unknown }) => (u.isArchived ? { isArchived: true } : {}))
  },
  projectGroups: {
    list: vi.fn(async () => [{ id: 'g1', name: 'Work', isCollapsed: false, createdAt: 0 }]),
    create: vi.fn(async (name: string) => ({ id: 'g2', name, isCollapsed: false, createdAt: 1 })),
    update: vi.fn(async () => null),
    delete: vi.fn(async () => true),
    moveProject: vi.fn(async (_p: string, groupId: string | null) => ({ ...project, ...(groupId ? { groupId } : {}) }))
  }
}

// 이 저장소의 vitest 는 시험마다 mock 호출 기록을 지운다(clearMocks) — 구독 횟수는 불러온 직후에 잰다.
let subscribed = 0
let store: typeof import('../src/renderer/features/aiws/store')

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v)
  }
  ;(globalThis as unknown as { window: unknown }).window = { ev }
  store = await import('../src/renderer/features/aiws/store')
  subscribed = ev.worktrees.onCreateProgress.mock.calls.length
})

// 한 프로세스에서 파일들이 차례로 돈다(vitest maxWorkers 1) — 남의 시험이 가짜 window 를 보지 않게 치운다.
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
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
    // 취소는 실패 줄로 남지 않는다.
    s.applyCreateProgress({ creationId: 'y', repoId: 'r1', phase: 'start', path: 'p', branch: 'b' })
    s.applyCreateProgress({ creationId: 'y', repoId: 'r1', phase: 'failed', reason: 'canceled', message: 'p' })
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

  it('M10 R2 WS-21 남긴 브랜치 — git 이 남기면 목록에 든다. 강제로 지운 것만 빠지고 못 지운 것은 사유와 남는다', async () => {
    store.useAiwsStore.setState({ repos: [project], worktreesByRepo: { r1: [main, feat] }, preservedBranches: [] })
    const head = 'a'.repeat(40)
    ev.worktrees.remove.mockResolvedValueOnce({ ok: true, preservedBranch: { branchName: 'feat', head } })
    await store.useAiwsStore.getState().removeWorktree(feat.id)
    const kept = store.useAiwsStore.getState().preservedBranches
    expect(kept).toEqual([{ branchName: 'feat', head, repoId: 'r1', worktreeId: feat.id, worktreeName: 'feat' }])
    ev.worktrees.forceDeletePreservedBranch.mockResolvedValueOnce({ ok: false, message: 'moved' })
    expect(await store.useAiwsStore.getState().forceDeletePreservedBranches(kept)).toEqual([{ item: kept[0], message: 'moved' }])
    expect(store.useAiwsStore.getState().preservedBranches).toHaveLength(1)
    expect(await store.useAiwsStore.getState().forceDeletePreservedBranches(kept)).toEqual([])
    expect(ev.worktrees.forceDeletePreservedBranch).toHaveBeenLastCalledWith('r1', 'feat', head)
    expect(store.useAiwsStore.getState().preservedBranches).toEqual([])
  })

  it('M10 R2 WS-19·20 프로젝트 설정 — main 답으로 프로젝트를 바꾸고 그 목록을 다시 읽는다. 메모를 지우면 줄에서도 빠진다', async () => {
    store.useAiwsStore.setState({ repos: [project], worktreesByRepo: { r1: [{ ...feat, comment: 'old', workspaceStatus: 'todo' }] } })
    await store.useAiwsStore.getState().updateRepo('r1', { sharedPaths: ['deps'] })
    expect(store.useAiwsStore.getState().repos[0].sharedPaths).toEqual(['deps'])
    expect(ev.worktrees.list).toHaveBeenCalledWith('r1')
    store.useAiwsStore.setState({ worktreesByRepo: { r1: [{ ...feat, comment: 'old', workspaceStatus: 'todo' }] } })
    await store.useAiwsStore.getState().updateWorktreeMeta(feat.id, { comment: '', workspaceStatus: null })
    const w = store.useAiwsStore.getState().worktreesByRepo.r1[0]
    expect(w).not.toHaveProperty('comment')
    expect(w).not.toHaveProperty('workspaceStatus')
  })

  it('지우기 — 목록·활성에서 빠지고, 프로젝트를 빼면 그 워크트리도 빠진다', async () => {
    store.useAiwsStore.setState({ repos: [project], worktreesByRepo: { r1: [main, feat] }, activeWorktreeId: feat.id })
    expect((await store.useAiwsStore.getState().removeWorktree(feat.id)).ok).toBe(true)
    expect(ev.worktrees.remove).toHaveBeenCalledWith('r1', 'C:/ws/feat', undefined)
    expect(store.useAiwsStore.getState()).toMatchObject({ worktreesByRepo: { r1: [main] }, activeWorktreeId: null })
    await store.useAiwsStore.getState().removeRepo('r1')
    expect(store.useAiwsStore.getState()).toMatchObject({ repos: [], worktreesByRepo: {} })
  })

  it('폴더 고르기 → 등록 → 그 워크트리·통계를 불러온다, 취소면 아무 일 없음', async () => {
    expect(await store.useAiwsStore.getState().pickAndAddRepo()).toEqual(project)
    expect(ev.repos.add).toHaveBeenCalledWith('C:/repo/sub')
    expect(store.useAiwsStore.getState().worktreesByRepo.r1).toEqual([main])
    await vi.waitFor(() => expect(store.useAiwsStore.getState().statsById[main.id]).toMatchObject({ ok: true, ahead: 2 }))
    ev.repos.pickFolder.mockResolvedValueOnce(null)
    ev.repos.add.mockClear()
    expect(await store.useAiwsStore.getState().pickAndAddRepo()).toBeNull()
    expect(ev.repos.add).not.toHaveBeenCalled()
  })

  it('핀 — 켜고 끄며 localStorage 에 남는다', () => {
    const s = store.useAiwsStore.getState()
    s.togglePin(feat.id)
    expect(store.useAiwsStore.getState().pinnedIds).toEqual([feat.id])
    expect(localStorage.getItem('aiws.pinnedWorktrees')).toBe(JSON.stringify([feat.id]))
    s.togglePin(feat.id)
    expect(store.useAiwsStore.getState().pinnedIds).toEqual([])
    s.setGroupBy('none')
    expect(localStorage.getItem('aiws.groupBy')).toBe('"none"')
  })

  it('[다시] 를 위해 분기 지점을 pending 에 남긴다', async () => {
    await store.useAiwsStore.getState().createWorktree({ repoId: 'r1', name: 'x', baseBranch: 'v1', creationId: 'fixed' })
    expect(store.useAiwsStore.getState().pendingWorktreeCreations.fixed).toMatchObject({ name: 'x', baseBranch: 'v1' })
  })

  // ── M10 ──
  it('WS-15 그룹 — 처음 열 때 불러오고, 만들기·옮기기·지우기(안의 프로젝트는 그룹 밖으로)', async () => {
    store.useAiwsStore.setState({ repos: [project], groups: [] })
    const s = store.useAiwsStore.getState()
    await s.fetchGroups()
    const g = await s.createProjectGroup('Side')
    expect(store.useAiwsStore.getState().groups.map((x) => x.name)).toEqual(['Work', 'Side'])
    await s.moveProjectToGroup('r1', g?.id ?? '')
    expect(store.useAiwsStore.getState().repos[0].groupId).toBe('g2')
    await s.updateProjectGroup('g2', { isCollapsed: true }) // main 이 null 이어도 바로 보인 값은 남는다
    expect(store.useAiwsStore.getState().groups.find((x) => x.id === 'g2')?.isCollapsed).toBe(true)
    await s.deleteProjectGroup('g2')
    expect(store.useAiwsStore.getState().repos[0].groupId).toBeUndefined()
  })

  it('WS-16 메타 — 보관하면 목록 항목에 얹히고 고른 줄에서 내린다, 풀면 지운다', async () => {
    store.useAiwsStore.setState({ worktreesByRepo: { r1: [main, feat] }, activeWorktreeId: feat.id })
    await store.useAiwsStore.getState().updateWorktreeMeta(feat.id, { isArchived: true })
    expect(store.useAiwsStore.getState().worktreesByRepo.r1[1]).toMatchObject({ isArchived: true })
    expect(store.useAiwsStore.getState().activeWorktreeId).toBeNull()
    await store.useAiwsStore.getState().updateWorktreeMeta(feat.id, { isArchived: false })
    expect(store.useAiwsStore.getState().worktreesByRepo.r1[1]).not.toHaveProperty('isArchived')
  })

  it('WS-14 자동 이름 — nameWasGenerated 를 main 에 넘기고, 자동 이름 작업 단위를 지우면 이 창의 은퇴 목록에도 얹는다', async () => {
    const s = store.useAiwsStore.getState()
    await s.createWorktree({ repoId: 'r1', name: 'nautilus', nameWasGenerated: true })
    expect(ev.worktrees.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'nautilus', nameWasGenerated: true }))
    const sea = { ...feat, id: 'r1::C:/ws/nautilus', path: 'C:/ws/nautilus' }
    store.useAiwsStore.setState({ repos: [project], worktreesByRepo: { r1: [main, sea, feat] } })
    await s.removeWorktree(sea.id)
    await s.removeWorktree(feat.id)
    expect(store.useAiwsStore.getState().repos[0].retiredNames).toEqual(['nautilus'])
  })
})
