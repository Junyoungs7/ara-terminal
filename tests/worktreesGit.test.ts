// M2 작업 단위 — 실제 git 으로(임시 폴더에 git init 한 저장소만. 사내 저장소에 닿지 않는다).
// 프로젝트 등록 · 워크트리 목록(외부에서 만든 것 포함) · 생성(진행 이벤트·이름 겹침·.worktreeinclude) · 지우기(브랜치는 남김)
// · 취소 · 재시작 정리 · 분기 지점.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/main/worktrees/ProjectStore'
import { createWorktreeService } from '../src/main/worktrees/service'
import { git } from '../src/main/worktrees/git'
import type { CreateWorktreeProgressEvent } from '@shared/worktrees'

let dir: string
let repo: string
let events: CreateWorktreeProgressEvent[]

async function sh(args: string[], cwd = repo): Promise<string> {
  const r = await git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function makeService() {
  return createWorktreeService({ store: new ProjectStore(join(dir, 'projects.json')), emit: (e) => events.push(e), workspaceDir: join(dir, 'ws') })
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ara-wt-')))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  events = []
  await sh(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'a')
  writeFileSync(join(repo, '.gitignore'), '.env\nsecret/\n')
  await sh(['add', '.'])
  await sh(['commit', '-q', '-m', 'init'])
  await sh(['tag', 'v1'])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('프로젝트 등록', () => {
  it('git 저장소는 뿌리로, git 아닌 폴더는 폴더 프로젝트로 — 같은 경로는 한 번만', async () => {
    const svc = makeService()
    mkdirSync(join(repo, 'sub'))
    const a = await svc.addProject(join(repo, 'sub'))
    expect(a.ok && a.project.kind).toBe('git')
    expect(a.ok && a.project.path.replace(/\\/g, '/').toLowerCase()).toBe(repo.replace(/\\/g, '/').toLowerCase())
    const again = await svc.addProject(repo)
    expect(again.ok && a.ok && again.project.id === a.project.id).toBe(true)
    mkdirSync(join(dir, 'plain'))
    const f = await svc.addProject(join(dir, 'plain'))
    expect(f.ok && f.project.kind).toBe('folder')
    expect((await svc.addProject(join(dir, 'nope'))).ok).toBe(false)
    expect(svc.listProjects()).toHaveLength(2)
    // 다시 열어도 남아 있다(projects.json).
    expect(makeService().listProjects()).toHaveLength(2)
    expect(svc.removeProject(f.ok ? f.project.id : '').ok).toBe(true)
    expect(existsSync(join(dir, 'plain'))).toBe(true) // 목록에서만 뺀다
  })

  it('폴더 프로젝트 = 작업 단위 하나(그 폴더 자체, 워크트리 없이)', async () => {
    const svc = makeService()
    mkdirSync(join(dir, 'plain'))
    const f = await svc.addProject(join(dir, 'plain'))
    if (!f.ok) throw new Error('add')
    const l = await svc.listWorktrees(f.project.id)
    expect(l.ok && l.worktrees.map((w) => [w.path, w.isMainWorktree])).toEqual([[join(dir, 'plain'), true]])
    expect((await svc.createWorktree({ repoId: f.project.id, name: 'x', creationId: 'c0' })).ok).toBe(false)
  })
})

describe('워크트리', () => {
  it('목록 — 본 폴더 + 외부에서 만든 워크트리도 보인다', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    await sh(['worktree', 'add', '-q', '-b', 'outside', join(dir, 'outside')])
    const l = await svc.listWorktrees(p.project.id)
    if (!l.ok) throw new Error('list')
    expect(l.worktrees.map((w) => [w.displayName, w.isMainWorktree])).toEqual([
      ['main', true],
      ['outside', false]
    ])
    expect(l.worktrees[0].id).toBe(`${p.project.id}::${l.worktrees[0].path}`)
  })

  it('만들기 — 위치 규칙·진행 이벤트·.worktreeinclude 복사, 겹치면 -2', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    writeFileSync(join(repo, '.env'), 'A=1')
    mkdirSync(join(repo, 'secret'))
    writeFileSync(join(repo, 'secret', 'k'), 'k')
    writeFileSync(join(repo, '.worktreeinclude'), '.env\nsecret/\na.txt\nmissing\n')
    const r = await svc.createWorktree({ repoId: p.project.id, name: '새 작업', creationId: 'c1', baseBranch: 'v1' })
    if (!r.ok) throw new Error(r.message)
    expect(r.worktree.path.replace(/\\/g, '/')).toBe(join(dir, 'ws', 'repo', '새-작업').replace(/\\/g, '/'))
    expect(r.worktree.branch).toBe('refs/heads/새-작업')
    expect(readFileSync(join(r.worktree.path, '.env'), 'utf8')).toBe('A=1')
    expect(existsSync(join(r.worktree.path, 'secret', 'k'))).toBe(true)
    expect(events.map((e) => e.phase).filter((ph) => ph !== 'output' && ph !== 'creating')).toEqual(['start', 'copying', 'done'])
    expect(events.every((e) => e.creationId === 'c1')).toBe(true)
    const r2 = await svc.createWorktree({ repoId: p.project.id, name: '새 작업', creationId: 'c2' })
    expect(r2.ok && r2.worktree.branch).toBe('refs/heads/새-작업-2')
    expect(makeService().listProjects().length).toBe(1)
  })

  it('잘못된 이름·없는 분기 지점은 실패로 알리고 흔적을 남기지 않는다', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    expect(await svc.createWorktree({ repoId: p.project.id, name: '!!!', creationId: 'c3' })).toMatchObject({ ok: false, reason: 'invalidName' })
    const bad = await svc.createWorktree({ repoId: p.project.id, name: 'x', creationId: 'c4', baseBranch: 'no-such-ref' })
    expect(bad).toMatchObject({ ok: false, reason: 'git' })
    expect(events.at(-1)).toMatchObject({ phase: 'failed', reason: 'git' })
    expect(existsSync(join(dir, 'ws', 'repo', 'x'))).toBe(false)
    expect((await sh(['branch', '--list', 'x'])).trim()).toBe('')
    expect(new ProjectStore(join(dir, 'projects.json')).pending()).toEqual([])
  })

  it('지우기 — 작업 폴더만, 브랜치는 남긴다. 본 폴더·목록에 없는 경로는 거절', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    const r = await svc.createWorktree({ repoId: p.project.id, name: 'gone', creationId: 'c5' })
    if (!r.ok) throw new Error(r.message)
    expect((await svc.removeWorktree(p.project.id, repo)).ok).toBe(false)
    expect((await svc.removeWorktree(p.project.id, join(dir, 'elsewhere'))).ok).toBe(false)
    writeFileSync(join(r.worktree.path, 'dirty.txt'), 'x')
    expect((await svc.removeWorktree(p.project.id, r.worktree.path)).ok).toBe(false) // 커밋 안 된 변경 — git 이 거절
    expect((await svc.removeWorktree(p.project.id, r.worktree.path, true)).ok).toBe(true)
    expect(existsSync(r.worktree.path)).toBe(false)
    expect((await sh(['branch', '--list', 'gone'])).trim()).not.toBe('')
  })

  it('취소 — 시작 직후 끊으면 canceled 로 끝나고 폴더·브랜치·기록이 남지 않는다', async () => {
    const svc = createWorktreeService({
      store: new ProjectStore(join(dir, 'projects.json')),
      emit: (e) => {
        events.push(e)
        if (e.phase === 'start') expect(svc.cancelCreate(e.creationId).ok).toBe(true)
      },
      workspaceDir: join(dir, 'ws')
    })
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    expect(await svc.createWorktree({ repoId: p.project.id, name: 'stop', creationId: 'c6' })).toMatchObject({ ok: false, reason: 'canceled' })
    expect(events.at(-1)).toMatchObject({ phase: 'failed', reason: 'canceled' })
    expect(existsSync(join(dir, 'ws', 'repo', 'stop'))).toBe(false)
    expect((await sh(['branch', '--list', 'stop'])).trim()).toBe('')
    expect(new ProjectStore(join(dir, 'projects.json')).pending()).toEqual([])
    expect(svc.cancelCreate('none').ok).toBe(false)
  })

  it('재시작 정리 — git 이 등록 못 한 반쯤 만든 폴더·브랜치는 지우고, 등록된 것은 살린다', async () => {
    const store = new ProjectStore(join(dir, 'projects.json'))
    const half = join(dir, 'ws', 'repo', 'half')
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, 'partial'), '')
    await sh(['branch', 'half'])
    await sh(['worktree', 'add', '-q', '-b', 'whole', join(dir, 'ws', 'repo', 'whole')])
    const base = { repoId: 'r', repoPath: repo, startedAt: 0, pathWasFree: true }
    store.beginPending({ ...base, creationId: 'h', path: half, branch: 'half' })
    store.beginPending({ ...base, creationId: 'w', path: join(dir, 'ws', 'repo', 'whole'), branch: 'whole' })
    const svc = createWorktreeService({ store, emit: () => {} })
    expect(await svc.reconcilePending()).toEqual([
      { creationId: 'h', verdict: 'removeLeftover' },
      { creationId: 'w', verdict: 'keep' }
    ])
    expect(existsSync(half)).toBe(false)
    expect((await sh(['branch', '--list', 'half'])).trim()).toBe('')
    expect(existsSync(join(dir, 'ws', 'repo', 'whole'))).toBe(true)
    expect(store.pending()).toEqual([])
  })
})

describe('분기 지점(WS-04)', () => {
  it('로컬 브랜치·태그(원격은 시험 저장소에 없다) — 검색어로 거른다', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    await sh(['branch', 'feature/login'])
    const all = await svc.searchBaseRefs(p.project.id, '')
    expect(all).toEqual(expect.arrayContaining([
      { refName: 'main', kind: 'local' },
      { refName: 'feature/login', kind: 'local' },
      { refName: 'v1', kind: 'tag' }
    ]))
    expect((await svc.searchBaseRefs(p.project.id, 'LOG')).map((r) => r.refName)).toEqual(['feature/login'])
  })
})

describe('통계(WS-05 — +/− 줄 수 · main 에서 n 커밋 앞)', () => {
  it('갈림점부터 커밋 수와 줄 수(커밋 안 한 변경 포함), 목록에 없는 경로는 거절', async () => {
    const svc = makeService()
    const p = await svc.addProject(repo)
    if (!p.ok) throw new Error('add')
    const wt = join(dir, 'feat')
    await sh(['worktree', 'add', '-q', '-b', 'feat', wt])
    writeFileSync(join(wt, 'b.txt'), 'b1\nb2\n')
    await sh(['add', '.'], wt)
    await sh(['commit', '-q', '-m', 'b'], wt)
    writeFileSync(join(wt, 'a.txt'), 'A\n') // 커밋 안 한 변경: a → A (1+ 1−)
    expect(await svc.worktreeStats(p.project.id, wt)).toEqual({ ok: true, base: 'main', ahead: 1, added: 3, removed: 1 })
    expect(await svc.worktreeStats(p.project.id, repo)).toEqual({ ok: true, base: 'main', ahead: 0, added: 0, removed: 0 })
    expect(await svc.worktreeStats(p.project.id, join(dir, 'nope'))).toEqual({ ok: false })
  })
})
