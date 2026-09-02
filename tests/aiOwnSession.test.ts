/**
 * D(#168) AI CLI 를 **그 세션의 프로세스로** 띄운다 — 셸에 타이핑해 넣는 대신.
 *
 * 여기서 증명하는 것 넷:
 *  ① 조립이 **인용 층 하나**다 — 명령·인자는 낱말로 가고, 사용자 폴더만 따로 인용된다
 *  ② 그 argv 로 진짜 셸을 띄우면 **그 바이너리가 돌고 끝나면 같이 끝난다**(로컬)
 *  ③ 원격의 새 exec 채널에 **훅 env·tty 폴백이 그대로 실린다** ← 이게 이 라운드의 급소다
 *     (안 되면 새로 띄운 AI 가 [AI] 목록에 안 떠서 목적의 정반대가 된다)
 *  ④ **기존 셸 탭이 열리는 방식은 한 줄도 안 바뀐다** — 명령을 안 주면 여전히 `client.shell()` 이다
 *
 * ⚠️ 준영님 실제 서버에는 붙지 않는다 — 전부 인프로세스 하네스다(tests/ssh-harness.ts).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aiCommandOf,
  buildLocalAiArgv,
  buildRemoteAiCommand,
  safeAiCommand,
  type AiCommand
} from '../src/shared/aiCli'
import { connectSsh, type SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { createAgentHookServer, type AgentHookServerHandle } from '../src/main/agent/AgentHookServer'
import { HOOK_MARK, HOOK_TTY_PREFIX } from '../src/main/agent/claudeHooks'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'

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

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-d168-'))
  dirs.push(d)
  mkdirSync(join(d, '.claude'), { recursive: true })
  return d
}

const wait = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
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

const CLAUDE: AiCommand = { bin: 'claude', args: ['--dangerously-skip-permissions', '-r'] }

// ── ① 조립 ───────────────────────────────────────────────────────────────────

describe('D 조립 — 명령·인자는 배열로, 폴더만 인용된다', () => {
  it('플래그 표에서 나온 argv 가 그대로 낱말이 된다(문자열로 이어 붙이는 자리가 없다)', () => {
    const cmd = aiCommandOf({ cli: 'claude', flags: ['skipPerms', 'resume'] })
    expect(cmd).toEqual(CLAUDE)
    // 로컬 세 셸 — 어느 쪽도 bin·args 를 한 덩어리 문자열로 묶지 않는다.
    expect(buildLocalAiArgv('posix', cmd!)).toEqual([
      '-lc',
      'exec "$@"',
      'ara',
      'claude',
      '--dangerously-skip-permissions',
      '-r'
    ])
    expect(buildLocalAiArgv('powershell', cmd!)).toEqual([
      '-NoLogo',
      '-Command',
      'claude',
      '--dangerously-skip-permissions',
      '-r'
    ])
    expect(buildLocalAiArgv('cmd', cmd!)).toEqual(['/d', '/s', '/c', 'claude', '--dangerously-skip-permissions', '-r'])
  })

  it('탭이 CLI 와 함께 끝나야 하므로 `-NoExit` 은 어디에도 없다', () => {
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      expect(buildLocalAiArgv(shell, CLAUDE)!.join(' ')).not.toContain('NoExit')
    }
  })

  it('원격 한 줄은 폴더만 감싸고 명령은 낱말로 둔다 — 중첩 따옴표가 생기지 않는다', () => {
    const line = buildRemoteAiCommand(CLAUDE, '/data/내 프로젝트')!
    expect(line).toBe(
      `cd '/data/내 프로젝트' && exec "\${SHELL:-/bin/sh}" -lc 'exec "$@"' ara claude --dangerously-skip-permissions -r`
    )
    // 따옴표는 폴더 한 쌍 + `exec "$@"` 한 쌍뿐이다. 하나라도 더 있으면 이스케이프를 하고 있다는 뜻이다.
    expect((line.match(/'/g) ?? []).length).toBe(4)
    // 로그인 셸을 거친다 — 안 거치면 `.bashrc` 를 안 읽어 nvm 으로 깐 CLI 를 못 찾는다.
    expect(line).toContain('-lc')
  })

  it('`~` 는 따옴표 밖에 남는다 — 감싸면 홈으로 안 펼쳐져 "그런 폴더 없음"이 된다', () => {
    expect(buildRemoteAiCommand(CLAUDE, '~')).toContain("cd ~ &&")
    expect(buildRemoteAiCommand(CLAUDE, '~/svc')).toContain("cd ~/'svc' &&")
  })

  it('신뢰 경계: 낱말이 아닌 것은 조립하지 않는다(인용으로 살리지 않는다)', () => {
    for (const bad of ['a b', 'a"b', 'a&b', 'a$b', 'a;b', 'a|b', 'a\nb', "a'b", '']) {
      expect(safeAiCommand({ bin: 'claude', args: [bad] }), bad).toBeNull()
      expect(safeAiCommand({ bin: bad, args: [] }), bad).toBeNull()
    }
    expect(safeAiCommand({ bin: 'claude', args: 'not-an-array' })).toBeNull()
    expect(safeAiCommand(null)).toBeNull()
    // 폴더는 여기 오지 않지만, 오더라도 한 줄이 끊기지 않는다(개행·작은따옴표는 거절).
    expect(buildRemoteAiCommand(CLAUDE, "/a'b")).toBeNull()
    expect(buildRemoteAiCommand(CLAUDE, '/a\nrm -rf /')).toBeNull()
  })
})

// ── ② 로컬 실증 ──────────────────────────────────────────────────────────────
// node-pty 는 Electron ABI 로 빌드돼 vitest 에서 못 올린다. pty 냐 파이프냐는 이 라운드가 정한
// 것(= 무엇을 실행하는가)과 무관하므로, **같은 argv 를 같은 셸에** 넘겨 진짜로 그 바이너리가
// 도는지 본다. 낱말에 공백·따옴표가 없어 두 스폰의 명령줄은 글자까지 같다.

/** 그 플랫폼의 "PATH 에 놓인 CLI" 흉내. 받은 인자를 그대로 찍어 인자 전달까지 함께 본다. */
function fakeCli(dir: string): { bin: string; env: NodeJS.ProcessEnv } {
  if (process.platform === 'win32') {
    // 🔴 진짜 `claude` 가 npm 셔임(`.cmd`)이라 이 모양이 중요하다 — #152 가 그 자리에서 났다.
    const p = join(dir, 'ara-fake-cli.cmd')
    writeFileSync(p, '@echo off\r\necho ARA-RAN %*\r\n', 'utf8')
    return { bin: 'ara-fake-cli', env: { ...process.env, PATH: `${dir};${process.env['PATH'] ?? ''}` } }
  }
  // POSIX 는 절대 경로로 부른다 — 로그인 셸이 PATH 를 통째로 다시 세우는 배포판이 있어서다
  // (그건 이 검사가 볼 것이 아니다: 여기서 보는 것은 **인자가 낱말째 도착하는가**).
  const p = join(dir, 'ara-fake-cli')
  writeFileSync(p, '#!/bin/sh\necho "ARA-RAN $*"\n', 'utf8')
  chmodSync(p, 0o755)
  return { bin: p, env: { ...process.env } }
}

describe('D 로컬 — 그 셸의 유일한 일이 이 명령이고, 명령이 끝나면 셸도 끝난다', () => {
  it('셸을 한 겹 거쳐 CLI 가 돌고, 인자가 낱말째 도착하고, 종료가 따라 나온다', async () => {
    const dir = tmp()
    const { bin, env } = fakeCli(dir)
    const win = process.platform === 'win32'
    const file = win ? 'powershell.exe' : (process.env['SHELL'] || '/bin/sh')
    const argv = buildLocalAiArgv(win ? 'powershell' : 'posix', { bin, args: ['--flag-one', '-r'] })!

    const out = await new Promise<{ text: string; code: number | null }>((resolve) => {
      let text = ''
      const p = spawn(file, argv, { cwd: dir, env, windowsHide: true })
      p.stdout.on('data', (d: Buffer) => (text += d.toString('utf8')))
      p.stderr.on('data', (d: Buffer) => (text += d.toString('utf8')))
      p.on('close', (code) => resolve({ text, code }))
    })

    expect(out.text).toContain('ARA-RAN')
    // 인자가 **쪼개지지도 합쳐지지도** 않고 그대로 왔다(#152 가 `&` 에서 잃었던 그것).
    expect(out.text).toContain('--flag-one')
    expect(out.text).toContain('-r')
    // CLI 가 나가면 셸도 나간다 = 세션이 끝난다(터미널과 같은 `[프로세스 종료]` 카드가 뜬다).
    expect(out.code).toBe(0)
  }, 30_000)
})

// ── ③④ 원격 ─────────────────────────────────────────────────────────────────

/** AI 세션으로 붙는다. execHandler 가 그 채널로 온 명령을 관측한다. */
async function connectAi(
  h: Harness,
  hooks: { sink: AgentHookServerHandle; paneId: string },
  cwd = '/data/svc'
): Promise<void> {
  const res = await connectSsh(pwProfile(h.port), {
    knownHosts: {},
    secret: h.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {},
    hooks,
    size: { cols: 120, rows: 40 },
    aiCommand: { argv: CLAUDE, cwd }
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  backends.push(res.backend)
}

async function hookServer(): Promise<AgentHookServerHandle> {
  const server = createAgentHookServer({ token: 'local-token', onStatus: () => {}, onExit: () => {}, bindPort: 0 })
  servers.push(server)
  expect(await server.start()).toBeGreaterThan(0)
  return server
}

describe('D 원격 — 새 채널에도 훅이 그대로 붙는다', () => {
  it('exec 채널의 프로세스가 CLI 이고, 훅 env 둘이 **그 채널에** 실린다', async () => {
    const root = tmp()
    const seen: string[] = []
    // 훅이 이미 심긴 뒤에 명령이 떴는가 — claude 는 **뜰 때** settings.json 을 읽는다.
    let markedWhenRan: boolean | null = null
    const h = await startPasswordServer({
      sftpRoot: root,
      forwardIn: true,
      procCwd: { pid: 4242 },
      execHandler: (command, stream) => {
        seen.push(command)
        try {
          markedWhenRan = readFileSync(join(root, '.claude', 'settings.json'), 'utf8').includes(HOOK_MARK)
        } catch {
          markedWhenRan = false
        }
        stream.write('claude ready\r\n') // 살려 둔다 — 종료는 afterEach 의 kill 이 한다
      }
    })
    harnesses.push(h)
    const server = await hookServer()

    await connectAi(h, { sink: server, paneId: 'pane-ai-1' })
    await waitFor(() => seen.length > 0)

    // ① 그 채널의 프로세스가 곧 CLI 다(셸을 열고 타이핑한 것이 아니다).
    expect(seen[0]).toBe(
      `cd '/data/svc' && exec "\${SHELL:-/bin/sh}" -lc 'exec "$@"' ara claude --dangerously-skip-permissions -r`
    )
    // ② 🔴 급소 — 이 커넥션은 셸을 열지 않았으므로, 이 env 는 **exec 채널로** 간 것이다.
    expect(h.shellEnv['ARA_HOOK_PORT']).toBe(String(h.forwardedPort()))
    expect(h.shellEnv['ARA_PANE']).toBe('pane-ai-1')
    // ③ 설치가 명령보다 **먼저**다 — 순서가 뒤집히면 그 세션은 훅 없이 뜨고 목록에 안 나온다.
    expect(markedWhenRan).toBe(true)
    // ④ 아는 크기로 연다(#158 과 같은 규칙 — 셸이 아니라 exec 의 pty 요청이다).
    expect(h.ptyRequest()).toEqual({ cols: 120, rows: 40 })
  }, 20_000)

  it('#162 tty 폴백 파일이 이 채널에도 놓인다 — env 를 버리는 sshd 에서도 자기를 찾는다', async () => {
    const root = tmp()
    const h = await startPasswordServer({
      sftpRoot: root,
      forwardIn: true,
      procCwd: { pid: 4242 },
      execHandler: (_c, stream) => stream.write('claude ready\r\n')
    })
    harnesses.push(h)
    const server = await hookServer()

    await connectAi(h, { sink: server, paneId: 'pane-ai-2' })

    // 하네스는 커넥션 0 에 /dev/pts/3 을 준다 → 훅 한 줄이 읽을 이름이 그것이다.
    const file = join(root, '.claude', `${HOOK_TTY_PREFIX}3`)
    await waitFor(() => {
      try {
        return readFileSync(file, 'utf8').trim().length > 0
      } catch {
        return false
      }
    })
    expect(readFileSync(file, 'utf8').trim()).toBe(`${h.forwardedPort()} pane-ai-2`)
  }, 20_000)

  it('기존 셸 탭은 한 줄도 안 바뀐다 — 명령을 안 주면 exec 이 아니라 shell 이다', async () => {
    const root = tmp()
    const execs: string[] = []
    const h = await startPasswordServer({
      sftpRoot: root,
      forwardIn: true,
      execHandler: (command, stream) => {
        execs.push(command)
        stream.exit(0)
        stream.end()
      }
    })
    harnesses.push(h)
    const server = await hookServer()

    const res = await connectSsh(pwProfile(h.port), {
      knownHosts: {},
      secret: h.password,
      acceptHostKey: true,
      onHostKeyAccepted: () => {},
      hooks: { sink: server, paneId: 'pane-shell' }
    })
    expect(res.ok).toBe(true)
    if (res.ok) backends.push(res.backend)

    // 셸 채널이 열렸다는 증거 — 하네스의 셸은 접속 즉시 배너를 찍는다.
    let out = ''
    if (res.ok) res.backend.onData((d) => (out += d))
    await waitFor(() => out.includes('A.R.A'))
    // exec 으로 간 것은 CWD 추적의 PID 질의뿐이다(F1b 가 일부러 안 간 그 길로 셸이 가지 않았다).
    expect(execs.filter((c) => !c.includes('$PPID'))).toEqual([])
  }, 20_000)
})
