// M11 R2 — 터미널 공간 로컬 셸을 데몬에(terminalShells.ts + MainSessionManager.create)와 앱 재시작·업데이트 뒤 복원.
// 진짜 데몬(node)으로: 셸을 데몬에 만듦 → 앱 "종료"(destroyAll + disconnect) → 새 앱은 붙지 않고 세워 둠 → F6 복원이 옛 id 로 claim →
// 같은 id·pid·replay·입력이 이어짐 / 아무도 안 찾은 셸은 release 로 끔 / [백그라운드 에이전트 모두 종료]는 터미널 셸을 안 끔 /
// 판 올림(업데이트)에도 옛 데몬의 셸을 찾음 / 완전 종료 뒤 데몬 프로세스 0. Electron 은 안 띄운다.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentDaemon, type AgentDaemon } from '../src/main/daemon/service'
import { createTerminalDaemonHook, isTerminalInfo, terminalSessionOf } from '../src/main/daemon/terminalShells'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink } from '../src/main/sessions/ISessionManager'
import { pickColdTabs, readTabRecords } from '../src/main/agents/coldRestore'

const win = process.platform === 'win32'
let dir = ''
let entry = ''
const saved = { NODE_PATH: process.env['NODE_PATH'], PWSH: process.env['PWSH'], SHELL: process.env['SHELL'] }
const services: AgentDaemon[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-daemon-term-'))
  entry = join(dir, 'daemonEntry.cjs')
  await build({ entryPoints: ['src/main/daemon/daemonEntry.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['node-pty'], alias: { '@shared': './src/shared' }, logLevel: 'silent' })
  process.env['NODE_PATH'] = resolve('node_modules')
  if (win) process.env['PWSH'] = 'cmd.exe'
  else process.env['SHELL'] = '/bin/sh'
}, 60_000)

afterAll(async () => {
  for (const s of services) await s.shutdownAll().catch(() => {})
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 임시 폴더 */
  }
}, 30_000)

type App = { svc: AgentDaemon; mgr: MainSessionManager; out: Map<string, string>; exits: Map<string, number> }

/** 앱 하나 = 세션 관리자 + 데몬 관리(에이전트 feature 와 같은 adopt 갈래) + 터미널 훅. */
function app(runtimeDir: string, protocol?: { current: number; previous: readonly number[] }): App {
  const out = new Map<string, string>()
  const exits = new Map<string, number>()
  const sink: SessionSink = {
    data: (id, chunk) => out.set(id, (out.get(id) ?? '') + Buffer.from(chunk).toString('utf8')),
    exit: (id, code) => void exits.set(id, code),
    cwd: () => {}
  }
  const mgr = new MainSessionManager(sink)
  const svc = createAgentDaemon({
    runtimeDir,
    logFile: () => join(runtimeDir, 'daemon.log'),
    appVersion: 'test',
    runtime: async () => ({ execPath: process.execPath, entryPath: entry }),
    adopt: (backend, info) => void mgr.adopt(backend, isTerminalInfo(info) ? terminalSessionOf(info) : { type: 'local', title: 'agent', serverKey: 'localhost', profileId: null, space: 'ai' }, info.id),
    restored: () => {},
    isTerminal: isTerminalInfo,
    log: () => {},
    ...(protocol ? { protocol } : {})
  })
  services.push(svc)
  mgr.setLocalDaemon(createTerminalDaemonHook(svc, () => {}, 15_000))
  return { svc, mgr, out, exits }
}

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('기다리던 일이 안 일어남')
    await new Promise((r) => setTimeout(r, 50))
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const daemonPids = (rt: string): number[] => [...readFileSync(join(rt, 'daemon.log'), 'utf8').matchAll(/\[daemon (\d+)\] listening/g)].map((m) => Number(m[1]))
const pidOf = (a: App, id: string): number => a.mgr.ptyList().find((p) => p.id === id)!.pid!
const shell = (title: string) => ({ type: 'local' as const, title, serverKey: 'localhost', profileId: null, cwd: dir })
/** 렌더러처럼 붙어서 지금까지(replay 포함)를 받는다. */
const screen = (a: App, id: string): string => Buffer.from(a.mgr.attach(id)).toString('utf8') + (a.out.get(id) ?? '')

describe('터미널 로컬 셸 데몬 이전', () => {
  it('재시작: 데몬에 살아 있으면 옛 id 로 다시 붙음 · 안 찾은 셸은 끔 · 백그라운드 에이전트 종료는 셸을 안 끔 · 완전 종료 뒤 데몬 0', async () => {
    const rt = join(dir, 'restart')
    const first = app(rt)
    await first.svc.ready
    const keep = await first.mgr.create(shell('셸 1'))
    const orphan = await first.mgr.create(shell('셸 2'))
    expect(first.svc.owns(keep)).toBe(true) // 데몬에 산다
    expect(first.mgr.survivesQuit(keep)).toBe(true)
    // 에이전트 세션 하나(같은 데몬) — 모두 종료에서 이것만 끝나야 한다.
    await first.svc.create({ id: 'agent-1', cwd: dir, env: { ...(process.env as Record<string, string>) }, meta: { agent: 'claude', title: 'a' } })
    first.mgr.attach(keep)
    first.mgr.write(keep, 'echo before-restart\r')
    await until(() => (first.out.get(keep) ?? '').includes('before-restart'))
    const keepPid = pidOf(first, keep)
    const orphanPid = pidOf(first, orphan)
    first.mgr.destroyAll() // 앱 종료 — 데몬 셸은 놓는다
    first.svc.disconnect()
    expect(alive(keepPid)).toBe(true)

    const second = app(rt)
    await second.svc.ready
    expect(second.svc.found()).toBe(true)
    expect(second.mgr.has(keep)).toBe(false) // 붙지 않고 세워 둔다(화면이 자리를 정한다)
    expect(second.mgr.has('agent-1')).toBe(true) // 에이전트는 바로 붙는다(1차 그대로)
    expect(await second.svc.killAll()).toBe(1) // 에이전트만
    await until(() => second.exits.has('agent-1'))
    expect(alive(keepPid)).toBe(true)

    // F6 복원: 저장한 옛 id 로 — 새로 띄우지 않고 그 셸에 붙는다. 바뀐 이름은 화면 것이 이긴다.
    const back = await second.mgr.create({ ...shell('이름 바꾼 셸'), manualTitle: true, reattach: keep })
    expect(back).toBe(keep)
    expect(pidOf(second, keep)).toBe(keepPid)
    expect(second.mgr.snapshot().find((s) => s.id === keep)).toMatchObject({ title: '이름 바꾼 셸', manualTitle: true })
    await until(() => screen(second, keep).includes('before-restart')) // replay
    second.mgr.write(keep, 'echo after-restart\r')
    await until(() => (second.out.get(keep) ?? '').includes('after-restart'))

    // 없는 id 로 찾으면 지금처럼 새 셸.
    const fresh = await second.mgr.create({ ...shell('새 셸'), reattach: 'gone' })
    expect(fresh).not.toBe('gone')
    expect(second.svc.owns(fresh)).toBe(true)

    // 복원 끝 — 아무도 안 찾은 셸(orphan)은 끈다.
    expect(second.mgr.releaseParked()).toBe(1)
    await until(() => !alive(orphanPid))
    expect(second.mgr.releaseParked()).toBe(0)

    // 완전 종료 → 세션까지 끝나고 데몬이 내려간다(PC 에 남는 것 0).
    await second.svc.shutdownAll()
    await until(() => daemonPids(rt).every((p) => !alive(p)) && !alive(keepPid))
  }, 90_000)

  it('업데이트(판 올림): 옛 데몬의 셸을 그대로 찾고 새 셸은 새 데몬에 · 끝나면 둘 다 0', async () => {
    const rt = join(dir, 'upgrade')
    const v1 = app(rt)
    await v1.svc.ready
    const old = await v1.mgr.create(shell('옛 셸'))
    const oldPid = pidOf(v1, old)
    v1.mgr.destroyAll()
    v1.svc.disconnect()

    const v2 = app(rt, { current: 2, previous: [1] })
    await v2.svc.ready
    expect(await v2.mgr.create({ ...shell('옛 셸'), reattach: old })).toBe(old)
    expect(pidOf(v2, old)).toBe(oldPid)
    const neu = await v2.mgr.create(shell('새 셸'))
    expect(pidOf(v2, neu)).not.toBe(oldPid)
    expect(new Set(daemonPids(rt)).size).toBe(2) // 옛 데몬 + 새 판 데몬
    v2.mgr.destroy(old) // 옛 셸이 끝나면 옛 데몬은 스스로 내려간다(교체 끝)
    await until(() => !alive(daemonPids(rt)[0]))
    await v2.svc.shutdownAll()
    await until(() => daemonPids(rt).every((p) => !alive(p)))
  }, 90_000)

  it('데몬이 늦으면(상한 넘음) 앱 안 PTY 로 — 셸 열기가 막히지 않는다', async () => {
    const slow = { warm: () => new Promise<boolean>(() => {}), create: () => Promise.reject(new Error('부르면 안 됨')) } as unknown as AgentDaemon
    const hook = createTerminalDaemonHook(slow, () => {}, 30)
    expect(await hook.create(shell('x'), 'id-1')).toBe(false)
  })
})

describe('콜드 복원 판정(데몬째 죽음)', () => {
  const recs = readTabRecords({
    a: { agent: 'claude', cwd: 'C:\\w', title: 'A', line: 'claude', startedAt: 1 },
    b: { agent: 'codex', cwd: 'C:\\w', title: 'B', line: 'codex', startedAt: 2 },
    c: { agent: 'gemini', cwd: 'C:\\w', title: 'C', line: 'gemini', startedAt: 3, local: true },
    bad: { agent: 'nope', cwd: 'x', title: 'x' }
  })
  it('기록 읽기 — 모양이 틀린 것은 버린다', () => expect([...recs.keys()]).toEqual(['a', 'b', 'c']))
  it('데몬을 못 찾았다 = 살아 있지 않은 탭은 모두 되살린다(기록 순서)', () => {
    const r = pickColdTabs(recs, (id) => id === 'a', false)
    expect(r.cold.map((x) => x[0])).toEqual(['b', 'c'])
    expect(r.drop).toEqual([])
  })
  it('데몬은 살아 있다 = 없는 세션은 앱이 꺼진 사이 끝났다(버림). 앱 안 PTY 탭만 되살린다', () => {
    const r = pickColdTabs(recs, () => false, true)
    expect(r.cold.map((x) => x[0])).toEqual(['c'])
    expect(r.drop).toEqual(['a', 'b'])
  })
})
