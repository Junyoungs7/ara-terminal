// 3차 작업 단위 — orca.yaml(WS-23) · 중첩 워크스페이스(WS-24) · 정리 화면(WS-25) · 디스크 사용량(WS-26) · sparse checkout(WS-27).
// 실제 git 으로(임시 폴더에 git init 한 저장소만). Orca 시험 중 옮긴 것: shared/orca-yaml(파싱·공유 폴더 거르기),
// main/hooks-setup-runner-script.test.ts(러너 글), main/ipc/sparse-checkout-directories(경로 거르기), resolved-worktree-lineage(고리·낡은 연결).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/main/worktrees/ProjectStore'
import { createWorktreeService } from '../src/main/worktrees/service'
import { git } from '../src/main/worktrees/git'
import { buildPosixRunnerScript, buildWindowsRunnerScript, parseOrcaYaml, scriptHash } from '../src/main/worktrees/orcaYaml'
import { scanDiskUsage } from '../src/main/worktrees/diskUsage'
import { lineageChildren, lineageDescendants, normalizeSparseDirectories, type CreateWorktreeProgressEvent, type Worktree } from '@shared/worktrees'
import { buildSidebarRows } from '../src/renderer/features/aiws/sidebarRows'
import { filterCleanupRows, fmtBytes, type CleanupRow } from '../src/renderer/features/aiws/CleanupDialog'

let dir: string
let repo: string
const T = 60_000
const WIN = process.platform === 'win32'

async function sh(args: string[], cwd = repo): Promise<string> {
  const r = await git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
function makeService(events: CreateWorktreeProgressEvent[] = []) {
  return createWorktreeService({ store: new ProjectStore(join(dir, 'projects.json')), emit: (e) => events.push(e), workspaceDir: join(dir, 'ws') })
}
async function project(events: CreateWorktreeProgressEvent[] = []) {
  const svc = makeService(events)
  const p = await svc.addProject(repo)
  if (!p.ok) throw new Error('add')
  return { svc, id: p.project.id }
}
async function commitYaml(yaml: string): Promise<void> {
  writeFileSync(join(repo, 'orca.yaml'), yaml)
  await sh(['add', 'orca.yaml'])
  await sh(['commit', '-q', '-m', 'yaml'])
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ara-wt3-')))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  await sh(['init', '-q', '-b', 'main'])
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, 'apps', 'api'), { recursive: true })
  writeFileSync(join(repo, 'apps', 'web', 'w.txt'), 'w')
  writeFileSync(join(repo, 'apps', 'api', 'a.txt'), 'a')
  writeFileSync(join(repo, 'root.txt'), 'r')
  writeFileSync(join(repo, '.gitignore'), '.cache/\nnotdir\nmarker.txt\n')
  await sh(['add', '.'])
  await sh(['commit', '-q', '-m', 'init'])
}, T)

afterEach(() => {
  // 링크(접합점)를 먼저 끊는다 — 따라 들어가 본 폴더를 지우지 않게(메모: worktree junction 은 원본을 지운다).
  for (const p of [join(dir, 'ws')]) if (existsSync(p)) rmLinksUnder(p)
  rmSync(dir, { recursive: true, force: true })
})
function rmLinksUnder(root: string): void {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) rmSync(p, { force: true })
      else if (st.isDirectory() && n !== '.git') walk(p)
    }
  }
  walk(root)
}

describe('WS-23 orca.yaml 파싱(Orca parseOrcaYaml)', () => {
  it('Orca 문서 예제 — setup·archive·정책·공유 폴더. 안 쓰는 칸(defaultTabs)은 무시', () => {
    const y = parseOrcaYaml(
      'scripts:\n  setup: |\n    pnpm install\n  archive: |\n    echo Workspace archived\nsetupAgentStartupPolicy: wait-for-setup\ndefaultTabs:\n  - title: Agent\nworktree:\n  sharedDirectories:\n    - .cache\n'
    )
    expect(y).toEqual({
      scripts: { setup: 'pnpm install', archive: 'echo Workspace archived' },
      setupAgentStartupPolicy: 'wait-for-setup',
      worktree: { sharedDirectories: ['.cache'] }
    })
  })
  it('중복 키·YAML 오류·mapping 아닌 뿌리·256KB 초과는 파일째 거절', () => {
    expect(parseOrcaYaml('scripts:\n  setup: a\nscripts:\n  setup: b\n')).toBeNull()
    expect(parseOrcaYaml('scripts: [\n')).toBeNull()
    expect(parseOrcaYaml('- a\n- b\n')).toBeNull()
    expect(parseOrcaYaml('scripts:\n  setup: x\n#' + 'x'.repeat(256 * 1024))).toBeNull()
  })
  it('잘못된 칸만 빠진다 — 모르는 정책·숫자 스크립트·64KB 넘는 스크립트', () => {
    expect(parseOrcaYaml('setupAgentStartupPolicy: later\nscripts:\n  setup: 5\n  archive: ok\n')).toEqual({ scripts: { archive: 'ok' } })
    expect(parseOrcaYaml(`scripts:\n  setup: ${'y'.repeat(65 * 1024)}\n  archive: ok\n`)).toEqual({ scripts: { archive: 'ok' } })
  })
  it('공유 폴더 — \\ → /, 앞 ./·뒤 / 정리, 겹침 제거. 절대·드라이브·..·안쪽 ./·.git 는 거절', () => {
    const y = parseOrcaYaml(
      'worktree:\n  sharedDirectories:\n    - ./node_modules/\n    - "a\\\\b"\n    - node_modules\n    - /abs\n    - "C:/x"\n    - ../up\n    - a/./b\n    - .git/hooks\n    - a//b\n'
    )
    expect(y?.worktree?.sharedDirectories).toEqual(['node_modules', 'a/b'])
  })
})

describe('WS-23 러너 글(Orca setup-runner-script-text)', () => {
  it('Windows — 줄마다 call 과 실패 시 멈춤, 빈 줄 보존, 셔뱅이면 거절', () => {
    expect(buildWindowsRunnerScript('pnpm install\n\necho done')).toBe(
      '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\ncall pnpm install\r\nif errorlevel 1 exit /b %errorlevel%\r\n\r\ncall echo done\r\nif errorlevel 1 exit /b %errorlevel%\r\n'
    )
    expect(buildWindowsRunnerScript('#!/bin/bash\necho x')).toMatch(/exit \/b 1\r\n$/)
    expect(buildWindowsRunnerScript('#!/bin/bash\necho x')).not.toContain('call echo x')
  })
  it('POSIX — bash + set -e, CRLF → LF', () => {
    expect(buildPosixRunnerScript('a\r\nb')).toBe('#!/usr/bin/env bash\nset -e\na\nb\n')
  })
})

describe('WS-27 sparse 경로(Orca normalizeSparseDirectories)', () => {
  it('정리·겹침 제거, 절대·.. 는 던진다', () => {
    expect(normalizeSparseDirectories([' apps/web/ ', 'apps\\api', 'apps/web', '.', ''])).toEqual(['apps/web', 'apps/api'])
    expect(() => normalizeSparseDirectories(['/etc'])).toThrow()
    expect(() => normalizeSparseDirectories(['C:\\x'])).toThrow()
    expect(() => normalizeSparseDirectories(['a/../b'])).toThrow()
  })
})

const wt = (id: string, extra: Partial<Worktree> = {}): Worktree => ({
  id: `r::${id}`,
  repoId: 'r',
  path: id,
  head: '',
  branch: `refs/heads/${id}`,
  isBare: false,
  isMainWorktree: false,
  displayName: id,
  ...extra
})

describe('WS-24 계보(Orca resolved-worktree-lineage)', () => {
  it('유효한 부모만 — 다른 프로젝트·낡은 createdAt·자기 자신은 버리고, 고리는 고리 안 연결만 버린다(꼬리는 산다)', () => {
    const list = [
      wt('p', { createdAt: 1 }),
      wt('c', { createdAt: 2, parentId: 'r::p', parentCreatedAt: 1 }),
      wt('g', { createdAt: 3, parentId: 'r::c', parentCreatedAt: 2 }),
      wt('stale', { parentId: 'r::p', parentCreatedAt: 99 }),
      { ...wt('other', { parentId: 'r::p', parentCreatedAt: 1 }), repoId: 'x', id: 'x::other' },
      wt('a', { createdAt: 10, parentId: 'r::b', parentCreatedAt: 11 }),
      wt('b', { createdAt: 11, parentId: 'r::a', parentCreatedAt: 10 }),
      wt('tail', { parentId: 'r::a', parentCreatedAt: 10 })
    ]
    const ch = lineageChildren(list)
    expect(ch.get('r::p')).toEqual(['r::c'])
    expect(ch.get('r::c')).toEqual(['r::g'])
    expect(ch.get('r::a')).toEqual(['r::tail'])
    expect(ch.has('r::b')).toBe(false)
    expect(lineageDescendants(ch, 'r::p')).toEqual(['r::g', 'r::c'])
  })
  it('사이드바 — 부모 아래 자식이 들어가고 부모 줄에 하위 수, 접으면 자손이 빠진다. 부모를 고정하면 자식은 맨 위로', () => {
    const repoP = { id: 'r', path: '/r', displayName: 'r', kind: 'git' as const, addedAt: 0 }
    const list = [wt('p', { createdAt: 1 }), wt('c', { createdAt: 2, parentId: 'r::p', parentCreatedAt: 1 }), wt('g', { parentId: 'r::c', parentCreatedAt: 2 }), wt('z')]
    const base = { repos: [repoP], worktreesByRepo: { r: list }, pending: [], pinnedIds: [] as string[], query: '', groupBy: 'repo' as const }
    const items = (rows: ReturnType<typeof buildSidebarRows>) => rows.flatMap((r) => (r.kind === 'item' ? [[r.worktree.displayName, r.depth ?? 0, r.childCount ?? 0]] : []))
    expect(items(buildSidebarRows(base))).toEqual([
      ['p', 0, 1],
      ['c', 1, 1],
      ['g', 2, 0],
      ['z', 0, 0]
    ])
    expect(items(buildSidebarRows({ ...base, collapsedLineage: ['r::p'] }))).toEqual([
      ['p', 0, 1],
      ['z', 0, 0]
    ])
    expect(items(buildSidebarRows({ ...base, pinnedIds: ['r::p'] })).slice(1)).toEqual([
      ['c', 0, 1],
      ['g', 1, 0],
      ['z', 0, 0]
    ])
  })
})

describe('WS-25 정리 화면 거르기', () => {
  const now = Date.UTC(2026, 10, 2)
  const day = 86_400_000
  const repoP = { id: 'r', path: '/r', displayName: 'proj', kind: 'git' as const, addedAt: 0 }
  const rows: CleanupRow[] = [
    { w: wt('old'), repo: repoP, git: { path: 'old', dirty: 0, merged: true, lastCommitAt: now - 40 * day }, activeAt: now - 40 * day, size: { path: 'old', ok: true, bytes: 10, entries: 1, truncated: false, top: [] } },
    { w: wt('new'), repo: repoP, git: { path: 'new', dirty: 2, merged: false, lastCommitAt: now - day }, activeAt: now - day, size: { path: 'new', ok: true, bytes: 500, entries: 1, truncated: false, top: [] } },
    { w: wt('nap', { sleep: [] }), repo: repoP, activeAt: null }
  ]
  const names = (r: CleanupRow[]) => r.map((x) => x.w.displayName)
  it('병합됨·30일 넘게·잠듦/보관, 검색, 정렬(오래된 순 — 모르는 것 맨 뒤 / 큰 순 / 이름 순)', () => {
    expect(names(filterCleanupRows(rows, 'all', '', 'age', now))).toEqual(['old', 'new', 'nap'])
    expect(names(filterCleanupRows(rows, 'merged', '', 'age', now))).toEqual(['old'])
    expect(names(filterCleanupRows(rows, 'stale', '', 'age', now))).toEqual(['old'])
    expect(names(filterCleanupRows(rows, 'idle', '', 'age', now))).toEqual(['nap'])
    expect(names(filterCleanupRows(rows, 'all', 'NE', 'age', now))).toEqual(['new'])
    expect(names(filterCleanupRows(rows, 'all', '', 'size', now))).toEqual(['new', 'old', 'nap'])
    expect(names(filterCleanupRows(rows, 'all', '', 'name', now))).toEqual(['nap', 'new', 'old'])
    expect(fmtBytes(500)).toBe('500 B')
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('실 git', { timeout: T }, () => {
  it('WS-27 sparse — 고른 폴더만 체크아웃되고(뿌리 파일은 cone 이 늘 넣는다) 메타에 남는다. 잘못된 경로는 만들기 전에 거절', async () => {
    const { svc, id } = await project()
    const r = await svc.createWorktree({ repoId: id, name: 'sp', creationId: 'c1', sparseDirectories: ['apps/web'] })
    if (!r.ok) throw new Error(r.message)
    expect(existsSync(join(r.worktree.path, 'apps', 'web', 'w.txt'))).toBe(true)
    expect(existsSync(join(r.worktree.path, 'apps', 'api'))).toBe(false)
    expect(existsSync(join(r.worktree.path, 'root.txt'))).toBe(true)
    expect(r.worktree.sparseDirectories).toEqual(['apps/web'])
    const bad = await svc.createWorktree({ repoId: id, name: 'sp2', creationId: 'c2', sparseDirectories: ['../x'] })
    expect(bad).toMatchObject({ ok: false, reason: 'invalidName' })
    // 프리셋 저장·지우기
    const saved = svc.saveSparsePreset(id, { name: ' web ', directories: ['apps/web/', 'apps/web'] })
    expect(saved).toMatchObject({ name: 'web', directories: ['apps/web'] })
    expect(svc.saveSparsePreset(id, { name: 'x', directories: ['/abs'] })).toHaveProperty('error')
    expect(makeService().listSparsePresets(id)).toHaveLength(1)
    if ('id' in saved) expect(svc.removeSparsePreset(id, saved.id)).toBe(true)
    expect(svc.listSparsePresets(id)).toEqual([])
  })

  it('WS-23 공유 폴더 — 본 폴더에 있고 gitignore 된 **폴더**만 링크(양성 대조: 링크로 쓴 파일이 원본에 보임), 지워도 원본 그대로', async () => {
    await commitYaml('worktree:\n  sharedDirectories:\n    - .cache\n    - notdir\n    - apps\n    - missing\n')
    mkdirSync(join(repo, '.cache'))
    writeFileSync(join(repo, '.cache', 'keep.txt'), 'k')
    writeFileSync(join(repo, 'notdir'), 'file')
    const { svc, id } = await project()
    const r = await svc.createWorktree({ repoId: id, name: 'sh', creationId: 'c1' })
    if (!r.ok) throw new Error(r.message)
    expect(lstatSync(join(r.worktree.path, '.cache')).isSymbolicLink()).toBe(true)
    writeFileSync(join(r.worktree.path, '.cache', 'via-link.txt'), 'v')
    expect(existsSync(join(repo, '.cache', 'via-link.txt'))).toBe(true)
    // 파일(notdir)·추적되는 폴더(apps)·없는 것은 링크 안 함
    expect(existsSync(join(r.worktree.path, 'notdir'))).toBe(false)
    expect(lstatSync(join(r.worktree.path, 'apps')).isSymbolicLink()).toBe(false)
    const rm = await svc.removeWorktree(id, r.worktree.path)
    expect(rm.ok).toBe(true)
    expect(readFileSync(join(repo, '.cache', 'keep.txt'), 'utf8')).toBe('k')
  })

  it('WS-23 setup — 승인 전엔 안 돈다(untrusted). 아무 hash 는 승인 안 됨. 승인 후 wait-for-setup 이면 만들기가 끝날 때 이미 돌았다(ORCA_* env)', async () => {
    const setup = WIN ? 'echo %ORCA_WORKSPACE_NAME%> marker.txt' : 'echo "$ORCA_WORKSPACE_NAME" > marker.txt'
    await commitYaml(`setupAgentStartupPolicy: wait-for-setup\nscripts:\n  setup: |\n    ${setup}\n`)
    const events: CreateWorktreeProgressEvent[] = []
    const { svc, id } = await project(events)
    const r1 = await svc.createWorktree({ repoId: id, name: 'su1', creationId: 'c1', runSetup: true })
    expect(r1).toMatchObject({ ok: true, setupWarning: 'untrusted' })
    if (r1.ok) expect(existsSync(join(r1.worktree.path, 'marker.txt'))).toBe(false)
    const pv = await svc.orcaYamlPreview(id)
    expect(pv.setup?.trusted).toBe(false)
    expect(pv.setupAgentStartupPolicy).toBe('wait-for-setup')
    expect(await svc.trustOrcaScripts(id, ['0'.repeat(64)])).toBe(false)
    expect(await svc.trustOrcaScripts(id, [scriptHash(setup)])).toBe(true)
    expect((await svc.orcaYamlPreview(id)).setup?.trusted).toBe(true)
    const r2 = await svc.createWorktree({ repoId: id, name: 'su2', creationId: 'c2', runSetup: true })
    if (!r2.ok) throw new Error(r2.message)
    expect(r2.setupWarning).toBeUndefined()
    expect(readFileSync(join(r2.worktree.path, 'marker.txt'), 'utf8').trim()).toBe('su2')
    expect(events.filter((e) => e.creationId === 'c2').map((e) => e.phase)).toContain('setup')
    // runSetup 을 안 주면 승인돼 있어도 안 돈다(Orca --setup skip)
    const r3 = await svc.createWorktree({ repoId: id, name: 'su3', creationId: 'c3' })
    if (r3.ok) expect(existsSync(join(r3.worktree.path, 'marker.txt'))).toBe(false)
  })

  it('WS-23 setup start-immediately(기본) — done 이 먼저, setup 끝을 setupDone 으로(실패면 ok false)', async () => {
    await commitYaml('scripts:\n  setup: |\n    exit 3\n')
    const events: CreateWorktreeProgressEvent[] = []
    const { svc, id } = await project(events)
    await svc.trustOrcaScripts(id, [scriptHash('exit 3')])
    const r = await svc.createWorktree({ repoId: id, name: 'si', creationId: 'c1', runSetup: true })
    expect(r.ok).toBe(true)
    for (let i = 0; i < 100 && !events.some((e) => e.phase === 'setupDone'); i++) await new Promise((res) => setTimeout(res, 100))
    const phases = events.map((e) => e.phase)
    expect(phases.indexOf('done')).toBeLessThan(phases.indexOf('setupDone'))
    expect(events.find((e) => e.phase === 'setupDone')).toMatchObject({ ok: false })
  })

  it('WS-23 archive — 승인된 archive 가 실패하면 지우기를 막고, 강제로 지우기면 받아들이고 지운다. 승인 안 된 archive 는 안 돈다', async () => {
    await commitYaml('scripts:\n  archive: |\n    exit 1\n')
    const { svc, id } = await project()
    const a = await svc.createWorktree({ repoId: id, name: 'ar1', creationId: 'c1' })
    if (!a.ok) throw new Error(a.message)
    // 승인 전 — archive 를 안 돌리고 지운다
    expect((await svc.removeWorktree(id, a.worktree.path)).ok).toBe(true)
    await svc.trustOrcaScripts(id, [scriptHash('exit 1')])
    const b = await svc.createWorktree({ repoId: id, name: 'ar2', creationId: 'c2' })
    if (!b.ok) throw new Error(b.message)
    const blocked = await svc.removeWorktree(id, b.worktree.path)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.message).toMatch(/scripts\.archive/)
    expect(existsSync(b.worktree.path)).toBe(true)
    expect((await svc.removeWorktree(id, b.worktree.path, true)).ok).toBe(true)
    expect(existsSync(b.worktree.path)).toBe(false)
  })

  it('WS-24 부모 기록 — 같은 프로젝트의 지금 있는 작업 단위만, 부모 createdAt 을 같이. 부모 자리를 다시 쓰면 낡은 연결', async () => {
    const { svc, id } = await project()
    const p = await svc.createWorktree({ repoId: id, name: 'par', creationId: 'c1' })
    if (!p.ok) throw new Error(p.message)
    const c = await svc.createWorktree({ repoId: id, name: 'kid', creationId: 'c2', parentWorktreeId: p.worktree.id })
    if (!c.ok) throw new Error(c.message)
    expect(c.worktree).toMatchObject({ parentId: p.worktree.id, parentCreatedAt: p.worktree.createdAt })
    const bogus = await svc.createWorktree({ repoId: id, name: 'kid2', creationId: 'c3', parentWorktreeId: 'nope::x' })
    if (bogus.ok) expect(bogus.worktree.parentId).toBeUndefined()
    const list1 = await svc.listWorktrees(id)
    expect(list1.ok && lineageChildren(list1.worktrees).get(p.worktree.id)).toEqual([c.worktree.id])
    // 부모를 지우고 같은 이름으로 다시 — 같은 경로지만 다른 작업 단위(createdAt 이 다르다)
    await svc.removeWorktree(id, p.worktree.path, true)
    await new Promise((res) => setTimeout(res, 5))
    const again = await svc.createWorktree({ repoId: id, name: 'par', creationId: 'c4' })
    if (!again.ok) throw new Error(again.message)
    expect(again.worktree.path).toBe(p.worktree.path)
    const list2 = await svc.listWorktrees(id)
    expect(list2.ok && lineageChildren(list2.worktrees).get(again.worktree.id)).toBeUndefined()
  })

  it('WS-25 정리 git 상태 — 커밋 없음 = 병합됨, 커밋 있음 = 아님, 커밋 안 한 변경 수, 마지막 커밋 시각. 본 폴더는 빠짐', async () => {
    const { svc, id } = await project()
    const clean = await svc.createWorktree({ repoId: id, name: 'clean', creationId: 'c1' })
    const ahead = await svc.createWorktree({ repoId: id, name: 'ahead', creationId: 'c2' })
    if (!clean.ok || !ahead.ok) throw new Error('create')
    writeFileSync(join(ahead.worktree.path, 'n.txt'), 'n')
    await sh(['add', '.'], ahead.worktree.path)
    await sh(['commit', '-q', '-m', 'n'], ahead.worktree.path)
    writeFileSync(join(ahead.worktree.path, 'dirty.txt'), 'd')
    const info = await svc.cleanupScan(id)
    expect(info).toHaveLength(2)
    const by = Object.fromEntries(info.map((x) => [x.path, x]))
    expect(by[clean.worktree.path]).toMatchObject({ merged: true, dirty: 0 })
    expect(by[ahead.worktree.path]).toMatchObject({ merged: false, dirty: 1 })
    expect(by[ahead.worktree.path].lastCommitAt).toBeGreaterThan(Date.now() - 60_000)
  })

  it('WS-26 디스크 사용량 — 파일 크기 합, 링크(접합점)는 따라가지 않는다(양성 대조: 링크 너머의 큰 파일이 실제로 보임). 목록에 없는 경로는 안 잰다', async () => {
    const { svc, id } = await project()
    const r = await svc.createWorktree({ repoId: id, name: 'du', creationId: 'c1' })
    if (!r.ok) throw new Error(r.message)
    const big = join(dir, 'big')
    mkdirSync(big)
    writeFileSync(join(big, 'b.bin'), Buffer.alloc(200_000))
    symlinkSync(big, join(r.worktree.path, 'linked'), WIN ? 'junction' : 'dir')
    expect(existsSync(join(r.worktree.path, 'linked', 'b.bin'))).toBe(true)
    writeFileSync(join(r.worktree.path, 'own.bin'), Buffer.alloc(5000))
    const u = await scanDiskUsage(r.worktree.path)
    expect(u.ok).toBe(true)
    expect(u.bytes).toBeGreaterThanOrEqual(5000)
    expect(u.bytes).toBeLessThan(200_000)
    expect(u.top[0].name).toBe('own.bin')
    const capped = await scanDiskUsage(r.worktree.path, 2)
    expect(capped.truncated).toBe(true)
    expect(await svc.diskUsage(id, [join(dir, 'big')])).toEqual([])
    const via = await svc.diskUsage(id, [r.worktree.path])
    expect(via).toHaveLength(1)
    rmSync(join(r.worktree.path, 'linked'), { force: true })
  })
})
