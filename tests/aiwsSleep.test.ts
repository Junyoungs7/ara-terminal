// M10 WS-16 재우기·깨우기·보관·복원(features/aiws/sleep.ts). window.ev 를 가짜로 세워 main 없이 돈다(진짜 CLI 안 띄움).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree, WorktreeMetaUpdate } from '@shared/worktrees'

const local: Project = { id: 'r1', path: 'C:/repo', displayName: 'repo', kind: 'git', addedAt: 0 }
const remote: Project = { id: 'r2', path: '/srv/repo', displayName: 'repo @ box', kind: 'git', addedAt: 1, host: 'u@box:22' }
const main: Worktree = { id: 'r1::C:/repo', repoId: 'r1', path: 'C:/repo', head: 'a', branch: 'refs/heads/main', isBare: false, isMainWorktree: true, displayName: 'main' }
const feat: Worktree = { ...main, id: 'r1::C:/ws/feat', path: 'C:/ws/feat', branch: 'refs/heads/feat', isMainWorktree: false, displayName: 'feat' }
const far: Worktree = { ...feat, id: 'r2::/srv/ws/far', repoId: 'r2', path: '/srv/ws/far', displayName: 'far' }

// main 처럼 메타를 쌓는다(undefined/null/false = 지움).
let metaStore: Record<string, { isArchived?: boolean; sleep?: unknown[] }> = {}
let n = 0
const ev = {
  worktrees: {
    onCreateProgress: vi.fn(() => () => {}),
    updateMeta: vi.fn(async (id: string, u: WorktreeMetaUpdate) => {
      const next = { ...metaStore[id], ...u } as { isArchived?: boolean; sleep?: unknown[] | null }
      if (!next.isArchived) delete next.isArchived
      if (!next.sleep) delete next.sleep
      metaStore[id] = next as { isArchived?: boolean; sleep?: unknown[] }
      return next
    })
  },
  agents: {
    launch: vi.fn(async (agent: string) => ({ ok: true as const, sessionId: `n${++n}`, title: agent, line: agent })),
    resumeIds: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === 's2' ? null : `cli-${id}`])))
  },
  session: {
    onExit: vi.fn(() => () => {}),
    destroy: vi.fn(async () => ({ ok: true }))
  }
}

let sleep: typeof import('../src/renderer/features/aiws/sleep')
let aiws: typeof import('../src/renderer/features/aiws/store')
let agents: typeof import('../src/renderer/features/aiws/agentStore')
beforeAll(async () => {
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => {} }
  ;(globalThis as unknown as { window: unknown }).window = { ev }
  aiws = await import('../src/renderer/features/aiws/store')
  agents = await import('../src/renderer/features/aiws/agentStore')
  sleep = await import('../src/renderer/features/aiws/sleep')
})
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})
beforeEach(() => {
  metaStore = {}
  aiws.useAiwsStore.setState({ repos: [local, remote], worktreesByRepo: { r1: [main, feat], r2: [far] }, activeWorktreeId: feat.id })
  agents.useAgentStore.setState({
    tabs: [
      { sessionId: 's1', agent: 'claude', worktreeId: feat.id, title: 'c', line: 'claude', exited: false },
      { sessionId: 's2', agent: 'codex', worktreeId: feat.id, title: 'x', line: 'codex', exited: false },
      { sessionId: 's3', agent: 'gemini', worktreeId: feat.id, title: 'g', line: 'gemini', exited: true },
      { sessionId: 's4', agent: 'claude', worktreeId: main.id, title: 'm', line: 'claude', exited: false }
    ],
    activeTabByWorktree: {}
  })
})

const wt = (id: string): Worktree | undefined =>
  Object.values(aiws.useAiwsStore.getState().worktreesByRepo)
    .flat()
    .find((w) => w.id === id)

describe('재우기·깨우기', () => {
  it('재우기 — 살아 있는 탭의 세션 id 를 닫기 전에 받아 두고, 그 작업 단위의 탭은 모두 닫는다(다른 작업 단위는 그대로)', async () => {
    expect(await sleep.sleepWorktree(feat.id)).toBeNull()
    expect(ev.agents.resumeIds).toHaveBeenCalledWith(['s1', 's2'])
    expect(wt(feat.id)?.sleep).toEqual([
      { agent: 'claude', resume: 'cli-s1' },
      { agent: 'codex', resume: null }
    ])
    expect(agents.useAgentStore.getState().tabs.map((x) => x.sessionId)).toEqual(['s4'])
    expect(ev.session.destroy).toHaveBeenCalledTimes(2) // 끝난 탭(s3)은 세션을 또 끄지 않는다
  })

  it('깨우기 — 아는 세션은 resume 으로 다시 띄우고, 모르는 것은 센다. 잠듦 표시는 지운다', async () => {
    await sleep.sleepWorktree(feat.id)
    expect(await sleep.wakeWorktree(feat.id)).toBe(1)
    expect(ev.agents.launch).toHaveBeenCalledTimes(1)
    expect(ev.agents.launch).toHaveBeenCalledWith('claude', feat.path, undefined, 'cli-s1', undefined, undefined)
    expect(wt(feat.id)?.sleep).toBeUndefined()
    expect(agents.useAgentStore.getState().tabs.filter((x) => x.worktreeId === feat.id)).toHaveLength(1)
  })

  it('원격 작업 단위는 재우지 않는다(세션 기록이 서버에 있다)', async () => {
    expect(await sleep.sleepWorktree(far.id)).toBe('remote')
    expect(ev.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})

describe('보관·복원', () => {
  it('보관 — 살아 있는 탭이 있으면 먼저 재우고 숨긴다. 고른 줄이었으면 내린다. 복원하면 다시(잠든 채)', async () => {
    expect(await sleep.archiveWorktree(feat.id)).toBeNull()
    expect(wt(feat.id)).toMatchObject({ isArchived: true, sleep: [{ agent: 'claude' }, { agent: 'codex' }] })
    expect(aiws.useAiwsStore.getState().activeWorktreeId).toBeNull()
    expect(await sleep.restoreWorktree(feat.id)).toBe(true)
    expect(wt(feat.id)?.isArchived).toBeUndefined()
    expect(wt(feat.id)?.sleep).toHaveLength(2)
  })

  it('본 작업 폴더는 보관하지 않는다. 원격은 탭이 없으면 보관된다', async () => {
    expect(await sleep.archiveWorktree(main.id)).toBe('main')
    expect(await sleep.archiveWorktree(far.id)).toBeNull()
    expect(wt(far.id)?.isArchived).toBe(true)
  })
})
