import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, app: { getPath: () => '' } }))
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyAiSessions } from '../src/shared/aiSession'
import { importLegacyAi } from '../src/main/agents/legacyImport'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import type { AddProjectResult } from '../src/main/worktrees/service'

// M3 S1 데이터 이전(한 번) — 옛 작업대(aiSessions)·최근 조합·기본 플래그. 시험은 임시 폴더의 workspace.json 만 쓴다.

describe('legacyAiSessions — 옛 작업대 줄 읽기', () => {
  it('로컬 폴더는 한 번씩, 원격은 개수만, 모양이 틀린 줄은 버린다', () => {
    const r = legacyAiSessions([
      { id: 'a', kind: 'local', cwd: 'D:/work/app' },
      { id: 'b', kind: 'local', cwd: 'D:/work/app' }, // 같은 폴더(분리 세션 부모·자식 등)
      { id: 'c', cwd: 'D:/work/lib' }, // kind 없음 = 로컬(옛 aiSessionsOf 와 같은 기본값)
      { id: 'd', kind: 'remote', profileId: 'p1', cwd: '/srv/x' },
      { id: 'e', kind: 'remote', cwd: '/srv/y' },
      { id: 'f', kind: 'local', cwd: '' },
      null,
      'junk'
    ])
    expect(r).toEqual({ local: ['D:/work/app', 'D:/work/lib'], remote: 2 })
  })

  it('배열이 아니면 할 일 없음', () => {
    for (const bad of [undefined, null, {}, 'x', 1]) expect(legacyAiSessions(bad)).toEqual({ local: [], remote: 0 })
  })
})

describe('★ importLegacyAi — 옮기고 지운다, 두 번 돌아도 같다', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const seed = (): WorkspaceStore => {
    dir = mkdtempSync(join(tmpdir(), 'ara-legacy-'))
    const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    const snap = ws.get()
    snap.aiSessions = [
      { id: 'a', kind: 'local', cwd: join(dir, 'app') },
      { id: 'b', kind: 'local', cwd: join(dir, 'gone') },
      { id: 'c', kind: 'remote', profileId: 'p', cwd: '/srv/x' }
    ]
    snap.ui.aiCliRecent = [{ profileId: 'local', path: 'D:/x', cli: 'claude', flags: [] }]
    snap.ui.aiCliFlags = { claude: ['skipPerms'] }
    ws.flush()
    return ws
  }
  // repos:add 흉내 — 없는 폴더는 notFound(지어내지 않는다).
  const fakeAdd = (calls: string[]) => async (path: string): Promise<AddProjectResult> => {
    calls.push(path)
    if (path.endsWith('gone')) return { ok: false, reason: 'notFound', message: path }
    return { ok: true, project: { id: 'id:' + path, path, displayName: 'app', kind: 'folder', addedAt: 0 } }
  }

  it('로컬 폴더는 프로젝트로, 원격은 개수만 알리고, 옛 키 셋을 지운다(디스크까지)', async () => {
    const ws = seed()
    const calls: string[] = []
    const n = await importLegacyAi(ws, fakeAdd(calls))
    expect(n).toEqual({ projects: ['app'], remote: 1 })
    expect(calls).toEqual([join(dir, 'app'), join(dir, 'gone')])
    const disk = JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'))
    expect(disk).not.toHaveProperty('aiSessions')
    expect(disk.ui).not.toHaveProperty('aiCliRecent')
    expect(disk.ui).not.toHaveProperty('aiCliFlags')
  })

  it('★ 두 번째는 할 일이 없다 — 안내도 없고 프로젝트 추가도 안 부른다', async () => {
    const ws = seed()
    await importLegacyAi(ws, fakeAdd([]))
    const calls: string[] = []
    expect(await importLegacyAi(ws, fakeAdd(calls))).toBeNull()
    expect(calls).toEqual([])
    // 다시 읽은 store 에서도 같다(재시작)
    expect(await importLegacyAi(new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0'), fakeAdd(calls))).toBeNull()
    expect(calls).toEqual([])
  })

  it('옛 키가 없는 새 사용자 — 안내 없음', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ara-legacy-'))
    const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    expect(await importLegacyAi(ws, fakeAdd([]))).toBeNull()
  })
})
