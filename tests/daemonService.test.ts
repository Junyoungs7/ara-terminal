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

function app(runtimeDir: string): { svc: AgentDaemon; adopted: Map<string, Adopted>; restored: string[] } {
  const adopted = new Map<string, Adopted>()
  const restored: string[] = []
  const svc = createAgentDaemon({
    runtimeDir,
    logFile: () => join(runtimeDir, 'daemon.log'),
    appVersion: 'test',
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
})
