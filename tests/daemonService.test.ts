// M4 DM-01 — 앱 쪽 데몬 관리(service.ts)를 진짜 데몬(node)으로: 없으면 띄움 → 세션 → 앱 "종료"(disconnect) → 새 앱이 켜지며 같은 id·pid 로
// 되살림(replay 포함) → 데몬 강제 종료 → 세션은 '잃음' 코드로 끝나고 데몬을 다시 띄운다. Electron 은 안 띄운다. 끝나면 데몬을 내린다.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentDaemon, type AgentDaemon } from '../src/main/daemon/service'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'
import type { DaemonSessionInfo } from '../src/main/daemon/protocol'
import { AGENT_SESSION_LOST_EXIT } from '../src/shared/agentHooks'

const win = process.platform === 'win32'
let dir = ''
let entry = ''
const saved = { NODE_PATH: process.env['NODE_PATH'], PWSH: process.env['PWSH'], SHELL: process.env['SHELL'] }
const services: AgentDaemon[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-daemon-svc-'))
  entry = join(dir, 'daemonEntry.cjs')
  await build({ entryPoints: ['src/main/daemon/daemonEntry.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: entry, external: ['node-pty'], alias: { '@shared': './src/shared' }, logLevel: 'silent' })
  // 데몬은 앱 환경을 물려받는다 — 번들이 node-pty 를 찾고 셸은 가벼운 것으로.
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
    /* 임시 폴더 — 남아도 무해 */
  }
}, 30_000)

type Adopted = { backend: SessionBackend; info: DaemonSessionInfo; text: string; exit: number | null }

type AppOpts = Pick<Parameters<typeof createAgentDaemon>[0], 'limits' | 'memoryOver' | 'protocol'> & { appVersion?: string }

function app(runtimeDir: string, o: AppOpts = {}): { svc: AgentDaemon; adopted: Map<string, Adopted>; restored: string[] } {
  const adopted = new Map<string, Adopted>()
  const restored: string[] = []
  const svc = createAgentDaemon({
    ...o,
    runtimeDir,
    logFile: () => join(runtimeDir, 'daemon.log'),
    appVersion: o.appVersion ?? 'test',
    runtime: async () => ({ execPath: process.execPath, entryPath: entry }),
    adopt: (backend, info) => {
      const a: Adopted = { backend, info, text: '', exit: null }
      adopted.set(info.id, a)
      backend.onData((d) => (a.text += d))
      backend.onExit((code) => (a.exit = code))
    },
    restored: (info) => restored.push(info.id),
    log: () => {}
  })
  services.push(svc)
  return { svc, adopted, restored }
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

const daemonPid = (runtimeDir: string): number => {
  const m = [...readFileSync(join(runtimeDir, 'daemon.log'), 'utf8').matchAll(/\[daemon (\d+)\] listening/g)].pop()
  return Number(m?.[1])
}

describe('데몬 관리(service)', () => {
  it('없으면 띄움 → 앱 재시작 뒤 같은 세션 되살림(replay) → 데몬이 죽으면 잃음으로 끝내고 다시 띄움', async () => {
    const rt = join(dir, 'rt')
    const first = app(rt)
    await first.svc.ready
    const info = await first.svc.create({ id: 'agent-1', cwd: dir, env: { ...(process.env as Record<string, string>) }, meta: { agent: 'claude', title: 'Claude Code · x' } })
    const a = first.adopted.get('agent-1')!
    expect(first.svc.owns('agent-1')).toBe(true)
    a.backend.write('echo before-restart\r')
    await until(() => a.text.includes('before-restart'))
    first.svc.disconnect() // 앱 종료 — 세션은 산다

    const second = app(rt)
    await second.svc.ready
    expect(second.restored).toEqual(['agent-1'])
    const b = second.adopted.get('agent-1')!
    expect(b.info.pid).toBe(info.pid)
    expect(b.info.meta).toMatchObject({ agent: 'claude' })
    await until(() => b.text.includes('before-restart')) // replay
    b.backend.write('echo after-restart\r')
    await until(() => b.text.includes('after-restart'))

    // 데몬 강제 종료 → 앱이 알아챈다: 세션은 잃음, 데몬은 다시 뜬다.
    const pid = daemonPid(rt)
    process.kill(pid)
    await until(() => b.exit !== null)
    expect(b.exit).toBe(AGENT_SESSION_LOST_EXIT)
    await until(() => daemonPid(rt) !== pid)
    const again = await second.svc.create({ id: 'agent-2', cwd: dir, env: {}, meta: {} })
    expect(again.pid).toBeGreaterThan(0)
    await second.svc.shutdownAll()
  }, 90_000)

  /**
   * M4 R3 업데이트 흐름 — 판이 바뀌었을 때(Orca 규칙):
   *  ① 앱 판만 올랐다(같은 protocol) → 살아 있는 데몬을 그대로 쓴다(같은 데몬 pid·같은 세션) + 상한을 보낸다(메모리 넘음이 앱까지 온다)
   *  ② 이 앱이 아는 옛 protocol → 옛 세션은 이어 쓰고 새 세션은 새 데몬에서, 옛 세션이 끝나면 옛 데몬은 스스로 내려간다(교체)
   *  ③ 모르는 protocol → 건드리지 않는다(세션을 가져오지도 끄지도 않는다)
   * protocol 숫자는 deps.protocol 로 흉내 낸다(데몬 바이너리는 하나 — 판 올림 = 앱이 기대하는 판이 바뀐 것).
   */
  it('판 올림: 같은 protocol 은 유지 · 아는 옛 판은 세션 끝난 뒤 교체 · 모르는 판은 무시', async () => {
    const rt = join(dir, 'upgrade')
    const v1 = app(rt, { appVersion: '2.2.0' })
    await v1.svc.ready
    const old = await v1.svc.create({ id: 'u-old', cwd: dir, env: { ...(process.env as Record<string, string>) }, meta: { agent: 'claude', title: 'old' } })
    const oldDaemon = daemonPid(rt)
    v1.svc.disconnect() // 업데이트로 앱이 꺼진다 — 데몬·세션은 산다

    // ① 앱 판만 오른 새 앱(2.2.1): 같은 데몬에 다시 붙는다. 상한 1바이트 → 표본(10초) 뒤 넘음이 앱까지 온다.
    const overs: string[] = []
    const v2 = app(rt, { appVersion: '2.2.1', limits: () => ({ lowPriority: true, memoryBytes: 1 }), memoryOver: (e) => overs.push(e.id) })
    await v2.svc.ready
    expect(v2.restored).toEqual(['u-old'])
    expect(v2.adopted.get('u-old')!.info.pid).toBe(old.pid)
    expect(daemonPid(rt)).toBe(oldDaemon)
    await until(() => overs.length > 0, 30_000)
    expect(overs).toEqual(['u-old'])
    v2.svc.disconnect()

    // ② protocol 2 앱(옛 판 1 을 안다): 옛 세션은 drain 으로 이어 쓰고, 새 세션은 v2 자리의 새 데몬에서.
    const v3 = app(rt, { protocol: { current: 2, previous: [1] } })
    await v3.svc.ready
    expect(v3.restored).toEqual(['u-old'])
    const fresh = await v3.svc.create({ id: 'u-new', cwd: dir, env: { ...(process.env as Record<string, string>) }, meta: {} })
    const newDaemon = daemonPid(rt)
    expect(newDaemon).not.toBe(oldDaemon)
    expect(fresh.pid).not.toBe(old.pid)
    expect(alive(oldDaemon)).toBe(true) // 옛 세션이 남아 있는 동안은 산다
    const oldTab = v3.adopted.get('u-old')!
    oldTab.backend.kill()
    await until(() => oldTab.exit !== null)
    await until(() => !alive(oldDaemon), 15_000) // 세션도 붙은 앱도 없다 → 스스로 내려간다(교체 끝)
    expect(alive(newDaemon)).toBe(true)

    // ③ 모르는 판: protocol 2 만 아는 앱이 v2 자리에서 protocol 1 이라고 답하는 데몬을 만난다 → 무시(세션을 가져오지도 끄지도 않는다).
    const v4 = app(rt, { protocol: { current: 2, previous: [] } })
    await v4.svc.ready
    expect(v4.restored).toEqual([])
    const newTab = v3.adopted.get('u-new')!
    newTab.backend.write('echo still-here\r')
    await until(() => newTab.text.includes('still-here'))
    expect(newTab.exit).toBeNull()

    await v3.svc.shutdownAll()
    await until(() => !alive(newDaemon), 15_000)
  }, 120_000)
})
