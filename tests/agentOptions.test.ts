// M5 R2 — 모델 목록 파싱(AI-15)·첫 실행 인자·슬래시 스캔(AI-16, 임시 폴더)·이름 짓기 입력과 정리(AI-19)·채팅 권한(AI-18 — 피커 초안 → 실행 인자).
// 진짜 claude/codex/gemini 를 띄우지 않는다 — run 을 바꿔 끼우고, 모델 목록은 Orca 시험의 control_response 모양을 줄인 픽스처.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CHAT_NAME_OPENING,
  CLAUDE_MODEL_LIST_STDIN,
  chatNamePrompt,
  commandNameOf,
  describeMarkdown,
  filterSlash,
  launchOptionArgs,
  optionCommand,
  parseClaudeModelList,
  sanitizeChatName,
  slashQuery
} from '@shared/agentOptions'
import { defaultAgentSettings, planAgentLaunch } from '@shared/agents'
import { generateChatName, listModels, runAgentOnce, scanSlash } from '../src/main/agents/options'
import { promptBytes } from '../src/main/agents/status'
import type { RunOptions, RunResult } from '../src/main/util/runProcess'

const listing = (models: unknown[]): string =>
  ['{"type":"system","subtype":"init"}', JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'ara-model-discovery', response: { models } } }), 'not json'].join('\n')

const MODELS = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-x-sonnet' },
  { value: 'opus', displayName: 'Opus', description: '가장 강한', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'xhigh', 'bad level'], resolvedModel: 'claude-x-opus' },
  { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'], resolvedModel: 'claude-x-sonnet' },
  { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
  { value: 'cc-update-required-1', disabled: true },
  { value: 'opus', displayName: 'dup' },
  { value: 'bad id; rm -rf', displayName: 'nope' }
]

describe('AI-15 모델 목록(CLI 가 알려 준 것)', () => {
  it('control_response 를 읽고 default 줄·disabled·겹침·위험한 id 는 뺀다, default 가 가리키는 모델에 표시', () => {
    expect(parseClaudeModelList(listing(MODELS))).toEqual([
      { id: 'opus', label: 'Opus', description: '가장 강한', efforts: ['low', 'high', 'xhigh'] },
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'], isDefault: true },
      { id: 'haiku', label: 'Haiku', efforts: [] }
    ])
    expect(parseClaudeModelList('{"type":"control_response","response":{"subtype":"error"}}')).toEqual([])
    expect(parseClaudeModelList('')).toEqual([])
  })
  it('첫 실행은 --model·--effort(Claude 만), 실행 중 탭은 /model·/effort — 낱말 하나가 아니면 버린다', () => {
    expect(launchOptionArgs('claude', { model: 'opus[1m]', effort: 'high' })).toEqual(['--model', 'opus[1m]', '--effort', 'high'])
    expect(launchOptionArgs('claude', { model: 'x; rm', effort: '' })).toEqual([])
    expect(launchOptionArgs('codex', { model: 'gpt' })).toEqual([])
    expect(optionCommand('model', 'sonnet')).toBe('/model sonnet')
    expect(optionCommand('effort', 'a b')).toBeNull()
  })
  it('실행 계획: 옵션은 권한·--rc 뒤, 사용자 인자 앞 · AI-18 이번 탭 권한이 설정을 이긴다(모르는 권한은 무시)', () => {
    const settings = defaultAgentSettings()
    settings.agents.claude.args = '--verbose'
    const p = planAgentLaunch({ agent: 'claude', settings, shell: 'posix', options: { model: 'opus', effort: 'high', permission: 'ask' } })
    expect(p.ok && p.line).toBe('claude --permission-mode default --model opus --effort high --verbose')
    const g = planAgentLaunch({ agent: 'gemini', settings, shell: 'posix', options: { permission: 'auto' } })
    expect(g.ok && g.line).toBe('gemini --yolo')
  })
  it('목록 묻기: claude -p stream-json 에 list_models 를 stdin 으로(Windows 는 cmd /d /c), 실패는 error', async () => {
    const calls: { file: string; args: readonly string[]; opts?: RunOptions }[] = []
    const ok = async (file: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> => {
      calls.push({ file, args, opts })
      return { code: 0, stdout: listing(MODELS), stderr: '', error: null }
    }
    const s = defaultAgentSettings()
    const c = await listModels('claude', s, ok, true)
    expect('models' in c && c.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(calls[0].args.slice(0, 4)).toEqual(['/d', '/c', 'claude', '-p'])
    expect(calls[0].args).not.toContain('--settings') // cmd 인용 위험 — Windows 는 안 붙인다
    expect(calls[0].opts?.input).toBe(CLAUDE_MODEL_LIST_STDIN)
    await listModels('claude', s, ok, false)
    expect(calls[1].file).toBe('claude')
    expect(calls[1].args).toContain('{"disableAllHooks":true}')
    const bad = await listModels('claude', s, async () => ({ code: 1, stdout: '', stderr: 'not logged in', error: new Error('x') }), false)
    expect(bad).toEqual({ error: 'not logged in' })
    expect(await listModels('codex', s, ok, false)).toEqual({ error: 'unsupported' })
  })
  it('명령 바꾸기 — cmd 에 담을 수 없는 실행 파일은 띄우지 않는다', async () => {
    const s = defaultAgentSettings()
    s.agents.claude.command = 'C:\\x%PATH%\\claude.cmd'
    let ran = false
    const r = await runAgentOnce({ agent: 'claude', settings: s, args: [], input: '', timeoutMs: 1 }, async () => ((ran = true), { code: 0, stdout: '', stderr: '', error: null }), true)
    expect(ran).toBe(false)
    expect(r.error).not.toBeNull()
  })
})

describe('AI-16 슬래시 목록', () => {
  const root = mkdtempSync(join(tmpdir(), 'ara-slash-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const put = (p: string, body: string): void => {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }

  it('설명은 앞머리 description, 없으면 첫 문단 · 하위 폴더는 a:b · 맨 앞 / 만', () => {
    expect(describeMarkdown('---\nname: deploy\ndescription: "배포 점검"\n---\n# 제목\n본문').description).toBe('배포 점검')
    expect(describeMarkdown('# 제목\n\n첫 문단\n둘째 줄\n\n다음').description).toBe('첫 문단 둘째 줄')
    expect(commandNameOf('git/commit.md')).toBe('git:commit')
    expect(commandNameOf('bad name.md')).toBeNull()
    expect(slashQuery('/rev')).toBe('rev')
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/review 이것')).toBeNull()
    expect(slashQuery('hi /x')).toBeNull()
  })

  it('Claude: 기본 + 프로젝트·사용자 명령·스킬(프로젝트가 이긴다, 심볼릭 링크·깨진 이름 무시)', () => {
    const home = join(root, 'home')
    const cwd = join(root, 'repo')
    put(join(cwd, '.claude', 'commands', 'deploy.md'), '---\ndescription: 프로젝트 배포\n---\n')
    put(join(cwd, '.claude', 'commands', 'git', 'commit.md'), '커밋 만들기')
    put(join(home, '.claude', 'commands', 'deploy.md'), '---\ndescription: 사용자 배포\n---\n')
    put(join(home, '.claude', 'commands', 'mine.md'), '내 명령')
    put(join(home, '.claude', 'skills', 'pdf-tool', 'SKILL.md'), '---\nname: pdf\ndescription: PDF 다루기\n---\n')
    put(join(home, '.claude', 'skills', 'empty', 'README.md'), 'x')
    const list = scanSlash('claude', cwd, home, {})
    expect(list.slice(0, 2)).toEqual([
      { name: 'clear', kind: 'builtin' },
      { name: 'compact', kind: 'builtin' }
    ])
    const found = list.filter((x) => x.kind !== 'builtin')
    expect(found).toEqual([
      { name: 'deploy', kind: 'command', source: 'project', description: '프로젝트 배포' },
      { name: 'git:commit', kind: 'command', source: 'project', description: '커밋 만들기' },
      { name: 'mine', kind: 'command', source: 'user', description: '내 명령' },
      { name: 'pdf', kind: 'skill', source: 'user', description: 'PDF 다루기' }
    ])
    // CLAUDE_CONFIG_DIR 이 있으면 그 폴더(사용자 쪽).
    put(join(root, 'cfg', 'commands', 'cfgcmd.md'), 'x')
    expect(scanSlash('claude', cwd, home, { CLAUDE_CONFIG_DIR: join(root, 'cfg') }).some((x) => x.name === 'cfgcmd')).toBe(true)
  })

  it('Codex prompts → /prompts:<이름>, Gemini commands/*.toml(description = "…")', () => {
    const home = join(root, 'h2')
    put(join(home, '.codex', 'prompts', 'fix.md'), '---\ndescription: 고치기\n---\n')
    put(join(home, '.gemini', 'commands', 'test', 'run.toml'), 'description = "시험 돌리기"\nprompt = "x"\n')
    expect(scanSlash('codex', root, home, {}).find((x) => x.kind === 'command')).toEqual({ name: 'prompts:fix', kind: 'command', source: 'user', description: '고치기' })
    expect(scanSlash('gemini', root, home, {}).find((x) => x.kind === 'command')).toEqual({ name: 'test:run', kind: 'command', source: 'user', description: '시험 돌리기' })
  })

  it('거르기 — 앞이 맞는 것 먼저, 그다음 들어 있는 것', () => {
    const items = [{ name: 'review', kind: 'builtin' as const }, { name: 'git:review', kind: 'command' as const }, { name: 'resume', kind: 'builtin' as const }]
    expect(filterSlash(items, 're').map((x) => x.name)).toEqual(['review', 'resume', 'git:review'])
    expect(filterSlash(items, 'view').map((x) => x.name)).toEqual(['review', 'git:review'])
    expect(filterSlash(items, '').length).toBe(3)
  })
})

describe('AI-19 채팅 이름', () => {
  it('요청 글 = 첫 요청만(4000자까지), 첫 줄은 지난 세션 목록이 숨길 때 보는 표식', () => {
    const p = chatNamePrompt('  ' + 'x'.repeat(5000))
    expect(p.startsWith(CHAT_NAME_OPENING)).toBe(true)
    expect(p).toContain('at most 48 characters')
    expect(p.length).toBeLessThan(4300)
  })
  it('정리 — 생각 블록 거절, 첫 줄, 머리표·강조·따옴표·title: 벗김, 48자(공백에서)', () => {
    expect(sanitizeChatName('\n## **"Title: 목록 정렬 고치기"**\n설명')).toBe('목록 정렬 고치기')
    expect(sanitizeChatName('<think>음</think>\n이름')).toBeNull()
    expect(sanitizeChatName('   ')).toBeNull()
    const long = sanitizeChatName('Fix the sorting of the worktree list in the sidebar panel today')!
    expect(long.length).toBeLessThanOrEqual(48)
    expect(long.endsWith(' ')).toBe(false)
    expect(sanitizeChatName('\x1b[1m굵은\x1b[0m 이름')).toBe('굵은 이름')
  })
  it('그 에이전트로 한 번(읽기 전용 인자) — 첫 요청은 stdin 으로만, 빈 요청은 안 묻는다', async () => {
    const calls: { args: readonly string[]; opts?: RunOptions }[] = []
    const run = async (_f: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> => {
      calls.push({ args, opts })
      return { code: 0, stdout: 'Sort fix\n', stderr: '', error: null }
    }
    const s = defaultAgentSettings()
    const hard = 'hello "따옴표" & 100%'
    expect(await generateChatName({ agent: 'claude', settings: s, cwd: '/w', firstPrompt: hard }, run, false)).toBe('Sort fix')
    expect(calls[0].args).toEqual(['-p', '--output-format', 'text', '--permission-mode', 'plan'])
    expect(calls[0].args.join(' ')).not.toContain('따옴표')
    expect(calls[0].opts?.input).toContain(hard)
    expect(await generateChatName({ agent: 'codex', settings: s, cwd: '/w', firstPrompt: ' ' }, run, false)).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('슬래시 명령은 평문으로 친다(Orca: 붙여넣기면 TUI 가 글로 받는다)', () => {
  it('한 줄 /명령만 평문, 여러 줄·일반 글은 괄호 붙여넣기', () => {
    expect(promptBytes('claude', '/model opus', true)).toBe('/model opus')
    expect(promptBytes('claude', '/clear\n둘째', true)).toBe('\x1b[200~/clear\n둘째\x1b[201~')
    expect(promptBytes('claude', 'a/b', false)).toBe('\x1b[200~a/b\x1b[201~')
  })
})
