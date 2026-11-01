// M8 DM-02·03 통합 — ssh2 하네스(tests/ssh-harness.ts)에 붙어 **임시 폴더를 원격 홈으로** 설치 → 에이전트 PTY 실행 → SSH 끊김에도 생존 →
// 다시 붙어 이어 보기(replay) → 업데이트 미룸 판정 → 제거 → 흔적 0(폴더·프로세스·crontab·systemd)을 원격에서 잰다.
// 원격 쪽 명령은 진짜 Linux 가 돌려야 한다(pty·유닉스 소켓·/proc): Windows 에서는 WSL(Ubuntu)의 임시 폴더를 홈으로, SFTP 는 \\wsl.localhost 로 같은 폴더를 노출한다.
// WSL·python3 가 없으면 건너뛴다. 실서버·사내 서버에는 붙지 않는다(127.0.0.1 하네스만).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { Client } from 'ssh2'
import { startPasswordServer, type Harness } from './ssh-harness'
import { execSh, installHost, probeHost, uninstallHost } from '../src/main/managed/host'
import { createRemoteAgents } from '../src/main/managed/remoteAgents'
import type { DaemonBackend } from '../src/main/daemon/service'
import { AGENT_SESSION_LOST_EXIT } from '../src/shared/agentHooks'
import { UNINSTALL_SCRIPT, VERIFY_SCRIPT, decideUpdate, remnantsOf, supportOf } from '../src/shared/managedServers'

const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
// 원격 홈으로 cd 하고 HOME 을 바꾼 뒤 클라이언트가 보낸 명령을 그대로 셸에 — 실제 sshd 가 하는 일과 같다(로그인 홈에서 $SHELL -c).
const WRAP = 'cd "$1" && HOME="$1" exec sh -c "$2"'
const runner = (home: string, cmd: string): [string, string[]] =>
  WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', WRAP, 'sh', home, cmd]] : ['sh', ['-c', WRAP, 'sh', home, cmd]]

function linuxReady(): boolean {
  const [f, a] = WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'python3', '-c', 'import pty,termios,fcntl,selectors']] : ['python3', ['-c', 'import pty,termios,fcntl,selectors']]
  try {
    return spawnSync(f, a, { timeout: 60_000, windowsHide: true }).status === 0
  } catch {
    return false
  }
}
const READY = linuxReady()

let home = ''
let sftpRoot = ''
let harness: Harness | null = null

const connect = (port: number, password: string): Promise<Client> =>
  new Promise((res, rej) => {
    const c = new Client()
    c.on('ready', () => res(c)).on('error', rej)
    c.connect({ host: '127.0.0.1', port, username: 'tester', password, readyTimeout: 20_000 })
  })

const waitFor = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!READY)('orcad — 하네스 원격 홈에 설치 → 실행 → 끊김 생존 → 이어 붙기 → 제거 흔적 0', () => {
  beforeAll(async () => {
    const mk = WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '-t', 'ara-orcad-XXXXXX'], { windowsHide: true }) : spawnSync('mktemp', ['-d', '-t', 'ara-orcad-XXXXXX'])
    home = mk.stdout.toString().trim()
    expect(home).toMatch(/ara-orcad-/)
    sftpRoot = WIN ? `//wsl.localhost/${DISTRO}${home}` : home
    harness = await startPasswordServer({
      sftpRoot,
      execHandler: (command, stream) => {
        const [f, a] = runner(home, command)
        const child = spawn(f, a, { windowsHide: true })
        child.stdout.on('data', (d: Buffer) => stream.write(d))
        child.stderr.on('data', (d: Buffer) => stream.stderr.write(d))
        stream.on('data', (d: Buffer) => child.stdin.write(d))
        // 클라이언트가 stdin 을 닫거나 연결이 끊기면 원격 프로세스의 stdin 도 닫힌다(sshd 와 같다 — 다리는 이것으로 끝난다).
        const endIn = (): void => void (child.stdin.writable && child.stdin.end())
        stream.on('end', endIn)
        stream.on('close', endIn)
        child.stdin.on('error', () => {})
        child.on('close', (code) => {
          try {
            stream.exit(code ?? 1)
            stream.end()
          } catch {
            /* 채널이 이미 닫힘 */
          }
        })
      }
    })
  }, 120_000)

  afterAll(async () => {
    // 실패해도 시험 부산물(데몬·셸)을 남기지 않는다.
    if (home) {
      const [f, a] = runner(home, UNINSTALL_SCRIPT)
      spawnSync(f, a, { timeout: 60_000, windowsHide: true })
      if (WIN) spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'rm', '-rf', home], { windowsHide: true })
      else spawnSync('rm', ['-rf', home])
    }
    await harness?.close()
  }, 120_000)

  it('전 과정', async () => {
    const h = harness!
    const c1 = await connect(h.port, h.password)

    // 1) 묻기 — 지원, 아직 없음.
    const p0 = await probeHost(c1)
    expect(supportOf(p0)).toEqual({ ok: true })
    expect(p0.installed).toBeNull()
    expect(p0.home).toBe(home)

    // 2) 설치 — 기존 SFTP 쓰기로 올라갔고, 홈 아래 한 폴더에만.
    await installHost(c1, '2.11.0')
    expect(readFileSync(`${sftpRoot}/.ara-server/version`, 'utf8')).toBe('2.11.0')
    expect(readFileSync(`${sftpRoot}/.ara-server/token`, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    expect((await probeHost(c1)).installed).toBe('2.11.0')
    const perm = await execSh(c1, 'stat -c %a "$HOME/.ara-server" "$HOME/.ara-server/token"')
    expect(perm.out.split(/\s+/).filter(Boolean)).toEqual(['700', '600'])

    // 3) 에이전트 PTY 실행 — 원격 env 위에 덧붙인 값, 한글 왕복.
    const backends = new Map<string, DaemonBackend>()
    const out = new Map<string, string>()
    const exits = new Map<string, number>()
    const agents = createRemoteAgents({
      adopt: (b) => {
        backends.set(b.id, b)
        out.set(b.id, '')
        b.onData((d) => out.set(b.id, out.get(b.id) + d))
        b.onExit((code) => exits.set(b.id, code))
      },
      log: () => {}
    })
    const hostKey = `tester@127.0.0.1:${h.port}`
    const info = await agents.create(hostKey, c1, { id: 'agent-1', cwd: home, cols: 100, rows: 30, env: { ARA_T: '바다' }, meta: { title: '시험' } })
    expect(info).toMatchObject({ id: 'agent-1', cwd: home, cols: 100, rows: 30, meta: { title: '시험' } })
    backends.get('agent-1')!.write('echo "ok-$ARA_T"; tty\n')
    await waitFor(() => /ok-바다/.test(out.get('agent-1')!), 20_000, '원격 셸 출력')
    expect(out.get('agent-1')).toMatch(/\/dev\/pts\//) // 진짜 PTY

    // 업데이트 판정: 판이 다르고 에이전트가 돌면 미룬다.
    expect(decideUpdate({ installed: '2.11.0', app: '2.12.0', liveSessions: await agents.liveSessions(hostKey, c1) })).toBe('defer')

    // 4) SSH 가 끊겨도 원격 세션은 산다 — 이 쪽 탭만 잃음으로 끝난다.
    c1.end()
    await waitFor(() => exits.has('agent-1'), 20_000, '다리 끊김')
    expect(exits.get('agent-1')).toBe(AGENT_SESSION_LOST_EXIT)
    const c2 = await connect(h.port, h.password)
    const alive = remnantsOf((await execSh(c2, VERIFY_SCRIPT)).out)
    // 양성 대조: 검증 명령이 "있다"를 잡는다(데몬 + 세션 셸) — 이게 0 이면 뒤의 흔적 0 도 믿을 수 없다.
    expect(alive).toContain('dir')
    expect(Number(alive.find((x) => x.startsWith('proc:'))?.slice(5))).toBeGreaterThanOrEqual(2)

    // 5) 다시 붙으면 같은 id 로 되살아나고 화면이 돌아온다(replay).
    out.set('agent-1', '')
    exits.clear()
    const back = await agents.attach(hostKey, c2)
    expect(back.map((x) => x.id)).toEqual(['agent-1'])
    await waitFor(() => /ok-바다/.test(out.get('agent-1') ?? ''), 10_000, 'replay')
    backends.get('agent-1')!.write('echo "again-$((40+2))"\n')
    await waitFor(() => /again-42/.test(out.get('agent-1')!), 10_000, '이어 붙은 뒤 입력')

    // 6) 제거 = 동의 철회: 다리 닫고 → 원격에서 데몬·세션 끝내고 폴더 지우고 → 남은 것 0.
    agents.detach(hostKey)
    const left = await uninstallHost(c2)
    expect(left).toEqual([])
    expect(existsSync(`${sftpRoot}/.ara-server`)).toBe(false)
    // 한 번 더 재도 0(시간 차로 늦게 남는 것 없음).
    expect(remnantsOf((await execSh(c2, VERIFY_SCRIPT)).out)).toEqual([])
    c2.end()
  }, 180_000)
})
