// M12 R3 — AI 작성 줄(RV-03 · Orca 문서의 판정: 에이전트 도구로 쓴 줄, 사람이 고치면 사람 것) · [AI 로 쓰기](RV-02 · Orca text-generation).
// 진짜 claude/codex 는 띄우지 않는다 — git 만 진짜(임시 저장소), 에이전트 실행은 가짜 Exec 가 받는다.
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} }, app: { getPath: () => '' } }))
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedLinesOfPatch, aiWriteOf, applyWrite, carryMask, linesOfSnippets, rangesOf, splitLines } from '../src/shared/aiLines'
import { createAiLines } from '../src/main/code/aiLines'
import {
  CLAUDE_ENTERPRISE_REFUSAL,
  STAGED_DIFF_BYTE_BUDGET,
  buildCommitMessagePrompt,
  cleanGeneratedText,
  commitMessageOf,
  parseMrFields,
  sanitizeBranchSlug,
  scmAiAgentOf,
  scmAiArgs,
  truncateDiffForPrompt
} from '../src/shared/scmAi'
import { generateScmText, renameBranch } from '../src/main/scm/ai'
import { runProcess, type RunOptions, type RunResult } from '../src/main/util/runProcess'
import { agentSettingsOf } from '../src/shared/agents'

describe('AI 작성 줄 — 훅 본문에서 쓴 줄 뽑기', () => {
  it('Claude Edit 의 structuredPatch → 새 글 기준 + 줄 번호', () => {
    const patch = [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' a', '-b', '+B', '+B2', ' c'] }]
    expect(addedLinesOfPatch(patch)).toEqual([4, 5])
    const w = aiWriteOf({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/x.ts', old_string: 'b', new_string: 'B\nB2' }, tool_response: { structuredPatch: patch } })
    expect(w).toEqual({ path: '/r/x.ts', written: { kind: 'lines', lines: [4, 5] } })
  })
  it('새 파일 Write(패치 빈 배열)는 통째 · MultiEdit 는 조각들 · Gemini replace/write_file', () => {
    expect(aiWriteOf({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/r/n.ts', content: 'x' }, tool_response: { type: 'create', structuredPatch: [] } })?.written).toEqual({ kind: 'all' })
    expect(aiWriteOf({ hook_event_name: 'PostToolUse', tool_name: 'MultiEdit', tool_input: { file_path: '/r/m.ts', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] } })?.written).toEqual({ kind: 'snippets', snippets: ['A', 'B'] })
    expect(aiWriteOf({ hook_event_name: 'AfterTool', tool_name: 'replace', tool_input: { file_path: '/r/g.ts', old_string: 'a', new_string: 'A' } })?.written).toEqual({ kind: 'snippets', snippets: ['A'] })
    expect(aiWriteOf({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: '/r/g.ts', content: 'x' } })?.written).toEqual({ kind: 'all' })
  })
  it('쓰기 도구가 아니거나 시작(PreToolUse)이면 null', () => {
    expect(aiWriteOf({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/x', new_string: 'a' } })).toBeNull()
    expect(aiWriteOf({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/r/x' } })).toBeNull()
    expect(aiWriteOf({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} })).toBeNull()
  })
  it('조각 위치 → 줄(여러 줄 조각, 끝 줄바꿈)', () => {
    expect(linesOfSnippets('a\nb\nc\nd', ['b\nc'])).toEqual([2, 3])
    expect(linesOfSnippets('a\nb\nc\n', ['c\n'])).toEqual([3])
    expect(linesOfSnippets('a', ['zzz'])).toEqual([])
  })
})

describe('AI 작성 줄 — 표시 옮기기(사람이 고치면 사람 것)', () => {
  const mask = (text: string, ai: number[]) => ({ lines: splitLines(text), mask: splitLines(text).map((_, i) => ai.includes(i + 1)) })
  it('위에 줄을 끼우면 표시가 같이 내려간다', () => {
    const m = mask('a\nAI1\nAI2\nb', [2, 3])
    expect(rangesOf(carryMask(m, splitLines('new\na\nAI1\nAI2\nb')))).toEqual([[3, 4]])
  })
  it('AI 줄을 사람이 고치면 그 줄만 사람 것', () => {
    const m = mask('a\nAI1\nAI2\nAI3\nb', [2, 3, 4])
    expect(rangesOf(carryMask(m, splitLines('a\nAI1\nmine\nAI3\nb')))).toEqual([
      [2, 2],
      [4, 4]
    ])
  })
  it('에이전트가 다시 쓰면 그 사이 사람이 고친 줄은 사람 것, 방금 쓴 줄은 AI', () => {
    const prev = mask('a\nAI\nb', [2])
    // 사람이 b → human 으로 고친 뒤 에이전트가 끝에 줄을 붙였다
    const next = applyWrite(prev, 'a\nAI\nhuman\nAI-new', { kind: 'lines', lines: [4] })
    expect(rangesOf(next.mask)).toEqual([
      [2, 2],
      [4, 4]
    ])
  })
  it('통째 Write — 끝 줄바꿈 뒤 빈 칸은 AI 줄이 아니다(e2e R3-3: 3줄 쓰면 표시 3)', () => {
    expect(rangesOf(applyWrite(null, 'ai one\nai two\nai three\n', { kind: 'all' }).mask)).toEqual([[1, 3]])
    expect(rangesOf(applyWrite(null, 'a\n\nb', { kind: 'all' }).mask)).toEqual([[1, 3]]) // 가운데 빈 줄은 쓴 줄
  })
  it('원장 — 훅 → 파일 읽기 → 보이는 글 기준 범위, 큰 파일도 빠르게', async () => {
    const files = new Map<string, string>([['/w/a.ts', 'one\ntwo\nthree']])
    const l = createAiLines(async (p) => files.get(p) ?? null)
    const p = process.platform === 'win32' ? 'C:\\w\\a.ts' : '/w/a.ts'
    files.set(p, 'one\ntwo\nthree')
    expect(await l.ingest({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: p, new_string: 'two' } })).toBeTruthy()
    expect(l.ranges(p, 'one\ntwo\nthree')).toEqual([[2, 2]])
    expect(l.ranges(p, 'zero\none\ntwo!\nthree')).toEqual([]) // 사람이 고친 줄
    expect(l.ranges('/other', 'two')).toEqual([])
    // 10만 줄 파일 — 줄 맞추기는 O(n)(메인 프로세스를 오래 안 잡는다)
    const big = Array.from({ length: 100_000 }, (_, i) => `line ${i}`)
    files.set(p, big.join('\n'))
    await l.ingest({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: p }, tool_response: { structuredPatch: [] } })
    const edited = ['head', ...big.slice(0, 50_000), 'mine', ...big.slice(50_001)].join('\n')
    const t0 = performance.now()
    const r = l.ranges(p, edited)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(r).toEqual([
      [2, 50_001],
      [50_003, 100_001]
    ])
  })
})

describe('[AI 로 쓰기] — Orca 프롬프트·출력 정리(Orca 시험 옮김)', () => {
  it('truncateDiffForPrompt — 예산 안이면 그대로, 넘으면 표시, 줄 경계, 작은 파일을 굶기지 않는다', () => {
    const diff = 'line\n'.repeat(10)
    expect(truncateDiffForPrompt(diff)).toBe(diff)
    const over = 'line\n'.repeat(STAGED_DIFF_BYTE_BUDGET / 5 + 100)
    expect(truncateDiffForPrompt(over)).toMatch(/diff truncated, \d+ bytes omitted/)
    const body = truncateDiffForPrompt('keep this line\n'.repeat(40), 95).split('\n...(diff truncated')[0]
    for (const l of body.split('\n').filter(Boolean)) expect(l).toBe('keep this line')
    const files = Array.from({ length: 20 }, (_, i) => `diff --git a/file-${i}.txt b/file-${i}.txt\n${'+x\n'.repeat(200)}`).join('')
    expect(truncateDiffForPrompt(files, 120).length).toBeLessThanOrEqual(120)
    const r = truncateDiffForPrompt(`diff --git a/data.jsonl b/data.jsonl\n${'+x\n'.repeat(5000)}diff --git a/src/app.ts b/src/app.ts\n+const meaningful = true\n`, 1_000)
    expect(r).toContain('const meaningful = true')
  })
  it('cleanGeneratedText — 울타리·진행 줄·생각 블록·목록 기호·CRLF', () => {
    expect(cleanGeneratedText('  feat: hello  \n')).toBe('feat: hello')
    expect(cleanGeneratedText('```text\nfix: bug\n```')).toBe('fix: bug')
    expect(cleanGeneratedText('Generating…\nfeat: hello world')).toBe('feat: hello world')
    expect(cleanGeneratedText('feat: a\r\nbody line\r\n')).toBe('feat: a\nbody line')
    expect(cleanGeneratedText('● Add Copilot entry')).toBe('Add Copilot entry')
    expect(cleanGeneratedText('1. Add numbered entry')).toBe('Add numbered entry')
    expect(cleanGeneratedText('<think>short</think>\n```\nfeat: add parser\n```')).toBe('feat: add parser')
    expect(cleanGeneratedText('<think>still reasoning')).toBe('<think>still reasoning')
    expect(cleanGeneratedText('   \n\t')).toBe('')
  })
  it('commitMessageOf — 제목 72자·끝 마침표 없음·본문은 빈 줄 뒤', () => {
    expect(commitMessageOf('Fix login crash.\nbody line')).toBe('Fix login crash\n\nbody line')
    expect(commitMessageOf('x'.repeat(100))).toHaveLength(72)
    expect(commitMessageOf('  ')).toBe('')
  })
  it('sanitizeBranchSlug(Orca 시험)', () => {
    expect(sanitizeBranchSlug('Fix the auth bug')).toBe('fix-the-auth-bug')
    expect(sanitizeBranchSlug('add dark mode toggle to settings page')).toBe('add-dark-mode-toggle')
    expect(sanitizeBranchSlug('"feat/login_flow!!"')).toBe('feat-login-flow')
    expect(sanitizeBranchSlug('   !!! ___ ')).toBe('')
  })
  it('parseMrFields — 울타리 걷고 JSON, base 없으면 지금 기준', () => {
    expect(parseMrFields('```json\n{"title":"Add retry.","body":"## Problem\\nx\\n","draft":false}\n```', 'main')).toEqual({ base: 'main', title: 'Add retry', body: '## Problem\nx' })
    expect(() => parseMrFields('not json', 'main')).toThrow()
  })
  it('실행 인자 — claude -p·plan·sonnet, 훅 끄기는 POSIX 만(전역 설정 안 건드림) · codex 읽기 전용 · gemini 는 claude 로', () => {
    expect(scmAiArgs('claude', { strictMcp: true, posix: true })).toEqual(['-p', '--output-format', 'text', '--model', 'sonnet', '--permission-mode', 'plan', '--effort', 'low', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'])
    expect(scmAiArgs('claude', { strictMcp: false, posix: false })).not.toContain('--settings')
    expect(scmAiArgs('codex', { strictMcp: true, posix: true })).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'])
    expect(scmAiAgentOf('gemini')).toBe('claude')
    expect(scmAiAgentOf('codex')).toBe('codex')
  })
  it('커밋 프롬프트에 브랜치·스테이지 목록·패치', () => {
    const p = buildCommitMessagePrompt({ branch: 'feat/x', stagedSummary: 'M\ta.ts', stagedPatch: '+x' })
    expect(p).toContain('Branch: feat/x')
    expect(p).toContain('M\ta.ts')
    expect(p).toContain('```diff\n+x\n```')
  })
})

describe('[AI 로 쓰기] — 진짜 git + 가짜 에이전트', { timeout: 30_000 }, () => {
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' })
  const repo = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'm12r3-'))
    g(d, 'init', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), 'one\n')
    g(d, 'add', '.')
    g(d, 'commit', '-qm', 'init')
    return d
  }
  /** git 은 진짜, 그 밖(에이전트)은 reply 가 답한다. 받은 것을 calls 에 남긴다. */
  const fakeX = (reply: (file: string, args: readonly string[], o?: RunOptions) => Partial<RunResult>) => {
    const calls: { file: string; args: readonly string[]; input?: string }[] = []
    const x = async (file: string, args: readonly string[], o?: RunOptions): Promise<RunResult> => {
      if (file === 'git') return runProcess(file, args, o)
      calls.push({ file, args, input: o?.input })
      return { code: 0, stdout: '', stderr: '', error: null, ...reply(file, args, o) }
    }
    return { x, calls }
  }
  const settings = agentSettingsOf(null)

  it('커밋 — 스테이지 없으면 noStaged, 있으면 stdin 으로 diff 를 보내고 메시지만 돌려준다(커밋 안 함)', async () => {
    const d = repo()
    try {
      const { x, calls } = fakeX(() => ({ stdout: '```\nAdd two.\n```\n' }))
      expect(await generateScmText('commit', { root: d, x, remote: false, settings, win: false })).toEqual({ ok: false, code: 'noStaged' })
      writeFileSync(join(d, 'a.txt'), 'one\ntwo\n')
      g(d, 'add', '.')
      const r = await generateScmText('commit', { root: d, x, remote: false, settings, win: false })
      expect(r).toEqual({ ok: true, agent: 'claude', text: 'Add two' })
      expect(calls[0].file).toBe('claude')
      expect(calls[0].args).toContain('-p')
      expect(calls[0].input).toContain('+two')
      expect(g(d, 'log', '--oneline').trim().split('\n')).toHaveLength(1) // 커밋은 사용자가
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
  it('CLI 없음(cmd 9009·셸 127) → noCli / 원격은 noCliRemote(로그인 셸로 감싸 그 서버 CLI)', async () => {
    const d = repo()
    try {
      writeFileSync(join(d, 'a.txt'), 'x\n')
      g(d, 'add', '.')
      const local = fakeX(() => ({ code: 9009, stderr: "'claude' is not recognized" }))
      expect((await generateScmText('commit', { root: d, x: local.x, remote: false, settings, win: false })) as { code: string }).toMatchObject({ ok: false, code: 'noCli' })
      const remote = fakeX(() => ({ code: 127, stderr: 'claude: not found' }))
      expect(await generateScmText('commit', { root: d, x: remote.x, remote: true, settings })).toMatchObject({ ok: false, code: 'noCliRemote' })
      expect(remote.calls[0].file).toBe('sh')
      expect(remote.calls[0].args.slice(0, 3)).toEqual(['-lc', 'exec "$0" "$@"', 'claude'])
      expect(remote.calls[0].args).toContain('--settings') // 원격은 POSIX — 훅 끄기를 실행 인자로
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
  it('기업 MCP 거절이면 --strict-mcp-config 만 빼고 한 번 더 · 취소', async () => {
    const d = repo()
    try {
      writeFileSync(join(d, 'a.txt'), 'x\n')
      g(d, 'add', '.')
      const { x, calls } = fakeX((_f, args) => (args.includes('--strict-mcp-config') ? { code: 1, stderr: CLAUDE_ENTERPRISE_REFUSAL } : { stdout: 'Update a' }))
      expect(await generateScmText('commit', { root: d, x, remote: false, settings, win: false })).toEqual({ ok: true, agent: 'claude', text: 'Update a' })
      expect(calls).toHaveLength(2)
      const ac = new AbortController()
      const c2 = fakeX(() => {
        ac.abort()
        return { code: 1, error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }
      })
      expect(await generateScmText('commit', { root: d, x: c2.x, remote: false, settings, win: false, signal: ac.signal })).toMatchObject({ ok: false, code: 'canceled' })
      // git 으로 맥락을 모으는 중의 취소(e2e R3-2) — 끊긴 git 이 빈 결과를 내도 noStaged 가 아니라 취소.
      const ac2 = new AbortController()
      const early = async (file: string, args: readonly string[], o?: RunOptions): Promise<RunResult> => {
        if (args.includes('--cached')) ac2.abort()
        return runProcess(file, args, o)
      }
      expect(await generateScmText('commit', { root: d, x: early, remote: false, settings, win: false, signal: ac2.signal })).toEqual({ ok: false, code: 'canceled', agent: 'claude' })
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
  it('MR 초안(기준 = main 대비 커밋) · 브랜치 이름 → 바꾸기는 따로', async () => {
    const d = repo()
    try {
      g(d, 'checkout', '-qb', 'work')
      writeFileSync(join(d, 'b.txt'), 'b\n')
      g(d, 'add', '.')
      g(d, 'commit', '-qm', 'add b')
      const mr = fakeX(() => ({ stdout: '{"base":"main","title":"Add b file","body":"## Problem\\nnone","draft":false}' }))
      const r = await generateScmText('mr', { root: d, x: mr.x, remote: false, settings, win: false })
      expect(r).toEqual({ ok: true, agent: 'claude', base: 'main', title: 'Add b file', body: '## Problem\nnone' })
      expect(mr.calls[0].input).toContain('add b')
      const br = fakeX(() => ({ stdout: 'Add B File Support\n' }))
      const b = await generateScmText('branch', { root: d, x: br.x, remote: false, settings, win: false })
      expect(b).toEqual({ ok: true, agent: 'claude', slug: 'add-b-file-support' })
      expect(g(d, 'branch', '--show-current').trim()).toBe('work') // 이름은 아직 그대로
      expect(await renameBranch(d, 'add-b-file-support', runProcess)).toEqual({ ok: true, message: 'add-b-file-support' })
      expect(g(d, 'branch', '--show-current').trim()).toBe('add-b-file-support')
      expect((await renameBranch(d, 'bad..name', runProcess)).ok).toBe(false)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
