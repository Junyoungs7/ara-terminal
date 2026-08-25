// #133 세션 분리 — **이 파일이 보안 경계다.** 이름이 폴더와 브랜치에 동시에 들어가고, 원격에서는
// 그대로 셸 한 줄이 된다. 하나라도 새면 `git worktree add` 가 임의 실행 통로가 된다.
import { describe, it, expect } from 'vitest'
import {
  branchFor,
  parseWorktreeOut,
  remoteWorktreeAdd,
  remoteWorktreeRemove,
  validWorktreeName,
  worktreePath
} from '../src/shared/gitWorktree'
import { COMMANDS } from '../src/shared/remoteCatalog'

describe('★ 이름 검증', () => {
  it('평범한 이름은 통과한다', () => {
    expect(validWorktreeName('refactor')).toBe('refactor')
    expect(validWorktreeName('  perf-2_a  ')).toBe('perf-2_a')
  })

  it('★ 셸 메타문자·공백·경로는 전부 거절한다 — 조립 자체를 안 한다', () => {
    for (const bad of [
      'a; rm -rf /',
      'a && whoami',
      'a`id`',
      'a$(id)',
      "a'b",
      'a b',
      '../escape',
      'a/b',
      'a\b',
      '-startsWithDash',
      '',
      '   ',
      '한글',
      'x'.repeat(41)
    ]) {
      expect(validWorktreeName(bad), bad).toBeNull()
    }
    expect(validWorktreeName(42)).toBeNull()
    expect(validWorktreeName(null)).toBeNull()
  })

  it('★ 카탈로그도 같은 문 앞에서 멈춘다 — 검증 실패면 명령이 만들어지지 않는다', () => {
    const add = COMMANDS['git.worktree.add']
    expect(add.write).toBe(true)
    expect(add.build({ path: '/srv/app', name: 'x; id' })).toBeNull()
    expect(add.build({ path: '/srv/app' })).toBeNull()
    expect(add.build(null)).toBeNull()
    expect(add.build({ path: '/srv/app', name: 'ok' })).toContain('git worktree add')
  })
})

describe('만들어지는 자리', () => {
  it('형제 폴더다 — 숨김 폴더에 감추지 않는다(손으로 열고 지울 수 있어야 한다)', () => {
    expect(worktreePath('/home/jun/work/vgt-erp', 'perf', '/')).toBe('/home/jun/work/vgt-erp-perf')
    expect(worktreePath(String.raw`D:\work\app`, 'x', '\\')).toBe(String.raw`D:\work\app-x`)
    // 끝의 구분자는 무시한다(cwd 가 슬래시로 끝나 오는 판이 있다).
    expect(worktreePath('/a/b/', 'c', '/')).toBe('/a/b-c')
  })

  it('브랜치는 ara/ 접두어 — 우리가 만든 것을 한눈에 가른다', () => {
    expect(branchFor('perf')).toBe('ara/perf')
  })
})

describe('원격 한 줄', () => {
  it('★ 저장소인지 **먼저 보고** 아니면 우리 말로 알린다 — 알 수 없는 실패로 두지 않는다', () => {
    const line = remoteWorktreeAdd('/srv/app', 'perf')!
    expect(line).toContain('rev-parse --is-inside-work-tree')
    expect(line).toContain('ARA-WT not-a-repo')
    expect(line).toContain('ARA-WT no-such-dir')
    expect(line).toContain("git worktree add -b 'ara/perf' '/srv/app-perf'")
  })

  it("작은따옴표가 든 경로도 깨지지 않는다", () => {
    const line = remoteWorktreeAdd("/srv/it's", 'x')!
    expect(line).toContain(String.raw`'/srv/it'\''s'`)
  })

  it('★ 지울 때 --force 를 쓰지 않는다 — 커밋 안 된 변경은 git 이 막게 둔다', () => {
    const line = remoteWorktreeRemove('/srv/app', '/srv/app-perf')!
    expect(line).toContain('git worktree remove')
    expect(line).not.toContain('--force')
    expect(line).not.toContain('-f ')
  })
})

describe('결과 읽기', () => {
  it('우리가 심은 표식만 믿는다 — git 문구는 판마다 바뀐다', () => {
    expect(parseWorktreeOut('Preparing worktree\nARA-WT ok /srv/app-perf')).toEqual({ ok: true, path: '/srv/app-perf' })
    expect(parseWorktreeOut('ARA-WT not-a-repo').ok).toBe(false)
    expect(parseWorktreeOut('ARA-WT not-a-repo')).toMatchObject({ reason: 'notRepo' })
    expect(parseWorktreeOut('ARA-WT no-such-dir')).toMatchObject({ reason: 'noDir' })
  })

  it("★ git 이 실패하면 그 말을 **그대로** 올린다 — 우리가 다시 쓰면 원인을 못 찾는다", () => {
    const out = "fatal: a branch named 'ara/perf' already exists"
    expect(parseWorktreeOut(out)).toEqual({ ok: false, reason: 'git', message: out })
  })
})
