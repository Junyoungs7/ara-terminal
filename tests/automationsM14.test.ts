// M14 R1 — 예약 실행(AU-01) 서비스 규칙 · 스킬 관리(AU-02) · MCP 등록(AU-03).
// 🔴 실제 ~/.claude·~/.codex·~/.gemini 는 안 쓴다 — 임시 폴더를 홈·프로젝트로 준다. 정리는 removeAccountTree(링크를 따라가지 않는다)로만.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ dialog: {}, shell: {}, ipcMain: { handle: () => {} }, app: { getPath: () => tmpdir() } }))
vi.mock('../src/main/ipc/handle', () => ({ handle: () => {} }))

import { createAutomationService, missedBeyondGrace, pruneRuns, validateAutomationInput, AUTOMATION_FAILURE } from '../src/main/automations/service'
import { buildAutomationRrule } from '../src/shared/automations/automation-schedule-occurrences'
import type { AutomationDispatchRequest, AutomationInput, AutomationPrecheckResult, AutomationRun, AutomationsState } from '../src/shared/automations/automations-types'
import { addSkill, scanSkills, skillRoots } from '../src/main/skills/feature'
import { addMcpServer, listMcp, removeMcpServer } from '../src/main/mcpServers/feature'
import { codexTomlMcpServers } from '../src/shared/mcp/agentMcp'
import { removeAccountTree } from '../src/main/usage/accounts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-m14-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0).reverse()) removeAccountTree(d)
})
const put = (p: string, body: string): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

// ── AU-01 예약 실행 ──
const MIN = 60_000
function harness(opts: { renderer?: boolean; precheckExit?: number } = {}) {
  const ws = tmp()
  let t = new Date(2026, 10, 2, 8, 0, 0, 0).getTime() // 월요일 08:00
  let saved: AutomationsState = { automations: [], runs: [] }
  const sent: AutomationDispatchRequest[] = []
  const prechecks: string[] = []
  const svc = createAutomationService({
    load: () => saved,
    save: (s) => (saved = s),
    now: () => t,
    dispatch: (req) => {
      if (opts.renderer === false) return false
      sent.push(req)
      return true
    },
    runPrecheck: async (p): Promise<AutomationPrecheckResult> => {
      prechecks.push(p.command)
      const code = opts.precheckExit ?? 0
      return { command: p.command, exitCode: code, timedOut: false, durationMs: 1, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, error: null, startedAt: t, completedAt: t }
    }
  })
  const input = (p: Partial<AutomationInput> = {}): AutomationInput => ({
    name: '아침 정리',
    prompt: '이슈 정리',
    precheck: null,
    agentId: 'claude',
    projectId: 'p',
    workspaceId: 'w',
    workspacePath: ws,
    workspaceName: 'ws',
    rrule: buildAutomationRrule({ preset: 'weekdays', hour: 9, minute: 0 }),
    enabled: true,
    missedRunGraceMinutes: 720,
    ...p
  })
  return { svc, sent, prechecks, input, ws, at: (ms: number) => (t = ms), now: () => t, runs: (): AutomationRun[] => svc.state().runs }
}

describe('AU-01 예약 실행(Orca AutomationService 규칙)', () => {
  it('시각이 되면 한 번 띄우고 다음 칸으로 넘긴다 · 끝남은 일하는 중을 지나 멈출 때', async () => {
    const h = harness()
    const a = h.svc.create(h.input())
    expect(new Date(a.nextRunAt).getHours()).toBe(9)
    await h.svc.evaluateDueRuns()
    expect(h.sent).toHaveLength(0) // 아직 08:00
    h.at(a.nextRunAt + 10_000)
    await h.svc.evaluateDueRuns()
    await h.svc.evaluateDueRuns() // 같은 칸은 두 번 띄우지 않는다
    expect(h.sent).toHaveLength(1)
    expect(h.runs()[0]).toMatchObject({ status: 'dispatching', trigger: 'scheduled', runNumber: 1 })
    expect(h.svc.state().automations[0].nextRunAt).toBeGreaterThan(h.now())
    h.svc.markDispatchResult({ runId: h.runs()[0].id, status: 'dispatched', sessionId: 's1' })
    h.svc.observe('s1', false) // 일하기 전의 멈춤은 끝이 아니다
    expect(h.runs()[0].status).toBe('dispatched')
    h.svc.observe('s1', true)
    h.svc.observe('s1', false)
    expect(h.runs()[0].status).toBe('completed')
  })

  it('앱이 꺼져 있던 동안 놓친 예약: 유예 안이면 한 번 실행, 넘으면 놓침으로 남긴다(지난 칸을 몰아서 돌리지 않는다)', async () => {
    const h = harness()
    const a = h.svc.create(h.input({ missedRunGraceMinutes: 30 }))
    h.at(a.nextRunAt + 20 * MIN) // 09:20 에 켬
    await h.svc.evaluateDueRuns()
    expect(h.sent).toHaveLength(1)

    const g = harness()
    const b = g.svc.create(g.input({ missedRunGraceMinutes: 30 }))
    g.at(b.nextRunAt + 3 * 24 * 60 * MIN + 2 * 60 * MIN) // 사흘 뒤 11:00(마지막 칸도 유예 30분을 넘김)
    await g.svc.evaluateDueRuns()
    expect(g.sent).toHaveLength(0)
    expect(g.runs()).toHaveLength(1)
    expect(g.runs()[0]).toMatchObject({ status: 'skipped_missed', error: AUTOMATION_FAILURE.missedGraceWindow })
  })

  it('missedBeyondGrace — 유예 + 틱 두 번의 흔들림까지 받는다(PC 절전도 경과 시간으로)', () => {
    expect(missedBeyondGrace({ missedRunGraceMinutes: 0 }, 0, 2 * MIN, MIN)).toBe(false)
    expect(missedBeyondGrace({ missedRunGraceMinutes: 0 }, 0, 2 * MIN + 1, MIN)).toBe(true)
  })

  it('사전 점검: 예약 실행만 돌리고 0 이 아니면 건너뜀 · [지금 실행]은 건너뛴다', async () => {
    const h = harness({ precheckExit: 1 })
    const a = h.svc.create(h.input({ precheck: { command: 'exit 1', timeoutSeconds: 60 } }))
    h.at(a.nextRunAt + 1000)
    await h.svc.evaluateDueRuns()
    expect(h.prechecks).toEqual(['exit 1'])
    expect(h.sent).toHaveLength(0)
    expect(h.runs()[0].status).toBe('skipped_precheck')
    await h.svc.runNow(a.id)
    expect(h.prechecks).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].run.trigger).toBe('manual')
  })

  it('받을 창이 없으면 건너뜀, 폴더가 없으면 건너뜀, 끈 것은 안 돈다', async () => {
    const h = harness({ renderer: false })
    const a = h.svc.create(h.input())
    await h.svc.runNow(a.id)
    expect(h.runs()[0]).toMatchObject({ status: 'skipped_unavailable', error: AUTOMATION_FAILURE.noDispatchHost })

    const g = harness()
    const b = g.svc.create(g.input({ workspacePath: join(g.ws, 'gone') }))
    await g.svc.runNow(b.id)
    expect(g.runs()[0]).toMatchObject({ status: 'skipped_unavailable', error: AUTOMATION_FAILURE.targetMissing })

    const k = harness()
    const c = k.svc.create(k.input({ enabled: false }))
    k.at(c.nextRunAt + 1000)
    await k.svc.evaluateDueRuns()
    expect(k.runs()).toHaveLength(0)
  })

  it('지우면 이력도 지운다 · 이력은 끝난 것만 상한까지 남긴다', () => {
    const h = harness()
    const a = h.svc.create(h.input())
    h.svc.remove(a.id)
    expect(h.svc.state()).toEqual({ automations: [], runs: [] })
    const run = (i: number, status: AutomationRun['status']): AutomationRun => ({ id: String(i), automationId: 'a', title: '', scheduledFor: i, status, trigger: 'manual', workspaceId: null, workspaceDisplayName: null, sessionId: null, precheckResult: null, error: null, startedAt: null, dispatchedAt: null, completedAt: null, createdAt: i, runNumber: i })
    const kept = pruneRuns([run(1, 'completed'), run(2, 'dispatched'), run(3, 'completed'), run(4, 'completed')], 2)
    expect(kept.map((r) => r.id)).toEqual(['2', '3', '4'])
  })

  it('입력 거르기 — 잘못된 예약·빈 지시는 거절', () => {
    const h = harness()
    expect(validateAutomationInput(h.input()).ok).toBe(true)
    expect(validateAutomationInput(h.input({ rrule: '61 * * * *' })).ok).toBe(false)
    expect(validateAutomationInput(h.input({ prompt: ' ' })).ok).toBe(false)
  })
})

// ── AU-02 스킬 ──
describe('AU-02 스킬 관리', () => {
  it('세 에이전트 홈·플러그인·프로젝트 뿌리에서 SKILL.md 를 찾는다(이름·설명은 머리말)', async () => {
    const home = tmp()
    const proj = tmp()
    put(join(home, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: alpha\ndescription: 첫 스킬\n---\n# A')
    put(join(home, '.agents', 'skills', 'b', 'SKILL.md'), '# B')
    put(join(home, '.gemini', 'skills', 'c', 'SKILL.md'), '# C')
    put(join(home, '.claude', 'plugins', 'cache', 'x', 'skills', 'p', 'SKILL.md'), '# P')
    put(join(proj, '.claude', 'skills', 'r', 'SKILL.md'), '# R')
    const s = await scanSkills(skillRoots(home, {}, [proj]))
    const by = Object.fromEntries(s.skills.map((x) => [x.name, x]))
    expect(Object.keys(by).sort()).toEqual(['alpha', 'b', 'c', 'p', 'r'])
    expect(by['alpha']).toMatchObject({ description: '첫 스킬', agents: ['claude'], sourceKind: 'home' })
    expect(by['b'].agents).toEqual(['codex', 'gemini'])
    expect(by['p'].sourceKind).toBe('plugin')
    expect(by['r'].sourceKind).toBe('repo')
  })

  it('링크 표시: 링크인 스킬 폴더는 linkTarget, 링크된 뿌리 안은 realPath(양성 대조 — 링크 없으면 둘 다 null)', async () => {
    const home = tmp()
    const elsewhere = tmp()
    put(join(elsewhere, 'shared', 'SKILL.md'), '# S')
    put(join(home, '.claude', 'skills', 'plain', 'SKILL.md'), '# plain')
    symlinkSync(join(elsewhere, 'shared'), join(home, '.claude', 'skills', 'shared'), 'junction')
    // ~/.gemini/skills 자체가 다른 곳으로 가는 링크
    put(join(elsewhere, 'gem', 'g', 'SKILL.md'), '# G')
    mkdirSync(join(home, '.gemini'), { recursive: true })
    symlinkSync(join(elsewhere, 'gem'), join(home, '.gemini', 'skills'), 'junction')
    const s = await scanSkills(skillRoots(home, {}, []))
    const by = Object.fromEntries(s.skills.map((x) => [x.name, x]))
    expect(by['plain']).toMatchObject({ linkTarget: null, realPath: null })
    expect(by['shared'].linkTarget).toBeTruthy()
    expect(by['G'.toLowerCase()] ?? by['g']).toBeTruthy()
    expect((by['g'] ?? by['G']).realPath).toBeTruthy()
    expect(s.roots.find((r) => r.id === 'home-gemini')?.realPath).toBeTruthy()
  })

  it('추가: SKILL.md 있는 폴더만, 같은 이름이면 거절(덮어쓰지 않음)', async () => {
    const home = tmp()
    const src = tmp()
    put(join(src, 'mine', 'SKILL.md'), '# mine')
    const roots = skillRoots(home, {}, [])
    expect(await addSkill(roots, join(src, 'mine'), 'home-claude')).toMatchObject({ ok: true })
    expect(readFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('# mine')
    expect(await addSkill(roots, join(src, 'mine'), 'home-claude')).toMatchObject({ ok: false })
    expect(await addSkill(roots, src, 'home-claude')).toMatchObject({ ok: false }) // SKILL.md 없음
    expect(await addSkill(roots, join(src, 'mine'), 'plugin-claude')).toMatchObject({ ok: false }) // 추가 자리 아님
  })

  it('지우기의 링크 규칙: 링크인 스킬 폴더는 링크만 끊고 원본은 남는다(removeAccountTree)', () => {
    const home = tmp()
    const elsewhere = tmp()
    put(join(elsewhere, 'shared', 'SKILL.md'), '# S')
    const link = join(home, 'shared')
    symlinkSync(join(elsewhere, 'shared'), link, 'junction')
    removeAccountTree(link)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(elsewhere, 'shared', 'SKILL.md'))).toBe(true)
  })
})

// ── AU-03 MCP ──
describe('AU-03 MCP 등록', () => {
  it('사용자 설정 3종을 읽고(쓰지 않음) 프로젝트 후보를 살핀다 · Oriel 은 아라가 붙임', async () => {
    const home = tmp()
    const proj = tmp()
    put(join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxx' } } }, other: 1 }))
    put(join(home, '.codex', 'config.toml'), 'model = "x"\n[mcp_servers.docs]\ncommand = "docs-mcp"\n[mcp_servers."web"]\nurl = "https://e.x/mcp"\nenabled = false\n[other]\nurl = "no"\n')
    put(join(home, '.gemini', 'settings.json'), '{ broken')
    put(join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { c: { command: 'c' } } }))
    const before = readFileSync(join(home, '.claude.json'), 'utf8')
    const v = await listMcp({ home, env: {}, project: proj, orielOn: true })
    const src = Object.fromEntries(v.sources.map((s) => [s.label, s]))
    expect(src['Claude (사용자)'].servers[0]).toMatchObject({ name: 'gh', transport: 'stdio', env: { GITHUB_TOKEN: '••••••••' } })
    expect(src['Codex (사용자)'].servers.map((s) => [s.name, s.status])).toEqual([
      ['docs', 'enabled'],
      ['web', 'disabled']
    ])
    expect(src['Gemini (사용자)'].status).toBe('invalid')
    expect(src['.cursor/mcp.json'].servers[0].name).toBe('c')
    expect(src['.mcp.json'].exists).toBe(false)
    expect(v.attached.every((a) => a.name === 'oriel' && a.on)).toBe(true)
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(before)
  })

  it('프로젝트 .mcp.json 에 추가·지우기 — 같은 이름 거절, 깨진 JSON 은 건드리지 않음', async () => {
    const proj = tmp()
    expect(await addMcpServer(proj, { name: 'fs', command: 'npx', args: ['-y', 'server-fs'] })).toEqual({ ok: true })
    expect(await addMcpServer(proj, { name: 'web', url: 'https://e.x/mcp' })).toEqual({ ok: true })
    expect(await addMcpServer(proj, { name: 'fs', command: 'x' })).toMatchObject({ ok: false })
    expect(await addMcpServer(proj, { name: 'both', command: 'x', url: 'https://e' })).toMatchObject({ ok: false })
    expect(JSON.parse(readFileSync(join(proj, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] }, web: { type: 'http', url: 'https://e.x/mcp' } } })
    expect(await removeMcpServer(proj, 'fs')).toEqual({ ok: true })
    expect(Object.keys(JSON.parse(readFileSync(join(proj, '.mcp.json'), 'utf8')).mcpServers)).toEqual(['web'])
    writeFileSync(join(proj, '.mcp.json'), '{ nope')
    expect(await removeMcpServer(proj, 'web')).toMatchObject({ ok: false })
    expect(readFileSync(join(proj, '.mcp.json'), 'utf8')).toBe('{ nope')
  })

  it('codexTomlMcpServers — 다른 표의 키는 섞지 않는다', () => {
    expect(codexTomlMcpServers('[mcp_servers.a]\ncommand = "x"\n[b]\ncommand = "y"\n')).toEqual({ a: { command: 'x' } })
  })
})
