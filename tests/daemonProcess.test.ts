// M4 DM-01 — 데몬을 **node 로 실제로 띄워** 본다(Electron 은 안 띄움). 끝나면 반드시 죽이고 임시 폴더·소켓을 치운다.
// 본다: 토큰이 틀리면 거절 · 세션 만들기 → 앱 연결을 끊어도 산다 → 다시 붙으면 같은 id·pid · 최근 출력이 replay 된다
// · 세션이 다 끝나고 붙은 앱도 없으면 스스로 내려간다 · shutdown 은 세션까지 끝내고 내려간다.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { constants, getPriority, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectDaemon, type DaemonConnection } from '../src/main/daemon/client'
import { daemonPaths, type DaemonEvent, type DaemonSessionInfo } from '../src/main/daemon/protocol'

const win = process.platform === 'win32'
let dir = ''
let entry = ''
const children: ChildProcess[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-daemon-test-'))
  entry = join(dir, 'daemonEntry.cjs')
  await build({
    entryPoints: ['src/main/daemon/daemonEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry,
    external: ['node-pty'],
    alias: { '@shared': './src/shared' },
    logLevel: 'silent'
  })
}, 60_000)

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 파이프·로그가 잠깐 잡혀 있을 수 있다 — 임시 폴더라 남아도 무해 */
  }
})

/** 데몬 하나를 node 로 띄우고 ready 를 기다린다. 셸은 가벼운 것(cmd / sh)으로 — PtyBackend 의 셸 고르기 규칙(PWSH·SHELL env)을 그대로 탄다. */
async function startDaemon(name: string, extra: string[] = []): Promise<{ child: ChildProcess; socketPath: string; token: string; exited: Promise<number | null> }> {
  const runtime = join(dir, name)
  const { socketPath, tokenPath } = daemonPaths(runtime)
  const token = `t-${name}-${Math.random().toString(36).slice(2)}`
  mkdirSync(runtime, { recursive: true })
  writeFileSync(tokenPath, token, { mode: 0o600 })
  // 임시 폴더의 번들이 저장소의 node-pty 를 찾게(앱에선 node_modules 옆에 놓인다).
  const env = { ...process.env, NODE_PATH: resolve('node_modules'), ...(win ? { PWSH: 'cmd.exe' } : { SHELL: '/bin/sh' }) }
  const child = spawn(process.execPath, [entry, '--socket', socketPath, '--token', tokenPath, '--log', join(runtime, 'daemon.log'), '--app-version', 'test', ...extra], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.push(child)
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon ready 시간 초과')), 15_000)
    child.stdout!.on('data', (b: Buffer) => {
      if (b.toString().includes('ready')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.once('exit', (code) => reject(new Error(`daemon 이 먼저 끝남 ${code}`)))
  })
  return { child, socketPath, token, exited }
}

function collect(conn: DaemonConnection, id: string): { text: () => string; exit: Promise<DaemonEvent> } {
  let text = ''
  let onExit!: (e: DaemonEvent) => void
  const exit = new Promise<DaemonEvent>((r) => (onExit = r))
  conn.onEvent((e) => {
    if (e.id !== id) return
    if (e.type === 'data') text += e.data
    else onExit(e)
  })
  return { text: () => text, exit }
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('기다리던 일이 안 일어남')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('데몬 프로세스(node)', () => {
  it('토큰이 틀리면 붙지 못한다 · 없는 소켓은 null', async () => {
    const d = await startDaemon('auth')
    await expect(connectDaemon(d.socketPath, 'wrong')).rejects.toThrow(/거절/)
    expect(await connectDaemon(daemonPaths(join(dir, 'nobody')).socketPath, 'x')).toBeNull()
    // 붙은 앱도 세션도 없으니 shutdown 으로 내린다.
    const c = (await connectDaemon(d.socketPath, d.token))!
    void c.request({ type: 'shutdown' }).catch(() => {})
    expect(await d.exited).toBe(0)
  }, 30_000)

  it('앱 연결이 끊겨도 세션이 살고, 다시 붙으면 같은 pid·최근 출력이 이어진다 · 다 끝나면 스스로 내려간다', async () => {
    const d = await startDaemon('life')
    const a = (await connectDaemon(d.socketPath, d.token))!
    expect(a.hello.protocol).toBe(1)
    const info = await a.request<DaemonSessionInfo>({ type: 'create', spec: { id: 's1', cwd: dir, cols: 100, rows: 30, env: {}, meta: { agent: 'claude', worktreeId: 'w1' } } })
    expect(info.pid).toBeGreaterThan(0)
    const first = collect(a, 's1')
    await a.request({ type: 'attach', id: 's1' })
    a.fire({ type: 'write', id: 's1', data: 'echo hello-daemon-1\r' })
    await until(() => first.text().includes('hello-daemon-1'))
    a.close() // 앱 종료

    await new Promise((r) => setTimeout(r, 300))
    expect(d.child.exitCode).toBeNull() // 세션이 있으니 산다

    const b = (await connectDaemon(d.socketPath, d.token))!
    const list = await b.request<DaemonSessionInfo[]>({ type: 'list' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 's1', pid: info.pid, meta: { agent: 'claude', worktreeId: 'w1' } })
    const again = collect(b, 's1')
    await b.request({ type: 'attach', id: 's1' })
    await until(() => again.text().includes('hello-daemon-1')) // replay
    b.fire({ type: 'write', id: 's1', data: 'echo hello-daemon-2\r' })
    await until(() => again.text().includes('hello-daemon-2'))

    await b.request({ type: 'kill', id: 's1' })
    const ex = await again.exit
    expect(ex.type).toBe('exit')
    // 세션 0 — 앱이 붙어 있는 동안은 산다(곧 새 에이전트를 띄울 수 있다).
    await new Promise((r) => setTimeout(r, 200))
    expect(d.child.exitCode).toBeNull()
    b.close()
    expect(await d.exited).toBe(0)
  }, 60_000)

  it('--exit-with-clients(e2e 용): 앱이 떠나면 세션째 내려간다', async () => {
    const d = await startDaemon('e2e', ['--exit-with-clients'])
    const a = (await connectDaemon(d.socketPath, d.token))!
    await a.request({ type: 'create', spec: { id: 'e1', cwd: dir, env: {}, meta: {} } })
    a.close()
    expect(await d.exited).toBe(0)
  }, 30_000)

  it('shutdown 은 세션까지 끝내고 내려간다(완전 종료)', async () => {
    const d = await startDaemon('quit')
    const a = (await connectDaemon(d.socketPath, d.token))!
    await a.request({ type: 'create', spec: { id: 'q1', cwd: dir, env: {}, meta: {} } })
    await a.request({ type: 'create', spec: { id: 'q2', cwd: dir, env: {}, meta: {} } })
    let exits = 0
    a.onEvent((e) => void (e.type === 'exit' && exits++))
    expect(await a.request<number>({ type: 'killAll' })).toBe(2)
    await until(() => exits === 2)
    expect(await a.request<DaemonSessionInfo[]>({ type: 'list' })).toEqual([])
    await a.request({ type: 'create', spec: { id: 'q3', cwd: dir, env: {}, meta: {} } })
    void a.request({ type: 'shutdown' }).catch(() => {})
    expect(await d.exited).toBe(0)
  }, 60_000)

  it('M4 R3 자원 상한: 낮은 우선순위는 만들 때 셸에 걸린다 · 메모리 상한을 넘으면 넘어설 때 한 번만 알린다', async () => {
    const d = await startDaemon('caps', ['--sample-ms', '150'])
    const a = (await connectDaemon(d.socketPath, d.token))!
    const overs: DaemonEvent[] = []
    a.onEvent((e) => void (e.type === 'memoryOver' && overs.push(e)))
    // 상한 1바이트 — 셸 하나로도 넘는다.
    await a.request({ type: 'limits', limits: { lowPriority: true, memoryBytes: 1 } })
    const info = await a.request<DaemonSessionInfo>({ type: 'create', spec: { id: 'c1', cwd: dir, env: {}, meta: {} } })
    expect(getPriority(info.pid)).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
    await until(() => overs.length > 0, 20_000)
    // 표본이 여러 번 더 돌아도(150ms × 여럿) 같은 세션은 다시 안 알린다.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(overs).toHaveLength(1)
    expect(overs[0]).toMatchObject({ type: 'memoryOver', id: 'c1', limit: 1 })
    expect((overs[0] as { memory: number }).memory).toBeGreaterThan(1)

    // 끄면 그 뒤에 만드는 세션은 보통 우선순위 · 상한 0 이면 표본이 멈춘다(알림도 없다).
    await a.request({ type: 'limits', limits: { lowPriority: false, memoryBytes: 0 } })
    const plain = await a.request<DaemonSessionInfo>({ type: 'create', spec: { id: 'c2', cwd: dir, env: {}, meta: {} } })
    // 끄면 우선순위를 건드리지 않는다 = 부모(이 시험 프로세스)의 것을 물려받는다. 아라 에이전트 탭 안에서 돌리면 부모가 이미 낮음(10)이라 0 이 아니다.
    expect(getPriority(plain.pid)).toBe(getPriority())
    await new Promise((r) => setTimeout(r, 600))
    expect(overs).toHaveLength(1)
    void a.request({ type: 'shutdown' }).catch(() => {})
    expect(await d.exited).toBe(0)
  }, 60_000)
})
