// M10 R2 작업 단위 2차 — 실제 git 으로(임시 폴더에 git init 한 저장소만).
// 체크포인트(WS-18) · 아라 밖 워크트리(WS-19) · 공유 경로 링크와 지울 때 링크 먼저 끊기(WS-20 — 양성 대조) · 보존 브랜치(WS-21).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/main/worktrees/ProjectStore'
import { createWorktreeService } from '../src/main/worktrees/service'
import { git, unlinkSharedPaths } from '../src/main/worktrees/git'
import { EXTERNAL_VISIBILITY_ROLLOUT_AT, areWorktreePathsEqual, classifyExternal, externalSourceOf } from '@shared/worktrees'
import { buildSidebarRows } from '../src/renderer/features/aiws/sidebarRows'
import { jumpList } from '../src/renderer/features/aiws/jumpList'

let dir: string
let repo: string
const T = 30_000

async function sh(args: string[], cwd = repo): Promise<string> {
  const r = await git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
const makeService = () => createWorktreeService({ store: new ProjectStore(join(dir, 'projects.json')), emit: () => {}, workspaceDir: join(dir, 'ws') })
async function project(svc = makeService()) {
  const p = await svc.addProject(repo)
  if (!p.ok) throw new Error('add')
  return { svc, id: p.project.id }
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ara-wt2-')))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  await sh(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), 'a')
  writeFileSync(join(repo, '.gitignore'), 'deps/\n.env\n.claude/\n')
  await sh(['add', '.'])
  await sh(['commit', '-q', '-m', 'init'])
}, T)

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('WS-18 체크포인트', { timeout: T }, () => {
  it('메모·상태는 목록에 얹혀 오고 다시 켜도 남는다. 빈 메모·모르는 상태는 지움', async () => {
    const { svc, id } = await project()
    const r = await svc.createWorktree({ repoId: id, name: 'cp', creationId: 'c1' })
    if (!r.ok) throw new Error(r.message)
    expect(svc.updateMeta(r.worktree.id, { comment: '재현함\n다음: 고치기', workspaceStatus: 'in-review' })).toMatchObject({ comment: '재현함\n다음: 고치기', workspaceStatus: 'in-review' })
    const l = await makeService().listWorktrees(id)
    expect(l.ok && l.worktrees.find((w) => w.id === r.worktree.id)).toMatchObject({ comment: '재현함\n다음: 고치기', workspaceStatus: 'in-review' })
    const cleared = svc.updateMeta(r.worktree.id, { comment: '  ', workspaceStatus: 'bogus' })
    expect(cleared).not.toHaveProperty('comment')
    expect(cleared).not.toHaveProperty('workspaceStatus')
    expect(svc.updateMeta(r.worktree.id, { comment: 'x'.repeat(5000) })?.comment?.length).toBe(4000)
  })
})

describe('WS-19 아라 밖 워크트리', { timeout: T }, () => {
  it('출처 — 저장소 안 .claude/worktrees 는 claude, .gsd-workspaces 는 gsd, 나머지는 other(\\ 와 / 를 같이)', () => {
    expect(externalSourceOf('C:\\r\\repo', 'C:/r/repo/.claude/worktrees/x')).toBe('claude')
    expect(externalSourceOf('/r/repo', '/r/repo/.gsd-workspaces/a/b')).toBe('gsd')
    expect(externalSourceOf('/r/repo', '/r/repo-claude/worktrees/x')).toBe('other')
    expect(externalSourceOf('/r/repo', '/r/.claude/worktrees/x')).toBe('other')
  })

  it('기본값 — 새 프로젝트는 다 숨김, 옛 프로젝트는 그 밖만 보임(에이전트 임시는 숨김). 본 폴더·아라 것은 늘 보임', () => {
    const same = (a: string, b: string) => areWorktreePathsEqual(a, b, 'linux')
    const fresh = { path: '/r/repo', addedAt: EXTERNAL_VISIBILITY_ROLLOUT_AT + 1 }
    const old = { path: '/r/repo', addedAt: EXTERNAL_VISIBILITY_ROLLOUT_AT - 1 }
    const other = { path: '/r/elsewhere', isMainWorktree: false }
    const cl = { path: '/r/repo/.claude/worktrees/x', isMainWorktree: false }
    expect(classifyExternal(fresh, other, undefined, same)).toEqual({ external: 'other', hidden: true })
    expect(classifyExternal(old, other, undefined, same)).toEqual({ external: 'other' })
    expect(classifyExternal(old, cl, undefined, same)).toEqual({ external: 'claude', hidden: true })
    expect(classifyExternal(fresh, { path: '/r/repo', isMainWorktree: true }, undefined, same)).toEqual({})
    expect(classifyExternal(fresh, other, { createdAt: 1 }, same)).toEqual({})
    // 하나씩 보인 경로 > 출처 설정.
    expect(classifyExternal({ ...fresh, shownExternalPaths: ['/r/elsewhere'] }, other, undefined, same)).toEqual({ external: 'other' })
    expect(classifyExternal({ ...old, externalVisibility: { other: 'hide' } }, other, undefined, same)).toEqual({ external: 'other', hidden: true })
    expect(classifyExternal({ ...fresh, externalVisibility: { claude: 'show' } }, cl, undefined, same)).toEqual({ external: 'claude' })
  })

  it('실 git — 손으로 만든 것·Claude Code 것은 숨은 채 실려 오고, 아라가 만든 것은 보인다. 출처·하나씩 보이기가 저장된다', async () => {
    const { svc, id } = await project()
    await sh(['worktree', 'add', '-q', '-b', 'hand', join(dir, 'hand')])
    await sh(['worktree', 'add', '-q', '-b', 'cc', join(repo, '.claude', 'worktrees', 'cc')])
    const made = await svc.createWorktree({ repoId: id, name: 'mine', creationId: 'e1' })
    if (!made.ok) throw new Error(made.message)
    expect(made.worktree.hidden).toBeUndefined()
    const pick = async () => {
      const l = await makeService().listWorktrees(id)
      if (!l.ok) throw new Error('list')
      return Object.fromEntries(l.worktrees.map((w) => [w.displayName, [w.external ?? '-', !!w.hidden]]))
    }
    expect(await pick()).toEqual({ main: ['-', false], hand: ['other', true], cc: ['claude', true], mine: ['-', false] })
    svc.updateProject(id, { shownExternalPaths: [join(dir, 'hand'), 7] })
    svc.updateProject(id, { externalVisibility: { claude: 'show', other: 'nope', bad: 'show' } })
    expect(makeService().listProjects()[0]).toMatchObject({ shownExternalPaths: [join(dir, 'hand')], externalVisibility: { claude: 'show' } })
    expect(await pick()).toEqual({ main: ['-', false], hand: ['other', false], cc: ['claude', false], mine: ['-', false] })
    expect(svc.updateProject('nope', { sharedPaths: ['x'] })).toBeNull()
  })

  it('사이드바 — 숨은 것은 줄에서 빠지고 프로젝트 아래 카드 한 줄(검색 중엔 없음). 점프 목록에서도 빠진다', () => {
    const repoP = { id: 'r', path: '/r', displayName: 'r', kind: 'git' as const, addedAt: 0 }
    const w = (name: string, extra = {}) => ({ id: `r::/${name}`, repoId: 'r', path: `/${name}`, head: '', branch: `refs/heads/${name}`, isBare: false, isMainWorktree: name === 'main', displayName: name, ...extra })
    const list = [w('main'), w('a'), w('h1', { external: 'other', hidden: true }), w('h2', { external: 'claude', hidden: true }), w('h3', { hidden: true, isArchived: true })]
    const rows = buildSidebarRows({ repos: [repoP], worktreesByRepo: { r: list }, pending: [], pinnedIds: [], query: '', groupBy: 'repo' })
    expect(rows.map((x) => (x.kind === 'item' ? x.worktree.displayName : x.kind === 'hidden' ? `hidden:${x.count}` : x.kind))).toEqual(['header', 'main', 'a', 'hidden:2'])
    const searching = buildSidebarRows({ repos: [repoP], worktreesByRepo: { r: list }, pending: [], pinnedIds: [], query: 'h', groupBy: 'repo' })
    expect(searching.some((x) => x.kind === 'hidden' || (x.kind === 'item' && x.worktree.hidden))).toBe(false)
    expect(jumpList(list, [repoP], null, '', new Map()).map((x) => x.displayName)).toEqual(['a', 'main'])
  })
})

describe('WS-20 공유 경로 — 링크로 만들고, 지울 때 링크 먼저 끊는다', { timeout: T }, () => {
  it('폴더는 링크(Windows 접합점)로 붙는다 — 양성 대조: 링크로 쓴 파일이 본 폴더에 보인다. 지운 뒤 본 폴더 원본은 그대로', async () => {
    mkdirSync(join(repo, 'deps', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'deps', 'pkg', 'index.js'), 'orig')
    writeFileSync(join(repo, '.env'), 'A=1')
    writeFileSync(join(repo, '.worktreeinclude'), 'deps\n.env\n')
    const { svc, id } = await project()
    expect(svc.updateProject(id, { sharedPaths: ['./deps/', '../evil', 'C:/x', '.git', 'deps', 3] })?.sharedPaths).toEqual(['deps'])
    const r = await svc.createWorktree({ repoId: id, name: 'shr', creationId: 's1' })
    if (!r.ok) throw new Error(r.message)
    const link = join(r.worktree.path, 'deps')
    // 양성 대조 1: 정말 링크다(복사가 아니다) — lstat 이 링크로 보고, 링크로 쓴 것이 본 폴더에 나타난다.
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    writeFileSync(join(link, 'pkg', 'via-link.txt'), 'shared')
    expect(readFileSync(join(repo, 'deps', 'pkg', 'via-link.txt'), 'utf8')).toBe('shared')
    // .worktreeinclude 의 deps 는 링크된 자리라 복사하지 않았다(원본에 겹쳐 쓰지 않음), .env 는 복사(링크 아님).
    expect(r.ok && r.includeCopyWarning).toBeFalsy()
    expect(lstatSync(join(r.worktree.path, '.env')).isSymbolicLink()).toBe(false)
    expect(readdirSync(join(repo, 'deps')).sort()).toEqual(['pkg'])
    // 만든 링크는 메타에 남고 목록엔 안 실린다.
    expect(new ProjectStore(join(dir, 'projects.json')).meta(r.worktree.id)?.linkedPaths).toEqual(['deps'])
    expect(r.worktree).not.toHaveProperty('linkedPaths')
    // 설정을 비워도(링크 기록은 남음) 지울 때 링크를 먼저 끊는다.
    svc.updateProject(id, { sharedPaths: [] })
    const del = await svc.removeWorktree(id, r.worktree.path)
    expect(del.ok).toBe(true)
    expect(existsSync(r.worktree.path)).toBe(false)
    // 원본 그대로 — 링크를 따라 들어가 지우지 않았다.
    expect(readFileSync(join(repo, 'deps', 'pkg', 'index.js'), 'utf8')).toBe('orig')
    expect(readFileSync(join(repo, 'deps', 'pkg', 'via-link.txt'), 'utf8')).toBe('shared')
  })

  it('unlinkSharedPaths 는 링크만 끊는다 — 같은 이름의 진짜 폴더는 그대로(음성 대조), 위험한 경로는 무시', async () => {
    const wt = join(dir, 'fake-wt')
    mkdirSync(join(wt, 'deps'), { recursive: true })
    writeFileSync(join(wt, 'deps', 'keep.txt'), 'k')
    await unlinkSharedPaths(wt, ['deps', '../repo', 'missing'])
    expect(readFileSync(join(wt, 'deps', 'keep.txt'), 'utf8')).toBe('k')
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
  })
})

describe('WS-21 보존 브랜치', { timeout: T }, () => {
  it('커밋이 있는 브랜치는 남기고 알린다(head 포함) — 강제 지우기는 head 가 맞을 때만. 커밋 없으면 같이 지운다', async () => {
    const { svc, id } = await project()
    const r = await svc.createWorktree({ repoId: id, name: 'work', creationId: 'b1' })
    if (!r.ok) throw new Error(r.message)
    writeFileSync(join(r.worktree.path, 'n.txt'), 'n')
    await sh(['add', '.'], r.worktree.path)
    await sh(['commit', '-q', '-m', 'wip'], r.worktree.path)
    const head = (await sh(['rev-parse', 'HEAD'], r.worktree.path)).trim()
    const del = await svc.removeWorktree(id, r.worktree.path)
    expect(del).toEqual({ ok: true, preservedBranch: { branchName: 'work', head } })
    expect(existsSync(r.worktree.path)).toBe(false)
    expect((await sh(['branch', '--list', 'work'])).trim()).not.toBe('')
    // 그사이 움직였으면(다른 head) 거절, 이상한 이름도 거절.
    expect((await svc.forceDeletePreservedBranch(id, 'work', '0'.repeat(40))).ok).toBe(false)
    expect((await svc.forceDeletePreservedBranch(id, 'work', (await sh(['rev-parse', 'main'])).trim())).ok).toBe(false)
    expect((await sh(['branch', '--list', 'work'])).trim()).not.toBe('')
    expect((await svc.forceDeletePreservedBranch(id, '-D', head)).ok).toBe(false)
    expect(await svc.forceDeletePreservedBranch(id, 'work', head)).toEqual({ ok: true })
    expect((await sh(['branch', '--list', 'work'])).trim()).toBe('')

    const clean = await svc.createWorktree({ repoId: id, name: 'clean', creationId: 'b2' })
    if (!clean.ok) throw new Error(clean.message)
    expect(await svc.removeWorktree(id, clean.worktree.path)).toEqual({ ok: true })
    expect((await sh(['branch', '--list', 'clean'])).trim()).toBe('')
  })

  it('체크아웃된 브랜치는 강제로도 지우지 않는다', async () => {
    const { svc, id } = await project()
    await sh(['worktree', 'add', '-q', '-b', 'busy', join(dir, 'busy')])
    const head = (await sh(['rev-parse', 'busy'])).trim()
    expect((await svc.forceDeletePreservedBranch(id, 'busy', head)).ok).toBe(false)
    expect((await sh(['branch', '--list', 'busy'])).trim()).not.toBe('')
  })
})
