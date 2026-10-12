// 2026-10-12 준영님 결정(대안): [AI 실행] 은 새 AI 세션을 띄우지 않고 **그 셸에 친다**.
// 지키는 것 셋: ① 어디에 칠까(셸이 놀고 있으면 그 셸, AI 가 돌면 새 탭) ② 치는 줄 = buildLaunch
// ③ AI 가 내려가도 작업대 줄은 그 셸을 잃지 않고 `쉬는 중` 이 된다.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiBusyIn, aiRuns, benchRunOf, forgetAiRun, forgetAiSession, planAiLaunch, registerAiRun } from '../src/renderer/store/aiSessions'
import { benchRows, groupRows } from '../src/renderer/store/aiWorkbench'
import { AI_CLI_LOCAL, buildLaunch } from '../src/shared/aiCli'
import { commandLine } from '../src/shared/shellInput'
import type { AgentStatus } from '../src/shared/agentStatus'
import type { AiSessionState } from '../src/shared/aiSession'

const L = AI_CLI_LOCAL
const local = { id: 's1', type: 'local' }
const ssh = { id: 's2', type: 'ssh', profileId: 'p1' }
const rdp = { id: 'rdp:p9:1', type: 'rdp', profileId: 'p9' }
const st = (sessionId: string, state: AgentStatus['state'] = 'working'): AgentStatus => ({
  sessionId,
  cli: 'claude',
  state,
  updatedAt: 1,
  stateStartedAt: 1
})

describe('planAiLaunch — 어디에 칠까', () => {
  it('놀고 있는 셸(로컬·SSH)이면 그 셸에 친다', () => {
    expect(planAiLaunch(local, undefined, false, L)).toEqual({ kind: 'type', sessionId: 's1', place: L })
    expect(planAiLaunch(ssh, undefined, false, L)).toEqual({ kind: 'type', sessionId: 's2', place: 'p1' })
    // 자리를 정해 줘도 후보가 그 자리면 그 셸이다(작업대 · 파일 화면).
    expect(planAiLaunch(ssh, 'p1', false, L)).toEqual({ kind: 'type', sessionId: 's2', place: 'p1' })
  })

  it('AI 가 돌고 있으면 같은 자리에 새 탭 — 질문 칸에 치지 않는다', () => {
    expect(planAiLaunch(local, undefined, true, L)).toEqual({ kind: 'newLocal', place: L })
    expect(planAiLaunch(ssh, undefined, true, L)).toEqual({ kind: 'newRemote', place: 'p1' })
  })

  it('다른 자리·RDP·후보 없음', () => {
    expect(planAiLaunch(local, 'p1', false, L)).toEqual({ kind: 'newRemote', place: 'p1' })
    expect(planAiLaunch(ssh, L, false, L)).toEqual({ kind: 'newLocal', place: L })
    expect(planAiLaunch(rdp, undefined, false, L)).toBeNull()
    expect(planAiLaunch(rdp, L, false, L)).toEqual({ kind: 'newLocal', place: L })
    expect(planAiLaunch(undefined, 'p1', false, L)).toEqual({ kind: 'newRemote', place: 'p1' })
    expect(planAiLaunch(undefined, undefined, false, L)).toBeNull()
  })
})

describe('aiBusyIn — 그 셸에서 AI 가 돈다고 아는가', () => {
  afterEach(() => {
    for (const r of aiRuns()) forgetAiRun(r.sessionId)
  })

  it('훅 상태가 있으면 돈다(`/clear` 뒤의 unverifiable 도)', () => {
    expect(aiBusyIn('s1', [], [st('s1')])).toBe(true)
    expect(aiBusyIn('s1', [], [st('s1', 'unverifiable')])).toBe(true)
    expect(aiBusyIn('s1', [], [st('s2')])).toBe(false)
  })

  it('우리가 띄운 기록은 내려갔다고 들을 때까지 돈다', () => {
    registerAiRun({ sessionId: 's1', cli: 'codex', path: 'D:/a', startedAt: 1 })
    expect(aiBusyIn('s1', aiRuns(), [])).toBe(true)
    forgetAiSession('s1')
    expect(aiBusyIn('s1', aiRuns(), [])).toBe(false)
  })
})

describe('치는 줄 = buildLaunch', () => {
  it('셸마다 문법이 다르다 — 플래그까지 그대로', () => {
    const o = { cli: 'claude' as const, flags: ['skipPerms'], path: 'D:/work/my app' }
    const ps = buildLaunch({ ...o, shell: 'powershell' })
    expect(ps).toMatch(/^Set-Location -LiteralPath .*; if \(\$\?\) \{ claude --dangerously-skip-permissions \}$/)
    expect(buildLaunch({ ...o, shell: 'cmd' })).toMatch(/^cd \/d .* && claude --dangerously-skip-permissions$/)
    expect(buildLaunch({ ...o, path: '~/x', shell: 'posix' })).toBe("cd ~/'x' && claude --dangerously-skip-permissions")
    // 줄을 비우고 친다(반쯤 친 명령 뒤에 이어붙지 않게).
    expect(commandLine(ps!)).toBe('\x05\x15' + ps + '\r')
  })

  it('Shell.runAiCliNow 는 그 한 줄을 그 셸에 친다 — 새 AI pty(command) 를 만들지 않는다', () => {
    const src = readFileSync(join(__dirname, '..', 'src/renderer/components/Shell.tsx'), 'utf8')
    const fn = src.slice(src.indexOf('const runAiCliNow = useCallback('), src.indexOf('runAiCliRef.current = runAiCliNow'))
    expect(fn).toMatch(/const line = buildLaunch\(\{ cli: engine, flags, path, shell \}\)/)
    expect(fn).toMatch(/window\.ev\?\.session\.input\(sid, commandLine\(line\)\)/)
    expect(fn).toMatch(/planAiLaunch\(/)
    expect(fn).not.toMatch(/command:/)
    expect(fn).not.toMatch(/aiCommandOf/)
  })
})

describe('작업대 줄은 AI 가 내려가도 그 셸을 잃지 않는다', () => {
  const bench: AiSessionState = {
    id: 'b1',
    kind: 'local',
    cwd: 'D:/work/app',
    engine: 'claude',
    skipPerms: false,
    title: 'app',
    lastUsedAt: 1
  }
  const alive = new Set(['pane-1'])
  const rows = (statuses: AgentStatus[]) =>
    benchRows([bench], {
      sessionOf: (b) => benchRunOf(b, aiRuns(), alive, statuses)?.sessionId ?? null,
      seen: () => null,
      serverOf: () => '로컬',
      pathExists: () => true,
      profileExists: () => false
    })

  afterEach(() => {
    for (const r of aiRuns()) forgetAiRun(r.sessionId)
  })

  it('돌 때는 그 셸, 내려가면 `쉬는 중` — 다시 띄울 자리는 여전히 그 셸', () => {
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: 1 })
    expect(rows([st('pane-1')])[0]!.sessionId).toBe('pane-1')

    forgetAiSession('pane-1') // Ctrl+C → SessionEnd(other) → onExit
    const after = rows([])
    expect(groupRows(after).map((g) => g.id)).toEqual(['idle'])
    expect(benchRunOf(bench, aiRuns(), alive)?.sessionId).toBe('pane-1')
  })

  it('셸까지 닫히면 다시 띄울 셸이 없다 → 새 탭', () => {
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: 1 })
    forgetAiSession('pane-1')
    expect(benchRunOf(bench, aiRuns(), new Set())).toBeUndefined()
  })
})
