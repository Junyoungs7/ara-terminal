// M3 R2 AI-04 훅(Orca 방식)·S2 정리·AI-06 자식 줄·훅 + 화면 합치기. 사용자 실제 ~/.claude 는 안 건드린다 — 전부 임시 홈.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyHookEvent,
  HOOK_ENV,
  HOOK_PANE_HEADER,
  HOOK_SILENT_MS,
  HOOK_TOKEN_HEADER,
  hookCommand,
  hookScript,
  launchHooks,
  mergeHooks,
  removeLegacyHooks,
  removeOurHooks,
  resolveStatus,
  type HookPane
} from '../src/shared/agentHooks'
import type { ScreenDetection } from '../src/shared/agentScreen'
import { claudeLaunchArgs, cleanupLegacyHooks, cleanupOurGlobalHooks, createHookServer, geminiLaunchDefaults, installHooks, type HookEvent } from '../src/main/agents/hooks'
import { runProcess } from '../src/main/util/runProcess'

const T = 1_700_000_000_000
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ hook_event_name, ...extra })
const run = (events: Record<string, unknown>[], source: 'claude' | 'gemini' = 'claude'): HookPane | null =>
  events.reduce<HookPane | null>((p, e, i) => applyHookEvent(p, source, e, T + i) ?? p, null)

describe('훅 이벤트 → 상태(Orca claude-events·provider-event-routing)', () => {
  it('claude 한 턴: 제출 → 도구 → 승인 대기 → 도구 → 끝', () => {
    expect(run([ev('UserPromptSubmit')])?.state).toBe('working')
    expect(run([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'Bash' })])).toMatchObject({ state: 'working', tool: 'Bash' })
    expect(run([ev('UserPromptSubmit'), ev('PermissionRequest', { tool_name: 'Bash' })])).toMatchObject({ state: 'blocked', kind: 'permission' })
    expect(run([ev('PermissionRequest', { tool_name: 'Bash' }), ev('PostToolUse', { tool_name: 'Bash' })])?.state).toBe('working')
    expect(run([ev('UserPromptSubmit'), ev('Stop')])?.state).toBe('idle')
    expect(run([ev('UserPromptSubmit'), ev('StopFailure')])?.state).toBe('idle')
  })
  it('AskUserQuestion 은 질문 막힘(물음표)', () => {
    expect(run([ev('PreToolUse', { tool_name: 'AskUserQuestion' })])).toMatchObject({ state: 'blocked', kind: 'question' })
  })
  it('모르는 이벤트·이름 없는 본문은 아무 주장도 안 한다', () => {
    expect(applyHookEvent(null, 'claude', ev('Notification'), T)).toBeNull()
    expect(applyHookEvent(null, 'claude', {}, T)).toBeNull()
    expect(applyHookEvent(null, 'gemini', ev('SessionStart'), T)).toBeNull()
  })
  it('gemini: BeforeAgent·BeforeTool = 일함, AfterAgent = 끝', () => {
    expect(run([ev('BeforeAgent')], 'gemini')?.state).toBe('working')
    expect(run([ev('BeforeAgent'), ev('BeforeTool', { tool_name: 'run_shell_command' })], 'gemini')).toMatchObject({ state: 'working', tool: 'run_shell_command' })
    expect(run([ev('BeforeAgent'), ev('AfterAgent')], 'gemini')?.state).toBe('idle')
  })
})

describe('서브에이전트 자식 줄(AI-06, Orca claude-subagent-roster)', () => {
  it('SubagentStart → 자식 줄, 자식의 도구 이벤트는 그 줄만 바꾸고 부모는 그대로', () => {
    const p = run([
      ev('UserPromptSubmit'),
      ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      ev('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep' })
    ])
    expect(p?.state).toBe('working')
    expect(p?.tool).toBeUndefined()
    expect(p?.children).toEqual([{ id: 'a1', agentType: 'Explore', state: 'working', tool: 'Grep', startedAt: T + 1 }])
  })
  it('자식이 승인을 기다리면 부모도 막힘, 자식이 다시 일하면 부모도 풀린다', () => {
    const blocked = run([ev('UserPromptSubmit'), ev('SubagentStart', { agent_id: 'a1' }), ev('PermissionRequest', { agent_id: 'a1', tool_name: 'Bash' })])
    expect(blocked?.state).toBe('blocked')
    expect(blocked?.children[0].state).toBe('blocked')
    const resumed = applyHookEvent(blocked, 'claude', ev('PostToolUse', { agent_id: 'a1', tool_name: 'Bash' }), T + 9)
    expect(resumed?.state).toBe('working')
    expect(resumed?.children[0].state).toBe('working')
  })
  it('SubagentStop(또는 자식의 StopFailure)이면 그 줄이 빠진다, 시작 없이 온 자식도 줄이 생긴다', () => {
    expect(run([ev('SubagentStart', { agent_id: 'a1' }), ev('SubagentStop', { agent_id: 'a1' })])?.children).toEqual([])
    expect(run([ev('SubagentStart', { agent_id: 'a1' }), ev('StopFailure', { agent_id: 'a1' })])?.children).toEqual([])
    expect(run([ev('PreToolUse', { agent_id: 'a9', tool_name: 'Read' })])?.children.map((c) => c.id)).toEqual(['a9'])
  })
  it('너무 긴 id 는 줄을 만들지 않는다(Orca 64자 상한)', () => {
    expect(run([ev('SubagentStart', { agent_id: 'x'.repeat(65) })])?.children).toEqual([])
  })
})

const det = (o: Partial<ScreenDetection>): ScreenDetection => ({ state: 'idle', skip: false, visibleBlocker: false, visibleIdle: false, visibleWorking: false, rule: 'r', ...o })
const pane = (o: Partial<HookPane>): HookPane => ({ state: 'working', children: [], at: T, ...o })

describe('훅 + 화면 합치기(훅 우선, 화면은 \'추정\')', () => {
  it('훅이 있으면 훅이 이긴다(추정 아님)', () => {
    const v = resolveStatus('s', { pane: pane({ state: 'working' }), event: 'PreToolUse' }, det({ state: 'idle' }), null, T)
    expect(v).toMatchObject({ state: 'working', estimated: false, source: 'hook:PreToolUse' })
  })
  it('훅이 없으면 화면 판정이 추정으로 채운다', () => {
    expect(resolveStatus('s', null, det({ state: 'blocked', rule: 'live_strong_blocker' }), null, T)).toMatchObject({ state: 'blocked', estimated: true, source: 'screen:live_strong_blocker' })
    expect(resolveStatus('s', null, det({ state: 'unknown', rule: null }), null, T).state).toBeNull()
  })
  it('살아 있는 막힘 UI 는 훅의 "일하는 중"을 덮는다(gemini 는 승인 훅이 없다)', () => {
    expect(resolveStatus('s', { pane: pane({}), event: 'BeforeTool' }, det({ state: 'blocked', visibleBlocker: true }), null, T)).toMatchObject({ state: 'blocked', estimated: true })
  })
  it('훅이 2분 넘게 "일하는 중"에서 말이 없고 화면이 쉬면 쉼(추정) — Esc 로 끊은 턴', () => {
    const h = { pane: pane({ at: T }), event: 'PreToolUse' }
    expect(resolveStatus('s', h, det({ state: 'idle', visibleIdle: true }), null, T + HOOK_SILENT_MS - 1).state).toBe('working')
    expect(resolveStatus('s', h, det({ state: 'idle', visibleIdle: true }), null, T + HOOK_SILENT_MS + 1)).toMatchObject({ state: 'idle', estimated: true })
  })
  it('화면이 건너뛰라고 하면(대화 기록 보기) 앞 상태를 둔다', () => {
    const prev = resolveStatus('s', null, det({ state: 'working' }), null, T)
    expect(resolveStatus('s', null, det({ state: 'unknown', skip: true }), prev, T)).toBe(prev)
  })
})

describe('설정 병합 — 남의 훅은 그대로', () => {
  const cmd = 'C:/Users/u/.ara/agent-hooks/claude-hook.cmd'
  const others = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] }, model: 'opus' }
  it('우리 줄을 이벤트마다 더하고, 남의 줄·다른 키는 그대로, 두 번째는 바뀐 게 없다(null)', () => {
    const next = mergeHooks(others, 'claude', cmd) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>; model: string }
    expect(next.model).toBe('opus')
    expect(next.hooks.Stop[0].hooks[0].command).toBe('notify-send done')
    expect(next.hooks.Stop[1].hooks[0].command).toBe(cmd)
    expect(next.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] })
    expect(next.hooks.PreToolUse[1].matcher).toBe('*')
    expect(Object.keys(next.hooks)).toEqual(expect.arrayContaining(['PermissionRequest', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']))
    expect(mergeHooks(next, 'claude', cmd)).toBeNull()
  })
  it('옮긴 홈의 옛 우리 줄은 바꿔 끼운다(파일 이름으로 가림)', () => {
    const old = mergeHooks({}, 'claude', 'D:/old/.ara/agent-hooks/claude-hook.cmd')
    const next = mergeHooks(old, 'claude', cmd) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    expect(next.hooks.Stop).toHaveLength(1)
    expect(next.hooks.Stop[0].hooks[0].command).toBe(cmd)
  })
  it('gemini 는 matcher 없이 밀리초 제한 시간', () => {
    const next = mergeHooks({}, 'gemini', '/h/.ara/agent-hooks/gemini-hook.sh') as { hooks: Record<string, { matcher?: string; hooks: { timeout: number }[] }[]> }
    expect(Object.keys(next.hooks)).toEqual(['BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'])
    expect(next.hooks.BeforeTool[0].matcher).toBeUndefined()
    expect(next.hooks.BeforeTool[0].hooks[0].timeout).toBe(10_000)
  })
})

describe('S2 정리 — 옛 `# ara-agent-hook` 줄만 지운다', () => {
  const legacy = (event: string): { type: string; command: string; timeout: number } => ({
    type: 'command',
    command: `ARA_P="$ARA_HOOK_PORT"; [ -n "$ARA_P" ] && curl -sS -m 2 -X POST "http://127.0.0.1:$ARA_P/hook/claude/${event}" >/dev/null 2>&1; exit 0 # ara-agent-hook`,
    timeout: 5
  })
  const mixed = {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }, legacy('Stop')] }],
      Notification: [{ hooks: [legacy('Notification')] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'C:/Users/u/.ara/agent-hooks/claude-hook.cmd' }] }, { hooks: [legacy('PreToolUse')] }]
    }
  }
  it('표식 줄만 빠지고, 같은 묶음의 남의 줄·새 훅·다른 키는 남는다. 비어 버린 이벤트는 사라진다', () => {
    expect(removeLegacyHooks(mixed)).toEqual({
      theme: 'dark',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'C:/Users/u/.ara/agent-hooks/claude-hook.cmd' }] }]
      }
    })
  })
  it('표식이 없으면 null(파일을 안 고친다)', () => {
    expect(removeLegacyHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ara-agent' }] }] } })).toBeNull()
    expect(removeLegacyHooks(null)).toBeNull()
  })

  const homes: string[] = []
  const home = (): string => {
    const h = mkdtempSync(join(tmpdir(), 'ara-hook-home-'))
    homes.push(h)
    return h
  }
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })

  it('파일로: 정리 1회 후 다시 불러도 쓰지 않는다, .bak 이 남는다, 깨진 JSON 은 손대지 않는다', () => {
    const h = home()
    mkdirSync(join(h, '.claude'))
    const cfg = join(h, '.claude', 'settings.json')
    writeFileSync(cfg, JSON.stringify(mixed))
    expect(cleanupLegacyHooks(h)).toBe(true)
    const after = JSON.parse(readFileSync(cfg, 'utf8'))
    expect(JSON.stringify(after)).not.toContain('ara-agent-hook')
    expect(after.hooks.Stop[0].hooks[0].command).toBe('notify-send done')
    expect(existsSync(cfg + '.bak')).toBe(true)
    expect(cleanupLegacyHooks(h)).toBe(false)
    writeFileSync(cfg, '{ broken ara-agent-hook')
    expect(cleanupLegacyHooks(h)).toBe(false)
    expect(readFileSync(cfg, 'utf8')).toBe('{ broken ara-agent-hook')
    expect(cleanupLegacyHooks(home())).toBe(false) // 파일 없음
  })

  it('installHooks(M9 R3): 스크립트만 쓴다 — 사용자 settings.json 은 만들지도 고치지도 않는다(깨진 파일도 그대로)', () => {
    const h = home()
    mkdirSync(join(h, '.claude'))
    const cfg = join(h, '.claude', 'settings.json')
    const mine = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } })
    writeFileSync(cfg, mine)
    expect(installHooks(h, 'claude', true).ok).toBe(true)
    expect(readFileSync(join(h, '.ara', 'agent-hooks', 'claude-hook.cmd'), 'utf8')).toBe(hookScript('claude', true))
    expect(readFileSync(cfg, 'utf8')).toBe(mine)
    expect(existsSync(cfg + '.bak')).toBe(false)
    const g = home()
    expect(installHooks(g, 'gemini', true).ok).toBe(true)
    expect(existsSync(join(g, '.gemini'))).toBe(false)
    const b = home()
    mkdirSync(join(b, '.gemini'))
    writeFileSync(join(b, '.gemini', 'settings.json'), '{ nope')
    expect(installHooks(b, 'gemini', true).ok).toBe(true) // 깨진 사용자 설정과 상관없이 실행 훅은 붙는다
    expect(readFileSync(join(b, '.gemini', 'settings.json'), 'utf8')).toBe('{ nope')
  })
})

describe('M9 R3 — 훅은 실행에만, 전역에 심었던 우리 줄은 정리', () => {
  const homes: string[] = []
  const home = (): string => {
    const h = mkdtempSync(join(tmpdir(), 'ara-hooks-r3-'))
    homes.push(h)
    return h
  }
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  })
  const others = { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] }

  it('removeOurHooks: 우리 줄만 빼고 남의 훅·다른 키는 그대로, 우리 것만 있던 hooks 칸은 없앤다, 없으면 null', () => {
    const ours = mergeHooks({ model: 'opus', hooks: others }, 'claude', 'C:/u/.ara/agent-hooks/claude-hook.cmd')
    expect(removeOurHooks(ours, 'claude')).toEqual({ model: 'opus', hooks: others })
    expect(removeOurHooks(mergeHooks({ model: 'opus' }, 'gemini', '/h/.ara/agent-hooks/gemini-hook.sh'), 'gemini')).toEqual({ model: 'opus' })
    expect(removeOurHooks({ hooks: others }, 'claude')).toBeNull()
    // gemini 줄은 claude 정리에 안 걸린다(파일 이름으로 가림)
    expect(removeOurHooks(mergeHooks({}, 'gemini', '/h/.ara/agent-hooks/gemini-hook.sh'), 'claude')).toBeNull()
  })

  it('cleanupOurGlobalHooks(임시 홈): ~/.claude·~/.gemini 의 우리 줄만 지움 + .bak, 남의 훅 남음, 두 번째·깨진 JSON·파일 없음은 안 씀', () => {
    const h = home()
    mkdirSync(join(h, '.claude'))
    mkdirSync(join(h, '.gemini'))
    const c = join(h, '.claude', 'settings.json')
    const g = join(h, '.gemini', 'settings.json')
    const geminiOthers = { AfterAgent: [{ hooks: [{ type: 'command', command: 'mine-after' }] }] }
    writeFileSync(c, JSON.stringify(mergeHooks({ hooks: others, model: 'opus' }, 'claude', 'C:/Users/u/.ara/agent-hooks/claude-hook.cmd')))
    writeFileSync(g, JSON.stringify(mergeHooks({ hooks: geminiOthers }, 'gemini', '/h/.ara/agent-hooks/gemini-hook.sh')))
    expect(cleanupOurGlobalHooks(h)).toBe(2)
    expect(JSON.parse(readFileSync(c, 'utf8'))).toEqual({ hooks: others, model: 'opus' })
    expect(JSON.parse(readFileSync(g, 'utf8'))).toEqual({ hooks: geminiOthers })
    expect(existsSync(c + '.bak') && existsSync(g + '.bak')).toBe(true)
    const before = readFileSync(c, 'utf8')
    expect(cleanupOurGlobalHooks(h)).toBe(0)
    expect(readFileSync(c, 'utf8')).toBe(before)
    writeFileSync(c, '{ broken claude-hook.cmd')
    expect(cleanupOurGlobalHooks(h)).toBe(0)
    expect(readFileSync(c, 'utf8')).toBe('{ broken claude-hook.cmd')
    expect(cleanupOurGlobalHooks(home())).toBe(0)
  })

  it('claudeLaunchArgs: --settings 파일에 상태 훅 + statusLine, 사용자 원래 훅은 섞지 않는다(Claude 가 층을 이어 붙인다)', () => {
    const win = process.platform === 'win32'
    const h = home()
    const cwd = home()
    expect(claudeLaunchArgs(h, cwd, join(h, '.claude'), win)).toEqual([])
    expect(installHooks(h, 'claude', win).ok).toBe(true)
    const a = claudeLaunchArgs(h, cwd, join(h, '.claude'), win)
    const s = JSON.parse(readFileSync(a[1], 'utf8'))
    expect(s.hooks).toEqual(launchHooks('claude', hookCommand(join(h, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh'), win)).hooks)
    expect(s.statusLine.type).toBe('command')
    mkdirSync(join(h, '.claude'))
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ hooks: others }))
    expect(claudeLaunchArgs(h, cwd, join(h, '.claude'), win)).toEqual(a)
    expect(existsSync(join(h, '.claude', 'settings.json.bak'))).toBe(false)
  })

  it('geminiLaunchDefaults: 스크립트가 있으면 hooks, 없으면 빈 객체', () => {
    const h = home()
    expect(geminiLaunchDefaults(h, true)).toEqual({})
    expect(installHooks(h, 'gemini', true).ok).toBe(true)
    expect(geminiLaunchDefaults(h, true)).toEqual(launchHooks('gemini', hookCommand(join(h, '.ara', 'agent-hooks', 'gemini-hook.cmd'), true)))
  })

  // 실제 Claude Code(이 PC 에 있으면): 임시 HOME·CLAUDE_CONFIG_DIR 에서 사용자 훅 + 우리 --settings 훅이 둘 다 돌고 우리 서버가 이벤트를 받는다.
  // 로그인 없는 임시 홈이라 턴은 "Not logged in" 으로 끝난다 — UserPromptSubmit 은 그 전에 돈다(2.1.300 실측). 인증 env 는 비워 API 를 안 부른다.
  const realClaude = ((): string | null => {
    const win = process.platform === 'win32'
    const exe = win ? 'claude.exe' : 'claude'
    for (const d of (process.env['PATH'] ?? '').split(win ? ';' : ':')) {
      if (!d) continue
      for (const f of [join(d, exe), join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe)]) if (existsSync(f)) return f
    }
    return null
  })()
  it.skipIf(!realClaude)('실제 claude: 사용자 훅과 아라 훅(--settings)이 둘 다 돌고, 아라 훅 서버가 UserPromptSubmit 을 받는다', async () => {
    const win = process.platform === 'win32'
    const got: HookEvent[] = []
    const server = createHookServer((e) => got.push(e))
    try {
      const { port, token } = await server.ensure()
      const h = home()
      const cfgDir = join(h, 'config')
      mkdirSync(cfgDir)
      const fired = join(h, 'user-hook.txt').split('\\').join('/')
      writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo user >> "${fired}"` }] }] } }))
      expect(installHooks(h, 'claude', win).ok).toBe(true)
      const cwd = join(h, 'work') // 홈 그 자체가 아닌 폴더(실행 자리와 같게)
      mkdirSync(cwd)
      // UserPromptSubmit 은 stream-json 에 hook_* 줄로 안 나온다(SessionStart 만 나옴, 실측) — 사용자 훅이 쓴 파일·서버 수신으로 본다.
      await runProcess(realClaude!, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...claudeLaunchArgs(h, cwd, cfgDir, win)], {
        cwd,
        timeoutMs: 60_000,
        input: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
        env: {
          HOME: h,
          USERPROFILE: h,
          CLAUDE_CONFIG_DIR: cfgDir,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          CLAUDE_CODE_USE_BEDROCK: '',
          CLAUDE_CODE_USE_VERTEX: '',
          [HOOK_ENV.port]: String(port),
          [HOOK_ENV.token]: token,
          [HOOK_ENV.pane]: 'tab-r3'
        }
      })
      expect(readFileSync(fired, 'utf8')).toContain('user')
      expect(got.map((e) => [e.source, e.paneKey, e.payload['hook_event_name']])).toContainEqual(['claude', 'tab-r3', 'UserPromptSubmit'])
      expect(existsSync(join(cfgDir, 'settings.json.bak'))).toBe(false)
    } finally {
      await server.stop()
    }
  }, 90_000)
})

describe('훅 명령·스크립트 모양', () => {
  it('Windows: 슬래시 맨 경로(공백 있으면 큰따옴표), POSIX: 안전하면 맨 경로', () => {
    expect(hookCommand('C:\\Users\\u\\.ara\\agent-hooks\\claude-hook.cmd', true)).toBe('C:/Users/u/.ara/agent-hooks/claude-hook.cmd')
    expect(hookCommand('C:\\Users\\Jun Young\\.ara\\agent-hooks\\claude-hook.cmd', true)).toBe('"C:/Users/Jun Young/.ara/agent-hooks/claude-hook.cmd"')
    expect(hookCommand('/home/u/.ara/agent-hooks/claude-hook.sh', false)).toBe('/home/u/.ara/agent-hooks/claude-hook.sh')
  })
  it('스크립트는 먼저 {} 를 찍고, env 가 없으면 0 으로 나간다', () => {
    const w = hookScript('claude', true).split('\r\n')
    expect(w.indexOf('echo {}')).toBeLessThan(w.findIndex((l) => l.includes('exit /b 0')))
    expect(w.at(-2)).toBe('exit /b 0')
    const p = hookScript('gemini', false).split('\n')
    expect(p[1]).toBe('printf "{}\\n"')
    expect(p.at(-2)).toBe('exit 0')
  })
})

describe('훅 서버(127.0.0.1) + 실제 훅 스크립트', () => {
  const servers: { stop(): Promise<void> }[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop()
  })
  const post = (port: number, path: string, headers: Record<string, string>, body: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(body)
    })

  it('토큰이 맞는 POST 만 받는다, 칸 키가 없으면 주장하지 않는다', async () => {
    const got: HookEvent[] = []
    const s = createHookServer((e) => got.push(e))
    servers.push(s)
    const { port, token } = await s.ensure()
    expect(port).toBeGreaterThan(0)
    expect(await s.ensure()).toEqual({ port, token }) // 두 번째는 같은 서버
    const body = JSON.stringify(ev('PreToolUse', { tool_name: 'Bash' }))
    expect(await post(port, '/hook/claude', { [HOOK_TOKEN_HEADER]: 'wrong', [HOOK_PANE_HEADER]: 'p1' }, body)).toBe(401)
    expect(await post(port, '/hook/nope', { [HOOK_TOKEN_HEADER]: token, [HOOK_PANE_HEADER]: 'p1' }, body)).toBe(404)
    expect(await post(port, '/hook/claude', { [HOOK_TOKEN_HEADER]: token }, body)).toBe(204)
    expect(got).toHaveLength(0)
    expect(await post(port, '/hook/claude', { [HOOK_TOKEN_HEADER]: token, [HOOK_PANE_HEADER]: 'p1' }, body)).toBe(204)
    expect(got).toEqual([{ source: 'claude', paneKey: 'p1', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } }])
  })

  it('M4: 지난번 포트·토큰으로 다시 연다(데몬에 산 에이전트의 훅이 재시작 뒤에도 닿게) — 그 포트가 쓰이면 새 포트', async () => {
    const a = createHookServer(() => {})
    servers.push(a)
    const first = await a.ensure()
    await a.stop()
    const b = createHookServer(() => {}, first)
    servers.push(b)
    expect(await b.ensure()).toEqual(first)
    const c = createHookServer(() => {}, first) // b 가 그 포트를 쥐고 있다
    servers.push(c)
    const third = await c.ensure()
    expect(third.port).toBeGreaterThan(0)
    expect(third.port).not.toBe(first.port)
    expect(third.token).toBe(first.token)
  })

  it('심은 훅 스크립트를 셸로 실행하면(가짜 CLI 대신 직접) 서버가 받고 stdout 은 {} — env 가 없으면 아무것도 안 보낸다', async () => {
    const win = process.platform === 'win32'
    if (!win && !existsSync('/bin/sh')) return
    const got: HookEvent[] = []
    const s = createHookServer((e) => got.push(e))
    servers.push(s)
    const { port, token } = await s.ensure()
    const h = mkdtempSync(join(tmpdir(), 'ara-hook-run-'))
    try {
      expect(installHooks(h, 'claude', win).ok).toBe(true)
      const script = join(h, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
      const runScript = (env: Record<string, string>): Promise<string> =>
        new Promise((resolve, reject) => {
          const base = { ...process.env }
          for (const k of Object.values(HOOK_ENV)) delete base[k]
          const child = win ? spawn('cmd.exe', ['/d', '/c', script], { env: { ...base, ...env } }) : spawn('/bin/sh', [script], { env: { ...base, ...env } })
          let out = ''
          child.stdout.on('data', (d: Buffer) => (out += d.toString()))
          child.on('error', reject)
          child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))))
          child.stdin.end(JSON.stringify(ev('Stop', { session_id: '한글 "따옴표" & %PATH%' })))
        })
      expect(await runScript({})).toBe('{}')
      expect(got).toHaveLength(0)
      expect(await runScript({ [HOOK_ENV.port]: String(port), [HOOK_ENV.token]: token, [HOOK_ENV.pane]: 'tab-1' })).toBe('{}')
      expect(got).toEqual([{ source: 'claude', paneKey: 'tab-1', payload: { hook_event_name: 'Stop', session_id: '한글 "따옴표" & %PATH%' } }])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

// execFileSync 는 curl 이 이 PC 에 있는지 한 번 확인하는 데만 쓴다(없으면 위 실행 시험이 실패 사유를 말하게).
it('curl 이 있다(훅 스크립트의 전제)', () => {
  const out = execFileSync(process.platform === 'win32' ? `${process.env['SystemRoot']}\\System32\\curl.exe` : 'curl', ['--version'], { encoding: 'utf8' })
  expect(out).toMatch(/^curl /)
})
