// M7 R1 WS-10·11 — diff 파서·주석 프롬프트 조립·주석 보존 규칙 + 실제 git(임시 폴더 저장소만 — 사내 저장소에 닿지 않는다).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildDiffResult,
  isSafeRelPath,
  MAX_RENDERED_DIFF_LINES_PER_SIDE,
  parseNameStatusZ,
  parseStatusV2,
  pickDefaultBaseRef
} from '../src/shared/gitDiff'
import { formatDiffComment, formatDiffComments, markSent, normalizeDiffComment, parseStoredComments, type DiffComment } from '../src/shared/diffComments'
import { git } from '../src/main/worktrees/git'
import { readBranchCompare, readFileDiff, readGitStatus } from '../src/main/git/inspect'

describe('parseStatusV2', () => {
  it('머리·보통·이름 바꿈·충돌·추적 안 됨, 경로의 공백', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head ara/feat',
      '# branch.upstream origin/ara/feat',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? 새 파일.txt',
      '! ignored.log',
      ''
    ].join('\0')
    const r = parseStatusV2(out)
    expect(r).toMatchObject({ branch: 'ara/feat', head: 'abc123', upstream: 'origin/ara/feat', ahead: 2, behind: 1, truncated: false })
    expect(r.entries).toEqual([
      { path: 'src/a file.ts', status: 'modified', area: 'unstaged' },
      { path: 'both.ts', status: 'modified', area: 'staged' },
      { path: 'both.ts', status: 'modified', area: 'unstaged' },
      { path: 'new name.ts', oldPath: 'old name.ts', status: 'renamed', area: 'staged' },
      { path: 'conflict.ts', status: 'conflicted', area: 'unstaged' },
      { path: '새 파일.txt', status: 'untracked', area: 'untracked' }
    ])
  })
  it('분리된 HEAD·첫 커밋 전 = null, 상한에서 자르고 truncated', () => {
    const r = parseStatusV2(['# branch.oid (initial)', '# branch.head (detached)', '? a', '? b', '? c', ''].join('\0'), 2)
    expect(r).toMatchObject({ branch: null, head: null, truncated: true })
    expect(r.entries.map((e) => e.path)).toEqual(['a', 'b'])
  })
})

describe('parseNameStatusZ', () => {
  it('M·A·D·R(점수 + 옛/새)·C', () => {
    const out = ['M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts', 'C100', 'src.ts', 'copy.ts', ''].join('\0')
    expect(parseNameStatusZ(out).entries).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
      { path: 'c.ts', status: 'deleted' },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed' },
      { path: 'copy.ts', oldPath: 'src.ts', status: 'copied' }
    ])
  })
})

describe('기본 비교 기준(Orca 순서)', () => {
  it('origin/HEAD 가 가리키는 것이 먼저', () => {
    expect(pickDefaultBaseRef('refs/heads/main\0\nrefs/remotes/origin/HEAD\0refs/remotes/origin/develop\n')).toBe('origin/develop')
  })
  it('없으면 origin/main → origin/master → main → master', () => {
    expect(pickDefaultBaseRef('refs/heads/master\0\nrefs/heads/main\0\n')).toBe('main')
    expect(pickDefaultBaseRef('refs/heads/master\0\nrefs/remotes/origin/master\0\n')).toBe('origin/master')
    expect(pickDefaultBaseRef('')).toBeNull()
  })
})

describe('buildDiffResult · 경로 검사', () => {
  it('NUL 이 있으면 binary, 줄 상한을 넘으면 tooLarge(글을 안 싣는다)', () => {
    expect(buildDiffResult('a\0b', 'x')).toEqual({ ok: true, kind: 'binary' })
    expect(buildDiffResult('', '\n'.repeat(MAX_RENDERED_DIFF_LINES_PER_SIDE + 1))).toEqual({ ok: true, kind: 'tooLarge' })
    expect(buildDiffResult('a', 'b')).toEqual({ ok: true, kind: 'text', original: 'a', modified: 'b' })
  })
  it('상대 경로만 — .., 절대, 옵션 모양 거절', () => {
    expect(isSafeRelPath('src/a.ts')).toBe(true)
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '--output=x', '', 3]) expect(isSafeRelPath(bad)).toBe(false)
  })
})

const base: DiffComment = { id: '1', filePath: 'src/a.ts', lineNumber: 12, body: 'x', createdAt: 1 }

describe('주석 → 프롬프트(Orca formatDiffComment 계약)', () => {
  it('한 줄 · 범위 · 파일 전체, 따옴표·줄바꿈·역슬래시는 이스케이프', () => {
    expect(formatDiffComment({ ...base, body: '여기 "null" 확인\n두 번째 \\ 줄' })).toBe('File: src/a.ts\nLine: 12\nUser comment: "여기 \\"null\\" 확인\\n두 번째 \\\\ 줄"')
    expect(formatDiffComment({ ...base, startLine: 10 })).toContain('Lines: 10-12')
    expect(formatDiffComment({ ...base, lineNumber: 0 })).toContain('Scope: file')
    expect(formatDiffComments([base, { ...base, id: '2', filePath: 'b.ts' }])).toBe(`${formatDiffComment(base)}\n\n${formatDiffComment({ ...base, id: '2', filePath: 'b.ts' })}`)
  })
})

describe('주석 보존(재시작 뒤 다시 읽기)', () => {
  it('저장 → JSON → 다시 읽기가 같다', () => {
    const stored = { 'D:\\w\\a': [{ ...base, startLine: 10, sentAt: 5, scope: 'branch' as const }] }
    expect(parseStoredComments(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  })
  it('깨진 항목은 버리고 나머지는 살린다 · 틀린 startLine·sentAt 은 뗀다', () => {
    const got = parseStoredComments({ w: [base, { id: 1 }, null, { ...base, id: '3', startLine: 99, sentAt: -1 }], x: 'nope' })
    expect(got).toEqual({ w: [base, { ...base, id: '3' }] })
    expect(normalizeDiffComment({ ...base, lineNumber: 1.5 })).toBeNull()
    expect(parseStoredComments(null)).toEqual({})
  })
  it('보낸 것만 sentAt — 보내는 사이 고친 것은 안 보낸 채로', () => {
    const list = [base, { ...base, id: '2', body: 'edited' }]
    const out = markSent(list, [base, { ...base, id: '2', body: 'before' }], 9)
    expect(out[0].sentAt).toBe(9)
    expect(out[1].sentAt).toBeUndefined()
  })
})

// 실제 git — 전체 실행 부하에서 기본 5초를 넘길 때가 있다(M8 R3). 시험 제한 시간만 늘린다.
describe('실제 git — 변경 목록·분기 비교·파일 diff', { timeout: 30_000 }, () => {
  let repo: string
  const sh = async (...args: string[]): Promise<void> => {
    const r = await git(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], repo)
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'ara-gitdiff-'))
    await sh('init', '-q', '-b', 'main')
    await sh('config', 'core.autocrlf', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'old.txt'), 'rename me\nkeep\nlines\n')
    await sh('add', '.')
    await sh('commit', '-q', '-m', 'init')
    await sh('checkout', '-q', '-b', 'ara/feat')
    await sh('mv', 'old.txt', 'new.txt')
    writeFileSync(join(repo, 'b.txt'), 'branch\n')
    await sh('add', '.')
    await sh('commit', '-q', '-m', 'feat')
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(repo, 'b.txt'), 'branch\nstaged\n')
    await sh('add', 'b.txt')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 2]))
  }, 30_000)
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('status: 작업 중·스테이지·추적 안 됨', async () => {
    const r = await readGitStatus(repo)
    if (!r.ok) throw new Error(r.message)
    expect(r.branch).toBe('ara/feat')
    expect(r.entries).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', status: 'modified', area: 'unstaged' },
        { path: 'b.txt', status: 'modified', area: 'staged' },
        { path: 'bin.dat', status: 'untracked', area: 'untracked' }
      ])
    )
  })
  it('branchCompare: 기본 기준 main, 이름 바꿈 포함', async () => {
    const r = await readBranchCompare(repo)
    if (!r.ok) throw new Error(r.message)
    expect(r.baseRef).toBe('main')
    expect(r.entries).toEqual(expect.arrayContaining([{ path: 'b.txt', status: 'added' }, { path: 'new.txt', oldPath: 'old.txt', status: 'renamed' }]))
    expect(await readBranchCompare(repo, '--evil')).toMatchObject({ ok: false })
  })
  it('diff: unstaged = 인덱스↔디스크, staged = HEAD↔인덱스, branch = 갈림점↔HEAD, 바이너리·잘못된 경로', async () => {
    expect(await readFileDiff({ worktreePath: repo, filePath: 'a.txt', mode: 'unstaged' })).toEqual({ ok: true, kind: 'text', original: 'one\ntwo\n', modified: 'one\nTWO\n' })
    expect(await readFileDiff({ worktreePath: repo, filePath: 'b.txt', mode: 'staged' })).toEqual({ ok: true, kind: 'text', original: 'branch\n', modified: 'branch\nstaged\n' })
    const cmp = await readBranchCompare(repo)
    if (!cmp.ok) throw new Error(cmp.message)
    expect(await readFileDiff({ worktreePath: repo, filePath: 'new.txt', oldPath: 'old.txt', mode: 'branch', mergeBase: cmp.mergeBase })).toMatchObject({ kind: 'text', original: 'rename me\nkeep\nlines\n' })
    expect(await readFileDiff({ worktreePath: repo, filePath: 'bin.dat', mode: 'unstaged' })).toEqual({ ok: true, kind: 'binary' })
    expect(await readFileDiff({ worktreePath: repo, filePath: '../x', mode: 'unstaged' })).toMatchObject({ ok: false })
    expect(await readFileDiff({ worktreePath: repo, filePath: 'a.txt', mode: 'branch', mergeBase: 'HEAD;rm' })).toMatchObject({ ok: false })
  })
})
