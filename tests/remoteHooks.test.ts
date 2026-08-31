// F1b 원격 훅 — 역터널(forwardIn)과 SFTP 설치를 ssh2 하네스로 끝까지 태운다.
//
// 여기서 증명하는 것 셋:
//  ① 세션이 붙을 때(AI 를 띄울 때가 아니라) 원격 설정이 병합되고, 그 셸에 env 가 실려 간다
//  ② 그 터널로 들어온 POST 가 **같은 훅 서버**에 닿아 그 탭의 상태가 된다
//  ③ 토큰은 서버마다 다르고, 세션이 끝나면 그 열쇠도 같이 사라진다
//
// ⚠️ 준영님 실제 서버에는 붙지 않는다 — 전부 인프로세스 하네스다(tests/ssh-harness.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'ssh2'
import { connectSsh } from '../src/main/sessions/ssh/SshBackend'
import { createAgentHookServer, type AgentHookServerHandle } from '../src/main/agent/AgentHookServer'
import { prepareRemoteHooks } from '../src/main/agent/remoteHooks'
import { HOOK_MARK, HOOK_PANE_HEADER, HOOK_TOKEN_HEADER, tokenInSettings } from '../src/main/agent/claudeHooks'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { AgentStatus } from '../src/shared/agentStatus'
import type { SshProfile } from '../src/shared/types'
import type { SshBackend } from '../src/main/sessions/ssh/SshBackend'

const harnesses: Harness[] = []
const servers: AgentHookServerHandle[] = []
const dirs: string[] = []
const backends: SshBackend[] = []

afterEach(async () => {
  for (const b of backends.splice(0)) b.kill()
  for (const h of harnesses.splice(0)) await h.close()
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 원격 홈이 될 임시 폴더. `withClaude` 면 Claude Code 가 깔린 서버다(`~/.claude` 가 있다). */
const tmp = (withClaude = true): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-rhook-'))
  dirs.push(d)
  if (withClaude) mkdirSync(join(d, '.claude'), { recursive: true })
  return d
}

const wait = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 만족되지 않았습니다')
    await wait(10)
  }
}

function pwProfile(port: number): SshProfile {
  return {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
}

async function hookServer(token = 'local-token'): Promise<{ server: AgentHookServerHandle; pushed: AgentStatus[] }> {
  const pushed: AgentStatus[] = []
  const server = createAgentHookServer({ token, onStatus: (s) => void pushed.push(s), bindPort: 0 })
  servers.push(server)
  expect(await server.start()).toBeGreaterThan(0)
  return { server, pushed }
}

/** 하네스에 접속한다. hooks 를 주면 제품 경로 그대로(셸 요청에 env 가 실린다). */
async function connect(h: Harness, hooks?: { sink: AgentHookServerHandle; paneId: string }): Promise<Client> {
  const res = await connectSsh(pwProfile(h.port), {
    knownHosts: {},
    secret: h.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {},
    ...(hooks ? { hooks } : {})
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  backends.push(res.backend)
  return res.backend.sshClient()
}

const settingsPath = (root: string): string => join(root, '.claude', 'settings.json')
const readSettings = (root: string): { hooks?: Record<string, { hooks: { command: string }[] }[]> } =>
  JSON.parse(readFileSync(settingsPath(root), 'utf8'))

/**
 * 설치가 **끝난** 설정을 읽는다. `prepareRemoteHooks()` 를 직접 부르는 검사들은 그 반환값
 * (`installed`)으로 완료를 알지만, 접속만으로 심기는 경로에는 그 손잡이가 없다.
 *
 * ⚠️ 파일이 **생긴 것**을 기다리면 안 된다 — SFTP OPEN 이 `openSync(rp, 'w')` 로 0바이트 파일을
 * 먼저 만들고(tests/sftp-harness.ts) WRITE 는 다음 바퀴에 온다. 그 틈에 읽으면 빈 파일이라
 * `JSON.parse` 가 "Unexpected end of JSON input" 으로 터진다.
 * (#159 실측: 이 파일 단독 60회 중 2회, 스위트 전체 20회 중 1회.)
 */
async function installedSettings(root: string): Promise<ReturnType<typeof readSettings>> {
  await waitFor(() => {
    try {
      return !!readSettings(root).hooks?.Stop
    } catch {
      return false // 아직 없거나(ENOENT) 쓰는 중(빈 파일)
    }
  })
  return readSettings(root)
}

/** 역터널로 들어온 척 HTTP 를 한 번 보낸다 — 훅의 curl 이 원격에서 하는 그 일이다. */
async function postThroughTunnel(
  h: Harness,
  event: string,
  headers: Record<string, string>,
  body = '{}'
): Promise<string> {
  const ch = await h.openForwarded()
  let out = ''
  ch.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`)
  ch.write(
    `POST /hook/claude/${event} HTTP/1.1\r\nhost: 127.0.0.1\r\n${lines.join('\r\n')}\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  )
  await waitFor(() => out.includes('\r\n'))
  ch.end()
  return out.split('\r\n')[0] ?? ''
}

describe('F1b 원격 훅 — 세션이 붙을 때 심고, 터널로 듣는다', () => {
  it('접속만으로 원격 설정이 병합되고 셸 env 에 포트·탭이 실린다', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()

    await connect(h, { sink: server, paneId: 'pane-remote-1' })

    // ① env — 훅 명령이 읽는 두 값이 **그 셸**로 갔다(사용자가 직접 친 claude 도 물려받는다).
    expect(h.forwardedPort()).toBeGreaterThan(0)
    expect(h.shellEnv['ARA_HOOK_PORT']).toBe(String(h.forwardedPort()))
    expect(h.shellEnv['ARA_PANE']).toBe('pane-remote-1')
    // ② 설치 — AI 를 띄우지 않았는데 이미 심겨 있다(이 순서가 이 라운드의 요점이다).
    const stop = (await installedSettings(root)).hooks?.Stop
    expect(JSON.stringify(stop)).toContain(HOOK_MARK)
    // 원격도 로컬과 **같은 한 줄**이다 — POSIX 한 줄이 세 OS 를 덮는다.
    expect(stop!.at(-1)!.hooks[0]!.command).toContain('[ -n "$ARA_HOOK_PORT" ]')
  })

  it('터널로 온 POST 가 그 탭의 상태가 된다', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server, pushed } = await hookServer()
    const client = await connect(h)

    const prep = await prepareRemoteHooks(client, server, 'pane-remote-2')
    expect(prep).not.toBeNull()
    expect((await prep!.installed).ok).toBe(true)
    const token = tokenInSettings(readSettings(root))!
    expect(token).toBeTruthy()

    const headers = { [HOOK_TOKEN_HEADER]: token, [HOOK_PANE_HEADER]: 'pane-remote-2' }
    expect(await postThroughTunnel(h, 'PreToolUse', headers)).toContain('204')
    expect(server.statuses()[0]).toMatchObject({ sessionId: 'pane-remote-2', cli: 'claude', state: 'working' })

    expect(await postThroughTunnel(h, 'Notification', headers)).toContain('204')
    expect(server.statuses()[0]!.state).toBe('waiting')
    expect(pushed).toHaveLength(2)
  })

  it('터널은 인증을 우회하는 길이 아니다 — 남의 토큰은 401', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()
    const client = await connect(h)
    await (await prepareRemoteHooks(client, server, 'pane-remote-3'))!.installed

    const bad = { [HOOK_TOKEN_HEADER]: 'not-the-token', [HOOK_PANE_HEADER]: 'pane-remote-3' }
    expect(await postThroughTunnel(h, 'Stop', bad)).toContain('401')
    expect(server.statuses()).toEqual([])
  })

  it('원격에서도 남의 훅을 지키고 되돌릴 사본을 남긴다', async () => {
    const root = tmp()
    const mine = { type: 'command', command: 'node my-own-hook.mjs' }
    const original = JSON.stringify({ env: { FOO: '1' }, hooks: { Stop: [{ hooks: [mine] }] } }, null, 2)
    writeFileSync(settingsPath(root), original, 'utf8')

    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()
    const client = await connect(h)
    expect((await (await prepareRemoteHooks(client, server, 'pane-remote-4'))!.installed).ok).toBe(true)

    const after = readSettings(root) as { env?: unknown; hooks?: Record<string, { hooks: unknown[] }[]> }
    expect(after.env).toEqual({ FOO: '1' })
    expect(after.hooks!.Stop![0]).toEqual({ hooks: [mine] })
    expect(JSON.stringify(after.hooks!.Stop!.at(-1))).toContain(HOOK_MARK)
    // 원격에는 덮어쓰는 rename 이 없어 원자적 교체를 못 한다 → 되돌릴 사본을 먼저 남긴다.
    expect(readFileSync(settingsPath(root) + '.bak', 'utf8')).toBe(original)
  })

  it('깨진 원격 설정은 한 글자도 안 건드린다', async () => {
    const root = tmp()
    writeFileSync(settingsPath(root), '{ "hooks": ', 'utf8')

    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()
    const client = await connect(h)
    const install = await (await prepareRemoteHooks(client, server, 'pane-remote-5'))!.installed

    expect(install.ok).toBe(false)
    expect(install.ok === false && install.reason).toBe('parse')
    expect(readFileSync(settingsPath(root), 'utf8')).toBe('{ "hooks": ')
    expect(existsSync(settingsPath(root) + '.bak')).toBe(false)
  })

  it('같은 서버에 다시 붙어도 토큰을 되찾아 파일을 안 흔든다', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()

    const c1 = await connect(h)
    await (await prepareRemoteHooks(c1, server, 'pane-a'))!.installed
    const first = readFileSync(settingsPath(root), 'utf8')

    const c2 = await connect(h)
    await (await prepareRemoteHooks(c2, server, 'pane-b'))!.installed
    expect(readFileSync(settingsPath(root), 'utf8')).toBe(first)
    // 두 세션이 같은 파일을 나눠 쓰지만 포트·탭은 env 로 오므로 서로를 밀어내지 않는다.
    expect(existsSync(settingsPath(root) + '.bak')).toBe(false)
  })

  it('역터널을 거절하는 서버(AllowTcpForwarding no)에는 **아무것도 심지 않는다**', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root }) // forwardIn 없음 = 거절
    harnesses.push(h)
    const { server } = await hookServer()

    await connect(h, { sink: server, paneId: 'pane-remote-6' })
    expect(h.shellEnv['ARA_HOOK_PORT']).toBeUndefined()
    // 받을 수 없는데 남의 설정 파일을 고치는 것은 부작용만 남기는 일이다.
    await wait(200)
    expect(existsSync(settingsPath(root))).toBe(false)
  })

  it('`~/.claude` 가 없는 서버에는 아무것도 만들지 않는다 — 실패가 아니라 안 하는 것이다', async () => {
    const root = tmp(false) // Claude Code 가 없는 서버
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    const { server } = await hookServer()
    const client = await connect(h)

    const install = await (await prepareRemoteHooks(client, server, 'pane-remote-8'))!.installed
    expect(install.ok).toBe(false)
    expect(install.ok === false && install.reason).toBe('skipped')
    expect(existsSync(join(root, '.claude'))).toBe(false) // 폴더조차 안 만든다
  })

  it('훅 서버가 안 떠 있으면 원격도 건드리지 않는다', async () => {
    const root = tmp()
    const h = await startPasswordServer({ sftpRoot: root, forwardIn: true })
    harnesses.push(h)
    // start() 를 안 부른 서버 = 포트 0.
    const server = createAgentHookServer({ token: 't', onStatus: () => {}, bindPort: 0 })
    servers.push(server)
    const client = await connect(h)
    expect(await prepareRemoteHooks(client, server, 'pane-remote-7')).toBeNull()
    expect(h.forwardedPort()).toBe(0)
    expect(existsSync(settingsPath(root))).toBe(false)
  })
})

// ── 토큰 집합 ────────────────────────────────────────────────────────────────
// 서버가 하나뿐이던 시절엔 토큰도 하나였다. 그대로 원격을 붙이면 서버 N 개가 같은 열쇠를 쓴다.

async function post(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/hook/claude/Stop', method: 'POST', headers },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end('{}')
  })
}

describe('토큰은 서버마다 다르다', () => {
  it('등록한 만큼 받아 주고, 등록 안 한 것은 막는다', async () => {
    const { server } = await hookServer('local-1')
    const port = server.port()
    server.setToken('sess-a', 'remote-a')
    server.setToken('sess-b', 'remote-b')

    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'local-1', [HOOK_PANE_HEADER]: 'p0' })).toBe(204)
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'remote-a', [HOOK_PANE_HEADER]: 'p1' })).toBe(204)
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'remote-b', [HOOK_PANE_HEADER]: 'p2' })).toBe(204)
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'remote-c', [HOOK_PANE_HEADER]: 'p3' })).toBe(401)
  })

  it('세션이 끝나면 그 서버의 열쇠도 사라진다 — 로컬 것은 그대로다', async () => {
    const { server } = await hookServer('local-1')
    const port = server.port()
    server.setToken('sess-a', 'remote-a')
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'remote-a', [HOOK_PANE_HEADER]: 'p1' })).toBe(204)

    server.forget('sess-a')
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'remote-a', [HOOK_PANE_HEADER]: 'p1' })).toBe(401)
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'local-1', [HOOK_PANE_HEADER]: 'p1' })).toBe(204)
  })

  it('로컬 토큰은 원격이 갈아 끼울 수 없다', async () => {
    const { server } = await hookServer('local-1')
    const port = server.port()
    server.setToken('local', 'hijack')
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'hijack', [HOOK_PANE_HEADER]: 'p1' })).toBe(401)
    expect(await post(port, { [HOOK_TOKEN_HEADER]: 'local-1', [HOOK_PANE_HEADER]: 'p1' })).toBe(204)
  })
})
