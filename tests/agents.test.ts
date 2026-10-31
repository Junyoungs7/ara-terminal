import { describe, expect, it } from 'vitest'
import {
  agentSettingsOf,
  defaultAgentSettings,
  extractLeadingEnvAssignments,
  firstCommandPath,
  mergePathSegments,
  migrateAiCliFlags,
  parseAgentCommand,
  parseCliVersion,
  parseEnvLines,
  parseShellPath,
  permissionChoicesFor,
  planAgentLaunch,
  quoteArg,
  SHELL_PATH_MARK,
  tokenizeArgs,
  type AgentSettings
} from '../src/shared/agents'

describe('parseCliVersion (Orca app-version 시험 일부)', () => {
  it('출력 속 첫 semver', () => {
    expect(parseCliVersion('2.1.300 (Claude Code)')).toBe('2.1.300')
    expect(parseCliVersion('codex-cli 0.46.0')).toBe('0.46.0')
    expect(parseCliVersion('v0.9.1-beta.2+abc\n')).toBe('0.9.1-beta.2+abc')
  })
  it('판이 없으면 null', () => {
    expect(parseCliVersion('command not found')).toBeNull()
    expect(parseCliVersion('1.2')).toBeNull()
    expect(parseCliVersion(null)).toBeNull()
  })
})

describe('감지 파서', () => {
  it('where 출력 — Windows 는 실행 가능한 확장자를 먼저', () => {
    const out = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd\r\n'
    expect(firstCommandPath(out, true)).toBe('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd')
    expect(firstCommandPath('/usr/local/bin/codex\n', false)).toBe('/usr/local/bin/codex')
    expect(firstCommandPath('', true)).toBeNull()
  })
  it('로그인 셸 PATH — 표식 사이만, 색·배너는 버림', () => {
    const out = `\x1b[32mwelcome\x1b[0m\n${SHELL_PATH_MARK}/a:/b:/a${SHELL_PATH_MARK}\nbye`
    expect(parseShellPath(out, ':')).toEqual(['/a', '/b'])
    expect(parseShellPath('no marks', ':')).toEqual([])
  })
  it('PATH 합치기 — 없는 것만 뒤에(Windows 대소문자·끝 \\ 무시)', () => {
    expect(mergePathSegments('C:\\x;C:\\Y\\', ['c:\\y', 'C:\\z'], ';', true)).toBe('C:\\x;C:\\Y\\;C:\\z')
    expect(mergePathSegments('/a', ['/a/', '/b'], ':', false)).toBe('/a:/b')
  })
})

describe('명령 계획 (Orca agent-command-plan)', () => {
  it('따옴표·이어 붙는 조각', () => {
    expect(tokenizeArgs(`--model "son net" a'b'c`)).toEqual({ ok: true, tokens: ['--model', 'son net', 'abc'] })
    expect(tokenizeArgs('a "b').ok).toBe(false)
    expect(tokenizeArgs('C:\\tools\\x.exe', 'literal')).toEqual({ ok: true, tokens: ['C:\\tools\\x.exe'] })
  })
  it('앞 env 할당은 데이터', () => {
    expect(extractLeadingEnvAssignments(['A=1', 'B=x=y', 'cmd', 'C=2'])).toEqual({ env: { A: '1', B: 'x=y' }, rest: ['cmd', 'C=2'] })
  })
  it('명령 바꾸기', () => {
    expect(parseAgentCommand('claude', '')).toEqual({ ok: true, binary: 'claude', prefixArgs: [] })
    expect(parseAgentCommand('claude', 'FOO=1 npx @anthropic-ai/claude-code')).toEqual({
      ok: true,
      binary: 'npx',
      prefixArgs: ['@anthropic-ai/claude-code'],
      env: { FOO: '1' }
    })
    expect(parseAgentCommand('claude', 'FOO=1').ok).toBe(false)
  })
})

describe('설정', () => {
  it('저장값 거르기 — 모르는 권한·틀린 env 는 기본값', () => {
    const s = agentSettingsOf({
      agents: { gemini: { permission: 'auto', env: { OK: '1', 'BAD-NAME': 'x', N: 3 }, enabled: false } },
      defaultAgent: 'codex',
      claudeRemoteControl: true
    })
    expect(s.agents.gemini.permission).toBe('full-access') // gemini 는 auto 가 없다
    expect(s.agents.gemini.env).toEqual({ OK: '1' })
    expect(s.agents.gemini.enabled).toBe(false)
    expect(s.agents.claude.permission).toBe('full-access') // 기본 Yolo
    expect(s.defaultAgent).toBe('codex')
    expect(s.claudeRemoteControl).toBe(true)
    expect(agentSettingsOf(null).claudeRemoteControl).toBe(false) // 원격 제어 기본 꺼짐
  })
  it('권한 선택지', () => {
    expect(permissionChoicesFor('claude')).toEqual(['own', 'ask', 'accept-edits', 'auto', 'full-access'])
    expect(permissionChoicesFor('gemini')).toEqual(['own', 'full-access'])
  })
  it('env 줄', () => {
    expect(parseEnvLines('A=1\n# x\n\nbad\nB = 2')).toEqual({ env: { A: '1', B: ' 2' }, bad: ['bad'] })
  })
})

describe('aiCliFlags 마이그레이션', () => {
  const base = defaultAgentSettings()
  it('켜 둔 것만 옮긴다', () => {
    const m = migrateAiCliFlags(base, { claude: ['skipPerms', 'resume'], codex: ['fullAuto'], gemini: ['yolo', 'sandbox'] })
    expect(m.migratedAiCliFlags).toBe(true)
    expect(m.agents.claude).toMatchObject({ permission: 'full-access', args: '' }) // -r 은 안 옮김
    expect(m.agents.codex).toMatchObject({ permission: 'full-access', args: '--full-auto' })
    expect(m.agents.gemini).toMatchObject({ permission: 'full-access', args: '--sandbox' })
  })
  it('claude 권한 건너뛰기를 끈 사용자는 own', () => {
    expect(migrateAiCliFlags(base, { claude: ['resume'] }).agents.claude.permission).toBe('own')
  })
  it('값이 없으면 새 기본값 그대로', () => {
    const m = migrateAiCliFlags(base, undefined)
    expect(m.agents).toEqual(base.agents)
    expect(base.migratedAiCliFlags).toBe(false) // 원본은 안 바뀜
  })
})

describe('실행 한 줄 (AI-03)', () => {
  const s = (patch?: (x: AgentSettings) => void): AgentSettings => {
    const x = defaultAgentSettings()
    patch?.(x)
    return x
  }
  it('claude 기본 = Yolo + 지시는 env 참조(posix·powershell·cmd)', () => {
    const p = planAgentLaunch({ agent: 'claude', settings: s(), prompt: 'a & b; $(rm -rf /) "x"', shell: 'posix' })
    expect(p).toEqual({
      ok: true,
      line: 'claude --dangerously-skip-permissions "$ARA_AGENT_PROMPT"',
      env: { ARA_AGENT_PROMPT: 'a & b; $(rm -rf /) "x"' },
      permissionShadowed: false
    })
    const ps = planAgentLaunch({ agent: 'claude', settings: s(), prompt: 'hi', shell: 'powershell' })
    expect(ps.ok && ps.line).toBe('& claude --dangerously-skip-permissions $env:ARA_AGENT_PROMPT')
    const cmd = planAgentLaunch({ agent: 'claude', settings: s(), prompt: 'hi', shell: 'cmd' })
    expect(cmd.ok && cmd.line).toBe('cmd /v:on /d /c claude --dangerously-skip-permissions "!ARA_AGENT_PROMPT!"')
  })
  it('지시가 없으면 env 도 참조도 없다', () => {
    const p = planAgentLaunch({ agent: 'codex', settings: s(), prompt: '  ', shell: 'posix' })
    expect(p).toEqual({ ok: true, line: 'codex --dangerously-bypass-approvals-and-sandbox', env: {}, permissionShadowed: false })
  })
  it('gemini 는 --prompt-interactive', () => {
    const p = planAgentLaunch({ agent: 'gemini', settings: s(), prompt: 'x', shell: 'posix' })
    expect(p.ok && p.line).toBe('gemini --yolo --prompt-interactive "$ARA_AGENT_PROMPT"')
  })
  it('권한 모드 전환·원격 제어·사용자 인자·env·명령 바꾸기', () => {
    const p = planAgentLaunch({
      agent: 'claude',
      settings: s((x) => {
        x.agents.claude = { ...x.agents.claude, permission: 'accept-edits', args: '--model "son net"', env: { A: '1' }, command: 'B=2 npx claude' }
        x.claudeRemoteControl = true
      }),
      shell: 'posix'
    })
    expect(p).toEqual({
      ok: true,
      line: "npx claude --permission-mode acceptEdits --rc --model 'son net'",
      env: { A: '1', B: '2' },
      permissionShadowed: false
    })
  })
  it('원격 제어는 claude 에만', () => {
    const p = planAgentLaunch({ agent: 'codex', settings: s((x) => (x.claudeRemoteControl = true)), shell: 'posix' })
    expect(p.ok && p.line).not.toContain('--rc')
  })
  it('사용자 인자에 권한 플래그가 있으면 권한 모드 플래그를 붙이지 않는다', () => {
    const p = planAgentLaunch({ agent: 'codex', settings: s((x) => (x.agents.codex.args = '--full-auto')), shell: 'posix' })
    expect(p).toMatchObject({ ok: true, line: 'codex --full-auto', permissionShadowed: true })
  })
  it('own = 플래그 없음', () => {
    const p = planAgentLaunch({ agent: 'claude', settings: s((x) => (x.agents.claude.permission = 'own')), shell: 'powershell' })
    expect(p.ok && p.line).toBe('& claude')
  })
  it('cmd 에 못 담는 글자는 거절', () => {
    const p = planAgentLaunch({ agent: 'claude', settings: s((x) => (x.agents.claude.args = '--x "%PATH%"')), shell: 'cmd' })
    expect(p.ok).toBe(false)
  })
  it('인용', () => {
    expect(quoteArg("it's", 'posix')).toBe(`'it'\\''s'`)
    expect(quoteArg("it's", 'powershell')).toBe(`'it''s'`)
    expect(quoteArg('--', 'powershell')).toBe(`'--'`)
    expect(quoteArg('@x', 'powershell')).toBe(`'@x'`)
    expect(quoteArg('a b', 'cmd')).toBe('"a b"')
    expect(quoteArg('a\nb', 'posix')).toBeNull()
  })
})
