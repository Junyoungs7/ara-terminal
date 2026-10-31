// M2 작업 단위 — 순수 규칙. Orca 시험을 옮겼다(orcaRef 7a7f46f8a3):
// src/main/git/worktree-porcelain-parsing.test.ts · src/main/ipc/worktree-logic.test.ts ·
// src/main/ipc/created-worktree-reconciliation.test.ts · src/main/git/worktree-include-file.test.ts(파서 부분).
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  branchNameFor,
  createWorktreeCheckoutProgressReader,
  findCreatedWorktree,
  isSafeIncludePath,
  isUnsupportedIncludePattern,
  parseBaseRefs,
  parseWorktreeIncludeFile,
  parseWorktreeList,
  reconcilePendingCreation,
  resolveWorktreeAddBaseRef,
  sanitizeWorktreeName,
  worktreeCreateCandidate,
  type PendingCreation,
  type WorktreeCheckoutProgress
} from '@shared/worktrees'
import { computeWorkspaceRoot, computeWorktreePath, ensurePathWithinWorkspace, getDefaultWorkspaceDir } from '../src/main/worktrees/paths'

describe('parseWorktreeList (Orca worktree-porcelain-parsing.test)', () => {
  it('preserves a locked marker and its reason', () => {
    expect(
      parseWorktreeList('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked active agent session\n')[1]
    ).toMatchObject({ path: '/locked', locked: true, lockReason: 'active agent session' })
  })

  it('decodes C-quoted lock reasons from legacy line porcelain output', () => {
    const output = 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked "first line\\nsecond line \\303\\251"\n'
    expect(parseWorktreeList(output)[1]).toMatchObject({ locked: true, lockReason: 'first line\nsecond line é' })
  })

  it('keeps NUL-delimited lock reasons raw', () => {
    const output = ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /locked', 'HEAD def', 'branch refs/heads/feature', 'locked "literal\\nquote"', ''].join('\0')
    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({ locked: true, lockReason: '"literal\\nquote"' })
  })

  it('preserves a prunable marker and its reason', () => {
    expect(
      parseWorktreeList('worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /stale\nHEAD def\nbranch refs/heads/feature\nprunable gitdir file points to non-existent location\n')[1]
    ).toMatchObject({ path: '/stale', prunable: true, prunableReason: 'gitdir file points to non-existent location' })
  })

  it('parses regular and bare worktree blocks from porcelain output', () => {
    const output = `
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-bare
HEAD 0000000
bare
`
    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo', head: 'abc123', branch: 'refs/heads/main', isBare: false, isMainWorktree: true },
      { path: '/repo-feature', head: 'def456', branch: 'refs/heads/feature/test', isBare: false, isMainWorktree: false },
      { path: '/repo-bare', head: '0000000', branch: '', isBare: true, isMainWorktree: false }
    ])
  })

  it('returns empty array for empty or whitespace-only input', () => {
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList('   \n\n  \n  ')).toEqual([])
  })

  it('parses a detached HEAD worktree (no branch line)', () => {
    expect(parseWorktreeList('worktree /repo-detached\nHEAD abc123\ndetached\n')).toEqual([
      { path: '/repo-detached', head: 'abc123', branch: '', isBare: false, isMainWorktree: true }
    ])
  })

  it('correctly captures worktree path with spaces', () => {
    expect(parseWorktreeList('worktree /path/to/my worktree\nHEAD ccc333\nbranch refs/heads/main\n')[0].path).toBe('/path/to/my worktree')
  })

  it('parses NUL-delimited porcelain output with newline paths', () => {
    const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '', 'worktree /repo/linked\nworktree', 'HEAD def456', 'branch refs/heads/feature/newline', ''].join('\0')
    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toEqual({
      path: '/repo/linked\nworktree',
      head: 'def456',
      branch: 'refs/heads/feature/newline',
      isBare: false,
      isMainWorktree: false
    })
  })

  it('parses Windows CRLF output', () => {
    expect(parseWorktreeList('worktree C:/r\r\nHEAD a\r\nbranch refs/heads/main\r\n\r\nworktree C:/r-b\r\nHEAD b\r\nbranch refs/heads/b\r\n').map((w) => w.path)).toEqual(['C:/r', 'C:/r-b'])
  })
})

describe('sanitizeWorktreeName (Orca worktree-logic.test)', () => {
  it.each([
    ['my feature', 'my-feature'],
    ['my   big   feature', 'my-big-feature'],
    ['  padded name  ', 'padded-name'],
    ['no-spaces', 'no-spaces'],
    ['feat@#$ure', 'feat-ure'],
    ['a---b', 'a-b'],
    ['.hidden-', 'hidden'],
    ['for-..-..-feature', 'for-.-.-feature'],
    ['a..b...c', 'a.b.c'],
    ['mise.lock', 'mise.lock'],
    ['中文', '中文'],
    ['日本語 テスト', '日本語-テスト'],
    ['한글 작업', '한글-작업'],
    ['feat: 中文 (v2)', 'feat-中文-v2']
  ])('%s → %s', (input, out) => {
    expect(sanitizeWorktreeName(input)).toBe(out)
  })

  it('uses a git-safe fallback for emoji-only names (shortcode catalog not ported)', () => {
    expect(sanitizeWorktreeName('\u{1faeb}')).toBe('workspace')
  })

  it.each(['!!!', '', '   ', '../..'])('throws for %j', (input) => {
    expect(() => sanitizeWorktreeName(input)).toThrow('Invalid worktree name')
  })
})

describe('branchNameFor (Orca computeValidatedBranchName, 접두어 없음)', () => {
  it('rewrites a trailing .lock so git check-ref-format accepts the branch', () => {
    expect(branchNameFor(sanitizeWorktreeName('adopt mise.lock'))).toBe('adopt-mise-lock')
    expect(branchNameFor(sanitizeWorktreeName('mise.lock!'))).toBe('mise-lock')
    expect(branchNameFor('mise-.lock')).toBe('mise-lock')
    expect(branchNameFor('mise.lock.json')).toBe('mise.lock.json')
    expect(branchNameFor('mise.LOCK')).toBe('mise.LOCK')
  })

  it('suffixes candidates like Orca getWorktreeCreateCandidate', () => {
    expect(worktreeCreateCandidate('feat', 1)).toBe('feat')
    expect(worktreeCreateCandidate('feat', 3)).toBe('feat-3')
  })
})

describe('worktree location rule (Orca computeWorktreePath)', () => {
  it('nests under repo name when nestWorkspaces is true', () => {
    expect(computeWorktreePath('feature', '/repos/my-project', { nestWorkspaces: true, workspaceDir: '/workspaces' })).toBe(
      posix.join('/workspaces', 'my-project', 'feature')
    )
  })

  it('uses flat layout when nestWorkspaces is false', () => {
    expect(computeWorktreePath('feature', '/repos/my-project', { nestWorkspaces: false, workspaceDir: '/workspaces' })).toBe('/workspaces/feature')
  })

  it('strips .git suffix from repo path when nesting', () => {
    expect(computeWorktreePath('feature', '/repos/my-project.git', { nestWorkspaces: true, workspaceDir: '/workspaces' })).toBe('/workspaces/my-project/feature')
  })

  it('resolves relative workspace directories from the repo path', () => {
    expect(computeWorkspaceRoot('/projects/app/repo', '../worktrees')).toBe('/projects/app/worktrees')
    expect(computeWorktreePath('feature', '/projects/app/repo', { nestWorkspaces: false, workspaceDir: '../worktrees' })).toBe('/projects/app/worktrees/feature')
  })

  it('resolves Windows-style relative workspace directories with Windows separators', () => {
    expect(computeWorktreePath('feature', 'C:\\Projects\\app\\repo', { nestWorkspaces: false, workspaceDir: '..\\worktrees' })).toBe(
      'C:\\Projects\\app\\worktrees\\feature'
    )
  })

  it('default root is <home>/ara/workspaces (Orca: <home>/orca/workspaces)', () => {
    expect(getDefaultWorkspaceDir('C:\\Users\\me\\')).toBe('C:\\Users\\me\\ara\\workspaces')
    expect(getDefaultWorkspaceDir('/home/me')).toBe('/home/me/ara/workspaces')
  })

  it('ensurePathWithinWorkspace', () => {
    expect(ensurePathWithinWorkspace('/workspace/feature', '/workspace')).toBe('/workspace/feature')
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow('Invalid worktree path')
    expect(ensurePathWithinWorkspace('/workspace/..repo/feature', '/workspace')).toBe('/workspace/..repo/feature')
    expect(() => ensurePathWithinWorkspace('C:\\ws\\..\\x', 'C:\\ws')).toThrow('Invalid worktree path')
  })
})

describe('findCreatedWorktree (Orca created-worktree-reconciliation.test)', () => {
  it('prefers the direct path match', () => {
    const direct = { path: '/home/user/worktrees/feature', branch: 'refs/heads/other' }
    const branch = { path: '/var/home/user/worktrees/feature', branch: 'refs/heads/feature' }
    expect(findCreatedWorktree([direct, branch], '/home/user/worktrees/feature', 'feature', 'linux')).toBe(direct)
  })

  it('matches the exact Git-listed branch when the requested path is an alias', () => {
    const created = { path: '/var/home/user/worktrees/feature', branch: 'refs/heads/user/feature' }
    expect(findCreatedWorktree([{ path: '/stale/worktree', branch: 'refs/heads/stale' }, created], '/home/user/worktrees/feature', 'user/feature', 'linux')).toBe(created)
  })

  it('does not accept a branch suffix collision', () => {
    expect(findCreatedWorktree([{ path: '/worktrees/prefix-feature', branch: 'refs/heads/prefix/feature' }], '/different/worktrees/feature', 'feature', 'linux')).toBeUndefined()
  })

  it('keeps Windows drive, slash, and case normalization on the direct path', () => {
    const created = { path: String.raw`C:\Users\Orca\feature`, branch: 'refs/heads/other' }
    expect(findCreatedWorktree([created], 'c:/users/orca/feature', 'feature', 'win32')).toBe(created)
  })

  it('keeps relative POSIX paths on the direct path', () => {
    const created = { path: 'worktrees/feature', branch: 'refs/heads/other' }
    expect(findCreatedWorktree([created], './worktrees/feature', 'feature', 'linux')).toBe(created)
  })
})

describe('reconcilePendingCreation (재시작 정리)', () => {
  const p: PendingCreation = { creationId: 'c', repoId: 'r', repoPath: '/repo', path: '/ws/repo/feat', branch: 'feat', startedAt: 0, pathWasFree: true }
  const main = { path: '/repo', head: 'a', branch: 'refs/heads/main', isBare: false, isMainWorktree: true }

  it('keeps a worktree git finished registering', () => {
    expect(reconcilePendingCreation(p, [main, { ...main, path: '/ws/repo/feat', branch: 'refs/heads/feat', isMainWorktree: false }], true, 'linux')).toBe('keep')
  })

  it('removes a half-made folder git never registered', () => {
    expect(reconcilePendingCreation(p, [main], true, 'linux')).toBe('removeLeftover')
  })

  it('never removes a folder that was not free before creation', () => {
    expect(reconcilePendingCreation({ ...p, pathWasFree: false }, [main], true, 'linux')).toBe('forget')
  })

  it('forgets when nothing is left or the listing cannot be read', () => {
    expect(reconcilePendingCreation(p, [main], false, 'linux')).toBe('forget')
    expect(reconcilePendingCreation(p, null, true, 'linux')).toBe('forget')
  })
})

describe('checkout progress (Orca git-progress-records · worktree-checkout-progress)', () => {
  it('reads Updating files records across chunks and reports done as null', () => {
    const seen: (WorktreeCheckoutProgress | null)[] = []
    const r = createWorktreeCheckoutProgressReader((p) => seen.push(p))
    r.read('Preparing worktree (new branch \'x\')\nUpdating files:  45% (9/2')
    r.read('0)\rUpdating files:  45% (9/20)\rUpdating files: 100% (20/20)\rUpdating files: 100% (20/20), done.\n')
    expect(seen).toEqual([{ percent: 45, completed: 9, total: 20 }, { percent: 100, completed: 20, total: 20 }, null])
  })

  it('stops after close', () => {
    const seen: unknown[] = []
    const r = createWorktreeCheckoutProgressReader((p) => seen.push(p))
    r.close()
    r.read('Updating files:  10% (1/10)\n')
    expect(seen).toEqual([])
  })
})

describe('.worktreeinclude parser (Orca worktree-include-file.test)', () => {
  it('skips blank lines and comments, dedupes, strips ./ and trailing slash', () => {
    expect(parseWorktreeIncludeFile('# secrets\n\n.env\n  \n# more\n./config/secrets.json\n.vscode/\n.env\n')).toEqual(['.env', 'config/secrets.json', '.vscode'])
  })

  it('normalizes backslashes to forward slashes', () => {
    expect(parseWorktreeIncludeFile('apps\\web\\.env\n')).toEqual(['apps/web/.env'])
  })

  it('rejects globs, negation, traversal, absolute and .git entries', () => {
    expect(['.env.*', '!.env.production', 'a?'].map(isUnsupportedIncludePattern)).toEqual([true, true, true])
    expect(['../outside', '/etc/passwd', 'C:/x', '.git/config', '.env'].map(isSafeIncludePath)).toEqual([false, false, false, false, true])
  })
})

describe('base refs (WS-04)', () => {
  const out = [
    'refs/heads/main\0main',
    'refs/remotes/origin/HEAD\0origin',
    'refs/remotes/origin/main\0origin/main',
    'refs/remotes/origin/feat/x\0origin/feat/x',
    'refs/tags/v1.0\0v1.0',
    'refs/heads/feat/x\0feat/x',
    'refs/stash\0stash'
  ].join('\n')

  it('lists local, remote and tags; drops remote HEAD and other refs', () => {
    expect(parseBaseRefs(out)).toEqual([
      { refName: 'main', kind: 'local' },
      { refName: 'origin/main', kind: 'remote' },
      { refName: 'origin/feat/x', kind: 'remote' },
      { refName: 'v1.0', kind: 'tag' },
      { refName: 'feat/x', kind: 'local' }
    ])
  })

  it('filters by query and limit', () => {
    expect(parseBaseRefs(out, 'FEAT').map((r) => r.refName)).toEqual(['origin/feat/x', 'feat/x'])
    expect(parseBaseRefs(out, '', 2)).toHaveLength(2)
  })

  it('qualifies picked names so tags cannot shadow branches (Orca base-ref.test)', async () => {
    const has = (refs: string[]) => async (r: string) => refs.includes(r)
    expect(await resolveWorktreeAddBaseRef('main', has(['refs/heads/main']))).toBe('refs/heads/main')
    expect(await resolveWorktreeAddBaseRef('origin/main', has(['refs/remotes/origin/main', 'refs/heads/origin/main']))).toBe('refs/remotes/origin/main')
    expect(await resolveWorktreeAddBaseRef('v1.0', has([]))).toBe('v1.0')
    expect(await resolveWorktreeAddBaseRef('refs/tags/v1.0', has([]))).toBe('refs/tags/v1.0')
  })
})

describe('parseShortstat', () => {
  it('더한·뺀 줄 — 한쪽만 있거나 빈 출력', async () => {
    const { parseShortstat } = await import('@shared/worktrees')
    expect(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({ added: 10, removed: 2 })
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ added: 1, removed: 0 })
    expect(parseShortstat(' 1 file changed, 4 deletions(-)')).toEqual({ added: 0, removed: 4 })
    expect(parseShortstat('')).toEqual({ added: 0, removed: 0 })
  })
})
