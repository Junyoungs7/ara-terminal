// M7 R2 WS-12·13 소스 제어 — 순수 규칙(푸시 대상·보호 브랜치·amend 경고·기본 동작) + 실제 git(임시 폴더 저장소 + 로컬 bare 원격만.
// 사내 GitLab 에 닿지 않는다).
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { amendNeedsConfirm, isProtectedBranch, planPush, resolvePrimaryAction, scrubCredentials } from '@shared/scm'
import { amend, commit, discardPath, push, safeRelPaths, stagePaths, unstagePaths } from '../src/main/scm/git'
import { runProcess } from '../src/main/util/runProcess'

describe('보호 브랜치', () => {
  it('main·master 는 늘, 설정 목록은 이름·접두어/*', () => {
    expect(isProtectedBranch('main')).toBe(true)
    expect(isProtectedBranch('master')).toBe(true)
    expect(isProtectedBranch('feature/x')).toBe(false)
    expect(isProtectedBranch('release/1.0', ['release/*'])).toBe(true)
    expect(isProtectedBranch('releases', ['release/*'])).toBe(false)
    expect(isProtectedBranch('develop', ['develop'])).toBe(true)
    expect(isProtectedBranch('Main')).toBe(false)
  })
})

describe('푸시 대상 판정', () => {
  const base = { remotes: ['origin'], force: false }
  it('upstream 이 있으면 그 원격 브랜치(로컬 이름이 달라도 대상 이름으로 보호 판정)', () => {
    const p = planPush({ ...base, branch: 'mywork', upstreamName: 'origin/main' })
    expect(p).toEqual({ kind: 'push', remote: 'origin', branch: 'main', publish: false, force: false, need: ['protected'] })
  })
  it('upstream 없음 → origin 에 같은 이름으로 첫 게시', () => {
    expect(planPush({ ...base, branch: 'feature/a' })).toEqual({ kind: 'push', remote: 'origin', branch: 'feature/a', publish: true, force: false, need: [] })
    expect(planPush({ remotes: ['gl'], force: false, branch: 'x' })).toMatchObject({ remote: 'gl', publish: true })
  })
  it('원격 이름에 / 가 있어도 가장 긴 원격으로 가른다', () => {
    expect(planPush({ remotes: ['a', 'a/b'], force: false, branch: 'x', upstreamName: 'a/b/feat' })).toMatchObject({ remote: 'a/b', branch: 'feat' })
  })
  it('보호 브랜치는 확인 뒤에만, 보호 브랜치 강제 푸시는 막힘', () => {
    expect(planPush({ ...base, branch: 'main', confirmed: ['protected'] })).toMatchObject({ kind: 'push', need: [] })
    expect(planPush({ ...base, branch: 'main', force: true, confirmed: ['protected', 'force'] })).toEqual({ kind: 'blocked', reason: 'forceProtected' })
  })
  it('강제 푸시는 따로 확인', () => {
    expect(planPush({ ...base, branch: 'feat', force: true })).toMatchObject({ need: ['force'] })
    expect(planPush({ ...base, branch: 'feat', force: true, confirmed: ['force'] })).toMatchObject({ need: [], force: true })
  })
  it('HEAD 분리·원격 없음·위험한 이름은 막힘', () => {
    expect(planPush({ ...base, branch: null })).toEqual({ kind: 'blocked', reason: 'detached' })
    expect(planPush({ remotes: [], force: false, branch: 'x' })).toEqual({ kind: 'blocked', reason: 'noRemote' })
    expect(planPush({ remotes: ['-x'], force: false, branch: 'x' })).toEqual({ kind: 'blocked', reason: 'badTarget' })
    expect(planPush({ ...base, branch: '--upload-pack=x' })).toEqual({ kind: 'blocked', reason: 'badTarget' })
  })
})

describe('amend 경고·기본 동작·자격 증명 가리기', () => {
  it('이미 푸시된 커밋만, 확인 전엔 막는다', () => {
    expect(amendNeedsConfirm(true, false)).toBe(true)
    expect(amendNeedsConfirm(true, true)).toBe(false)
    expect(amendNeedsConfirm(false, false)).toBe(false)
  })
  const p = (o: Partial<Parameters<typeof resolvePrimaryAction>[0]>) =>
    resolvePrimaryAction({ stagedCount: 0, hasUnstaged: false, hasMessage: false, hasConflicts: false, busy: false, hasBranch: true, upstream: { hasUpstream: true, ahead: 0, behind: 0 }, ...o })
  it('Orca 순서: 진행 중 → 충돌 → 커밋 → 스테이지 → 게시 → 동기화 → 풀 → 푸시', () => {
    expect(p({ busy: true, stagedCount: 1, hasMessage: true })).toMatchObject({ kind: 'commit', disabled: true })
    expect(p({ hasConflicts: true, stagedCount: 1, hasMessage: true })).toMatchObject({ kind: 'commit', disabled: true, titleKey: 'scm.title.conflicts' })
    expect(p({ stagedCount: 1, hasMessage: true })).toMatchObject({ kind: 'commit', disabled: false })
    expect(p({ stagedCount: 1 })).toMatchObject({ kind: 'commit', disabled: true, titleKey: 'scm.title.needMessage' })
    expect(p({ hasUnstaged: true })).toMatchObject({ kind: 'stage', disabled: false })
    expect(p({ upstream: { hasUpstream: false, ahead: 0, behind: 0 } })).toMatchObject({ kind: 'publish', disabled: false })
    expect(p({ hasBranch: false, upstream: { hasUpstream: false, ahead: 0, behind: 0 } })).toMatchObject({ kind: 'publish', disabled: true })
    expect(p({ upstream: { hasUpstream: true, ahead: 2, behind: 1 } })).toMatchObject({ kind: 'sync', count: 3 })
    expect(p({ upstream: { hasUpstream: true, ahead: 0, behind: 4 } })).toMatchObject({ kind: 'pull', count: 4 })
    expect(p({ upstream: { hasUpstream: true, ahead: 2, behind: 0 } })).toMatchObject({ kind: 'push', count: 2 })
    expect(p({})).toMatchObject({ kind: 'commit', disabled: true, titleKey: 'scm.title.upToDate' })
    expect(p({ upstream: null })).toMatchObject({ disabled: true })
  })
  it('git 의 말은 그대로, URL 의 자격 증명만 가린다', () => {
    expect(scrubCredentials("fatal: Authentication failed for 'https://kim:glpat-abc@gitlab.example/x.git/'")).toBe(
      "fatal: Authentication failed for 'https://***@gitlab.example/x.git/'"
    )
    expect(scrubCredentials('remote: rejected')).toBe('remote: rejected')
  })
  it('경로는 워크트리 기준만', () => {
    expect(safeRelPaths(['a.txt', 'dir/b.txt'])).toEqual(['a.txt', 'dir/b.txt'])
    for (const bad of [['../x'], ['/etc/passwd'], ['C:\\x'], ['-f'], [], 'a', [1]]) expect(safeRelPaths(bad)).toBeNull()
  })
})

// ── 실제 git(임시 폴더 + 로컬 bare 원격) ──
let dir: string
let repo: string
let bare: string
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
async function sh(args: string[], cwd = repo): Promise<string> {
  const r = await runProcess('git', args, { cwd, env: ID })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const remoteHead = (branch: string): Promise<string> => sh(['rev-parse', `refs/heads/${branch}`], bare)

beforeEach(async () => {
  // 커밋은 main/scm/git 이 띄우는 git 이 한다 — 이름·메일은 env 로(전역 설정에 기대지 않는다).
  Object.assign(process.env, ID)
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ara-scm-')))
  repo = join(dir, 'repo')
  bare = join(dir, 'remote.git')
  await sh(['init', '-q', '--bare', '-b', 'main', bare], dir)
  await sh(['init', '-q', '-b', 'main', repo], dir)
  await sh(['config', 'core.autocrlf', 'false']) // 전역 autocrlf 가 켜진 PC 에서도 글이 바이트 그대로
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  await sh(['add', '.'])
  await sh(['commit', '-q', '-m', 'init'])
  await sh(['remote', 'add', 'origin', bare])
  await sh(['push', '-q', '-u', 'origin', 'main'])
}, 30_000) // git 7번(push 포함) — 전체 실행 부하에서 훅 기본 10초를 넘길 때가 있다. 시험 제한 시간만 늘린다.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Windows 에서 git 을 수십 번 띄운다 — 기본 5초로는 모자라다.
describe('실제 git — stage·커밋·푸시·보호 브랜치·amend', { timeout: 60_000 }, () => {
  it('변경 → stage → 커밋 → 새 브랜치 첫 게시(upstream 설정) → 다시 푸시', async () => {
    await sh(['switch', '-q', '-c', 'feature/x'])
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    expect(await stagePaths(repo, ['b.txt'])).toMatchObject({ ok: true })
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('b.txt')
    expect(await commit(repo, 'add b')).toMatchObject({ ok: true })
    expect(await push(repo, false, [])).toMatchObject({ ok: true, message: 'origin/feature/x' })
    expect(await remoteHead('feature/x')).toBe(await sh(['rev-parse', 'HEAD']))
    expect(await sh(['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/feature/x')
    writeFileSync(join(repo, 'b.txt'), 'b2\n')
    await stagePaths(repo, ['b.txt'])
    await commit(repo, 'b2')
    expect(await push(repo, false, [])).toMatchObject({ ok: true })
    expect(await remoteHead('feature/x')).toBe(await sh(['rev-parse', 'HEAD']))
  })

  it('보호 브랜치(main) 푸시는 확인 전엔 막히고 원격이 그대로다', async () => {
    const before = await remoteHead('main')
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    await stagePaths(repo, ['a.txt'])
    await commit(repo, 'on main')
    expect(await push(repo, false, [])).toEqual({ ok: false, message: 'confirm', need: ['protected'], target: 'origin/main' })
    expect(await remoteHead('main')).toBe(before)
    expect(await push(repo, true, ['protected', 'force'])).toEqual({ ok: false, message: 'forceProtected' })
    expect(await remoteHead('main')).toBe(before)
    expect(await push(repo, false, ['protected'])).toMatchObject({ ok: true })
    expect(await remoteHead('main')).toBe(await sh(['rev-parse', 'HEAD']))
  })

  it('설정 목록(ara.protectedBranch)의 접두어도 막는다', async () => {
    await sh(['config', '--add', 'ara.protectedBranch', 'release/*'])
    await sh(['switch', '-q', '-c', 'release/1'])
    expect(await push(repo, false, [])).toMatchObject({ ok: false, need: ['protected'], target: 'origin/release/1' })
  })

  it('amend — 푸시 안 된 커밋은 바로, 푸시된 커밋은 확인 뒤에만', async () => {
    await sh(['switch', '-q', '-c', 'feat'])
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    await stagePaths(repo, ['c.txt'])
    await commit(repo, 'c')
    expect(await amend(repo, 'c fixed', false)).toMatchObject({ ok: true })
    expect(await sh(['log', '-1', '--format=%s'])).toBe('c fixed')
    await push(repo, false, [])
    const pushed = await sh(['rev-parse', 'HEAD'])
    expect(await amend(repo, 'again', false)).toEqual({ ok: false, message: 'pushed', need: ['pushed'] })
    expect(await sh(['rev-parse', 'HEAD'])).toBe(pushed)
    expect(await amend(repo, '', true)).toMatchObject({ ok: true })
    expect(await sh(['log', '-1', '--format=%s'])).toBe('c fixed')
    expect(await sh(['rev-parse', 'HEAD'])).not.toBe(pushed)
    // 갈라진 뒤 일반 푸시는 git 이 거절하고 그 말을 돌려준다 · 강제 푸시는 확인 뒤에만.
    const plain = await push(repo, false, [])
    expect(plain.ok).toBe(false)
    expect(plain.ok ? '' : plain.message).toMatch(/rejected|non-fast-forward|fetch first/i)
    expect(await push(repo, true, [])).toMatchObject({ ok: false, need: ['force'] })
    expect(await push(repo, true, ['force'])).toMatchObject({ ok: true })
    expect(await remoteHead('feat')).toBe(await sh(['rev-parse', 'HEAD']))
  })

  it('unstage · 버리기(추적 중 = 되돌림, 안 추적 = 지움) · 이름에 * 가 있어도 그 파일만', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    await stagePaths(repo, ['a.txt'])
    expect(await unstagePaths(repo, ['a.txt'])).toMatchObject({ ok: true })
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('')
    expect(await discardPath(repo, 'a.txt')).toMatchObject({ ok: true })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    writeFileSync(join(repo, 'new.txt'), 'n')
    expect(await discardPath(repo, 'new.txt')).toMatchObject({ ok: true })
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    if (process.platform !== 'win32') {
      writeFileSync(join(repo, 'x*.txt'), '1')
      writeFileSync(join(repo, 'xy.txt'), '2')
      await stagePaths(repo, ['x*.txt'])
      expect(await sh(['diff', '--cached', '--name-only'])).toBe('x*.txt')
    }
  })

  it('빈 메시지 커밋은 거절', async () => {
    expect(await commit(repo, '  ')).toEqual({ ok: false, message: 'emptyMessage' })
  })
})
