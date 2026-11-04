// M8 DM-02·03 통합(+ 3차 R1 PC 둘 · R2 서버 훅 · R3 서버 계정 · R4 원격 채팅 보기) — ssh2 하네스(tests/ssh-harness.ts)에 붙어 **임시 폴더를 원격 홈으로** 설치 → 에이전트 PTY 실행 → SSH 끊김에도 생존 →
// 다시 붙어 이어 보기(replay) → 업데이트 미룸 판정 → 제거 → 흔적 0(폴더·프로세스·crontab·systemd)을 원격에서 잰다.
// 원격 쪽 명령은 진짜 Linux 가 돌려야 한다(pty·유닉스 소켓·/proc): Windows 에서는 WSL(Ubuntu)의 임시 폴더를 홈으로, SFTP 는 \\wsl.localhost 로 같은 폴더를 노출한다.
// WSL·python3 가 없으면 건너뛴다. 실서버·사내 서버에는 붙지 않는다(127.0.0.1 하네스만).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Client } from 'ssh2'
import { startPasswordServer, type Harness } from './ssh-harness'
import { execSh, installHost, probeHost, uninstallHost } from '../src/main/managed/host'
import { createRemoteAgents } from '../src/main/managed/remoteAgents'
import { createRemoteChat } from '../src/main/agents/remoteChat'
import type { AgentChatEvent } from '../src/shared/agentChat'
import { deriveGeneratedTabTitle } from '../src/shared/agentTabTitle'
import type { DaemonBackend } from '../src/main/daemon/service'
import { AGENT_SESSION_LOST_EXIT } from '../src/shared/agentHooks'
import { UNINSTALL_SCRIPT, VERIFY_SCRIPT, accountLoginLine, decideUpdate, remnantsOf, remoteHookLaunch, serverAccountsOf, serverStateOf, supportOf, type ServerAccount, type ServerAccounts } from '../src/shared/managedServers'
import { applyHookEvent } from '../src/shared/agentHooks'
import { remoteAddWorktree, remoteListWorktrees, remoteRemoveWorktree, remoteTopLevel, type RemoteRun } from '../src/main/managed/remoteWorktrees'

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

  // M8 R3 DM-04·05 — 원격 git 저장소에서 워크트리 생성 → 그 워크트리에서 원격 에이전트 → SSH 끊김(탭 끊김, 원격 생존) → 다시 연결(같은 세션)
  // → 워크트리 삭제 → 데몬 제거 흔적 0. 위 시험이 제거까지 마쳤으므로 같은 홈에 새로 설치한다.
  it('Run on — 원격 워크트리 + 에이전트 + 끊김 → 다시 연결 + 삭제', async () => {
    const h = harness!
    const c1 = await connect(h.port, h.password)
    const runOver = (c: Client): RemoteRun => (script, t) => execSh(c, script, t)
    const run1 = runOver(c1)
    // 원격 저장소(사용자가 고른 것 — 시험에선 홈 아래에 만든다).
    const init = await run1('git init -q -b main "$HOME/shop" && cd "$HOME/shop" && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && echo ok')
    expect(init.out.trim()).toBe('ok')

    // 등록 — `~/…` 를 홈으로 펴고, 하위 폴더도 뿌리로.
    const top = await remoteTopLevel(run1, '~/shop')
    expect(top).toBe(`${home}/shop`)
    expect(await remoteTopLevel(run1, '~/nope')).toBeNull()

    // 워크트리 — Orca 형제 자리, 새 브랜치.
    const made = await remoteAddWorktree(run1, top!, 'feat')
    expect(made).toMatchObject({ ok: true, branch: 'feat', worktree: { path: `${home}/shop-feat`, branch: 'refs/heads/feat' } })
    // 같은 이름 다시 → -2(브랜치·폴더가 이미 있다).
    expect(await remoteAddWorktree(run1, top!, 'feat')).toMatchObject({ ok: true, branch: 'feat-2' })
    expect((await remoteListWorktrees(run1, top!))?.map((w) => w.path)).toEqual([`${home}/shop`, `${home}/shop-feat`, `${home}/shop-feat-2`])

    // 실행 위치 = 이 서버: 데몬 준비(설치) → 그 워크트리에서 원격 세션.
    await installHost(c1, '2.11.0')
    const out = new Map<string, string>()
    const exits = new Map<string, number>()
    const backends = new Map<string, DaemonBackend>()
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
    const wt = `${home}/shop-feat`
    await agents.create(hostKey, c1, { id: 'run-on-1', cwd: wt, env: {}, meta: { agent: 'claude', title: 'Claude · shop-feat', host: hostKey } })
    backends.get('run-on-1')!.write('echo "at-$(pwd)-$(git branch --show-current)"\n')
    await waitFor(() => out.get('run-on-1')!.includes(`at-${wt}-feat`), 20_000, '원격 워크트리에서 셸')

    // SSH 끊김 → 이 쪽 탭은 끊김(잃음 코드), 원격 세션은 산다.
    c1.end()
    await waitFor(() => exits.has('run-on-1'), 20_000, '다리 끊김')
    expect(exits.get('run-on-1')).toBe(AGENT_SESSION_LOST_EXIT)

    // [다시 연결] = 새 연결로 같은 세션(같은 id, 같은 cwd·meta), 입력이 이어진다. 자동으로 붙지 않는다 — 여기서 손으로 부른다.
    const c2 = await connect(h.port, h.password)
    out.set('run-on-1', '')
    exits.clear()
    const back = await agents.attach(hostKey, c2)
    expect(back.map((x) => [x.id, x.cwd, x.meta['host']])).toEqual([['run-on-1', wt, hostKey]])
    backends.get('run-on-1')!.write('echo "again-$((6*7))"\n')
    await waitFor(() => /again-42/.test(out.get('run-on-1')!), 10_000, '이어 붙은 뒤 입력')

    // 정리 — 데몬 제거(세션도 끝) → 워크트리 삭제(본 폴더는 거절) → 흔적 0.
    const run2 = runOver(c2)
    agents.detach(hostKey)
    expect(await uninstallHost(c2)).toEqual([])
    expect(await remoteRemoveWorktree(run2, top!, top!, false)).toEqual({ ok: false, message: top })
    expect(await remoteRemoveWorktree(run2, top!, wt, false)).toMatchObject({ ok: true })
    expect(await remoteRemoveWorktree(run2, top!, `${home}/shop-feat-2`, false)).toMatchObject({ ok: true })
    expect((await remoteListWorktrees(run2, top!))?.map((w) => w.path)).toEqual([`${home}/shop`])
    expect((await run2(`[ -e "$HOME/shop-feat" ] || [ -e "$HOME/shop-feat-2" ] && echo left; true`)).out.trim()).toBe('')
    c2.end()
  }, 180_000)

  // M8 R4 — 앱 재시작 복귀(클라이언트 상태를 새로 만든 뒤 세션 조회 → 다시 연결) + 끊긴 탭 닫기 = 서버의 에이전트 끝내기 → 원격 세션 프로세스 0.
  it('재시작 복귀 + 끊긴 탭 닫기 끝내기', async () => {
    const h = harness!
    const hostKey = `tester@127.0.0.1:${h.port}`
    const c1 = await connect(h.port, h.password)
    await installHost(c1, '2.11.0')
    const first = createRemoteAgents({ adopt: () => {}, log: () => {} })
    await first.create(hostKey, c1, { id: 'keep', cwd: home, env: { ARA_T: '산' }, meta: { title: 'keep', host: hostKey } })
    await first.create(hostKey, c1, { id: 'drop', cwd: home, env: {}, meta: { title: 'drop', host: hostKey } })
    // 앱 종료 = 다리 닫기 + 연결 끊기. 세션은 서버에 산다.
    first.closeAll()
    c1.end()

    // 다시 켠 앱: 새 상태(아무것도 모름). 끊긴 탭 'drop' 을 닫는다 → 잠깐 붙어서 끝낸다(붙은 탭이 없으니 다리도 닫는다).
    const c2 = await connect(h.port, h.password)
    const out = new Map<string, string>()
    const exits = new Map<string, number>()
    const backends = new Map<string, DaemonBackend>()
    const gone: string[] = []
    const listed: string[][] = []
    const second = createRemoteAgents({
      adopt: (b) => {
        backends.set(b.id, b)
        out.set(b.id, '')
        b.onData((d) => out.set(b.id, out.get(b.id) + d))
        b.onExit((code) => exits.set(b.id, code))
      },
      gone: (id) => gone.push(id),
      listed: (_h, ids) => listed.push(ids),
      log: () => {}
    })
    await second.kill(hostKey, c2, 'drop')
    expect(gone).toEqual(['drop'])
    expect(second.connected(hostKey)).toBe(false)
    const end = Date.now() + 15_000
    while ((await second.liveSessions(hostKey, c2)) !== 1) {
      if (Date.now() > end) throw new Error('시간 초과: drop 세션 끝남')
      await new Promise((r) => setTimeout(r, 200))
    }

    // [다시 연결] = 세션 조회 → 남은 것만 같은 id 로 되살아나고 화면이 돌아온다(서버에 없는 저장 탭은 listed 로 걸러진다).
    const back = await second.attach(hostKey, c2)
    expect(back.map((x) => [x.id, x.meta['host']])).toEqual([['keep', hostKey]])
    expect(listed.at(-1)).toEqual(['keep'])
    expect(second.hostOf('keep')).toBe(hostKey)
    backends.get('keep')!.write('echo "back-$ARA_T"\n')
    await waitFor(() => /back-산/.test(out.get('keep')!), 10_000, '되살린 뒤 입력')

    // R1 결정 4 ⓑ: 붙은 탭 닫기(session.destroy → kill) = 이 PC 에서만 놓기 — 서버 세션은 산다(M8 R4 의 "닫기 = 끝내기"를 바꿨다).
    backends.get('keep')!.kill()
    expect(second.hostOf('keep')).toBeUndefined()
    expect(second.connected(hostKey)).toBe(false) // 붙은 탭이 없으니 다리째 닫았다
    expect((await second.list(hostKey, c2)).map((x) => x.id)).toEqual(['keep'])
    expect(gone).toEqual(['drop'])
    // "서버에서도 끝내기" = kill → 끝 → 다리를 닫으면 데몬도 스스로 내려간다 → 원격 프로세스 0(설치 폴더만 남음).
    await second.kill(hostKey, c2, 'keep')
    expect(gone).toEqual(['drop', 'keep'])
    second.detach(hostKey)
    const end2 = Date.now() + 20_000
    let left = remnantsOf((await execSh(c2, VERIFY_SCRIPT)).out)
    while (left.some((x) => x.startsWith('proc:'))) {
      if (Date.now() > end2) throw new Error(`시간 초과: 원격 프로세스 ${left.join(',')}`)
      await new Promise((r) => setTimeout(r, 300))
      left = remnantsOf((await execSh(c2, VERIFY_SCRIPT)).out)
    }
    expect(left).toEqual(['dir'])
    expect(await uninstallHost(c2)).toEqual([])
    c2.end()
  }, 180_000)

  // R1 다른 PC 에서 이어 보기 — ssh2 연결 둘 + 클라이언트 상태 둘(= PC 둘). A 가 만든 세션을 B 가 목록으로 보고 붙어 replay 를 받고,
  // 양쪽 입력이 같은 PTY 로(broadcast), A 가 끊겨도 B 는 계속 받고, B 가 "이 PC 에서만 닫기" 해도 서버 세션은 살고, "서버에서도 끝내기"면 사라진다.
  it('PC 둘 — 목록·붙기·replay·양쪽 입력·한쪽 끊김·이 PC 에서만 닫기·서버에서 끝내기', async () => {
    const h = harness!
    const hostKey = `tester@127.0.0.1:${h.port}`
    type Pc = { agents: ReturnType<typeof createRemoteAgents>; out: Map<string, string>; exits: Map<string, number>; backends: Map<string, DaemonBackend>; viewers: Map<string, string[]> }
    const pc = (name: string): Pc => {
      const p: Pc = { out: new Map(), exits: new Map(), backends: new Map(), viewers: new Map(), agents: null as unknown as Pc['agents'] }
      p.agents = createRemoteAgents({
        adopt: (b) => {
          p.backends.set(b.id, b)
          p.out.set(b.id, '')
          b.onData((d) => p.out.set(b.id, p.out.get(b.id) + d))
          b.onExit((code) => p.exits.set(b.id, code))
        },
        viewers: (id, v) => p.viewers.set(id, v),
        pc: name,
        log: () => {}
      })
      return p
    }
    const cA = await connect(h.port, h.password)
    const cB = await connect(h.port, h.password)
    await installHost(cA, '2.11.0')
    const A = pc('PC-A')
    const B = pc('PC-B')

    // A 가 만든다(만든 PC 를 meta 로).
    await A.agents.create(hostKey, cA, { id: 'two', cwd: home, env: {}, meta: { agent: 'claude', title: '둘', pc: 'PC-A', startedAt: Date.now() } })
    A.backends.get('two')!.write('echo "made-by-$((1+1))"\n')
    await waitFor(() => /made-by-2/.test(A.out.get('two')!), 20_000, 'A 출력')
    await waitFor(() => (A.viewers.get('two') ?? []).join() === 'PC-A', 10_000, 'A 보는 중')

    // B: 붙지 않고 목록 — 만든 PC·보는 PC 가 보인다. 목록만 보면 다리를 남기지 않는다.
    const listed = await B.agents.list(hostKey, cB)
    expect(listed.map((x) => [x.id, x.meta['pc'], x.viewers])).toEqual([['two', 'PC-A', ['PC-A']]])
    expect(B.agents.connected(hostKey)).toBe(false)

    // B 가 그 세션 하나에 붙는다 → replay 로 A 의 출력을 받고, 양쪽에 "PC 2대".
    const got = await B.agents.attach(hostKey, cB, ['two'])
    expect(got.map((x) => x.id)).toEqual(['two'])
    await waitFor(() => /made-by-2/.test(B.out.get('two') ?? ''), 10_000, 'B replay')
    await waitFor(() => (A.viewers.get('two') ?? []).join() === 'PC-A,PC-B' && (B.viewers.get('two') ?? []).join() === 'PC-A,PC-B', 10_000, '보는 PC 둘')

    // 양쪽 입력이 같은 PTY 로, 출력은 둘 다.
    B.backends.get('two')!.write('echo "from-B-$((3*3))"\n')
    await waitFor(() => /from-B-9/.test(A.out.get('two')!) && /from-B-9/.test(B.out.get('two')!), 10_000, 'B 입력 → 둘 다')
    A.backends.get('two')!.write('echo "from-A-$((4*4))"\n')
    await waitFor(() => /from-A-16/.test(A.out.get('two')!) && /from-A-16/.test(B.out.get('two')!), 10_000, 'A 입력 → 둘 다')

    // meta 덧쓰기(제목) — 다른 PC 의 목록에 보인다.
    A.agents.meta('two', { genTitle: '결제 재시도' })
    const end1 = Date.now() + 10_000
    while ((await B.agents.list(hostKey, cB))[0]?.meta['genTitle'] !== '결제 재시도') {
      if (Date.now() > end1) throw new Error('시간 초과: meta')
      await new Promise((r) => setTimeout(r, 100))
    }

    // A 가 끊긴다(PC 를 끔) → A 탭만 잃음, B 는 계속 받는다. 보는 PC 는 B 만.
    cA.end()
    await waitFor(() => A.exits.get('two') === AGENT_SESSION_LOST_EXIT, 20_000, 'A 끊김')
    await waitFor(() => (B.viewers.get('two') ?? []).join() === 'PC-B', 10_000, 'B 만 보는 중')
    B.backends.get('two')!.write('echo "after-A-$((5*5))"\n')
    await waitFor(() => /after-A-25/.test(B.out.get('two')!), 10_000, 'A 끊긴 뒤 B')
    expect(B.exits.has('two')).toBe(false)

    // B: 이 PC 에서만 닫기(탭 ✕ = destroy → kill) → 서버 세션은 산다, 아무도 안 본다.
    B.backends.get('two')!.kill()
    expect(B.agents.hostOf('two')).toBeUndefined()
    const still = await B.agents.list(hostKey, cB)
    expect(still.map((x) => [x.id, x.viewers])).toEqual([['two', []]])

    // 서버에서도 끝내기 → 사라진다.
    await B.agents.kill(hostKey, cB, 'two')
    const end2 = Date.now() + 15_000
    while ((await B.agents.list(hostKey, cB)).length) {
      if (Date.now() > end2) throw new Error('시간 초과: 서버에서 끝내기')
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(await uninstallHost(cB)).toEqual([])
    cB.end()
  }, 180_000)

  // 3차 R2 서버에서 상태 판정 — 가짜 claude 가 --settings 파일의 훅 명령(orcad.py hook claude)을 부르면 붙은 PC 둘이 같은 status 사건을 받고,
  // 늦게 붙은 PC 는 attach 때·list 에서 마지막 상태를 받는다. 서버 ~/.claude/settings.json 은 그대로(훅을 거기에 심지 않는다).
  it('서버 훅 — PC 둘이 같은 status · 늦게 붙은 PC 도 마지막 상태 · 서버 ~/.claude 그대로', async () => {
    const h = harness!
    const hostKey = `tester@127.0.0.1:${h.port}`
    type Ev = { id: string; source: string; payload: Record<string, unknown> }
    type Pc = { agents: ReturnType<typeof createRemoteAgents>; out: Map<string, string>; backends: Map<string, DaemonBackend>; status: Ev[] }
    const pc = (name: string): Pc => {
      const p: Pc = { out: new Map(), backends: new Map(), status: [], agents: null as unknown as Pc['agents'] }
      p.agents = createRemoteAgents({
        adopt: (b) => {
          p.backends.set(b.id, b)
          p.out.set(b.id, '')
          b.onData((d) => p.out.set(b.id, p.out.get(b.id) + d))
        },
        status: (id, source, payload) => p.status.push({ id, source, payload }),
        pc: name,
        log: () => {}
      })
      return p
    }
    const cA = await connect(h.port, h.password)
    const cB = await connect(h.port, h.password)
    await installHost(cA, '2.11.0')
    // 사용자의 서버 claude 설정(있는 그대로 남아야 한다).
    const userSettings = '{\n  "model": "opus",\n  "hooks": {}\n}\n'
    await execSh(cA, `mkdir -p "$HOME/.claude" && printf '%s' '${userSettings}' > "$HOME/.claude/settings.json"`)
    // 가짜 claude: --settings 파일을 읽어 인자로 준 이벤트마다 그 훅 명령을 sh 로(claude 처럼 stdin JSON) 부르고 출력을 찍는다.
    writeFileSync(
      `${sftpRoot}/fake-claude`,
      [
        '#!/usr/bin/env python3',
        'import json, subprocess, sys',
        'a = sys.argv[1:]',
        'i = a.index("--settings")',
        'cfg = json.load(open(a[i + 1]))',
        'for spec in a[i + 2:]:',
        '    ev, _, tool = spec.partition(":")',
        '    p = {"hook_event_name": ev, "session_id": "s", "transcript_path": "/tmp/x.jsonl", "tool_response": "z" * 300000}',
        '    if tool:',
        '        p["tool_name"] = tool',
        '        p["tool_input"] = {"command": "rm -rf build"}',
        '    for g in cfg["hooks"][ev]:',
        '        for hk in g["hooks"]:',
        '            r = subprocess.run(hk["command"], shell=True, input=json.dumps(p).encode(), stdout=subprocess.PIPE)',
        '            print("HOOK %s rc=%d out=%s" % (ev, r.returncode, r.stdout.decode().strip()))',
        ''
      ].join('\n')
    )
    await execSh(cA, 'chmod 700 "$HOME/fake-claude"')
    const A = pc('PC-A')
    const B = pc('PC-B')

    // A 가 만든다 — spec 을 함수로: 서버 orcad 가 알려 준 훅 폴더로 실행 인자를 만든다(옛 orcad 면 null).
    let hookDir: string | null = null
    await A.agents.create(hostKey, cA, (dir) => {
      hookDir = dir
      return { id: 'hk', cwd: home, env: {}, meta: { agent: 'claude', title: '훅', startedAt: Date.now() } }
    })
    expect(hookDir).toBe(`${home}/.ara-server`)
    const args = remoteHookLaunch('claude', hookDir).extraArgs!
    const run = (events: string): void => A.backends.get('hk')!.write(`"$HOME/fake-claude" ${args.join(' ')} ${events}\n`)

    run('UserPromptSubmit PermissionRequest:Bash')
    await waitFor(() => /HOOK PermissionRequest rc=0 out=\{\}/.test(A.out.get('hk')!), 20_000, '훅 출력 {} · rc 0')
    await waitFor(() => A.status.some((e) => e.payload['hook_event_name'] === 'PermissionRequest'), 10_000, 'A status')
    expect(A.status.map((e) => [e.id, e.source, e.payload['hook_event_name']])).toEqual([
      ['hk', 'claude', 'UserPromptSubmit'],
      ['hk', 'claude', 'PermissionRequest']
    ])
    // 큰 필드는 서버에서 잘라 보낸다(상태·카드에 쓰는 것만).
    const perm = A.status[1].payload
    expect(perm).toEqual({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's', transcript_path: '/tmp/x.jsonl', tool_input: { command: 'rm -rf build' } })
    expect(applyHookEvent(null, 'claude', perm, 0)).toMatchObject({ state: 'blocked', kind: 'permission' })

    // B: 붙지 않고 목록 — 마지막 상태가 대장에 있다(목록 상태 칸).
    const listed = await B.agents.list(hostKey, cB)
    expect(serverStateOf(listed[0]?.status)).toBe('blocked')
    // B 가 늦게 붙는다 → attach 때 마지막 상태를 받는다.
    await B.agents.attach(hostKey, cB, ['hk'])
    await waitFor(() => B.status.some((e) => e.payload['hook_event_name'] === 'PermissionRequest'), 10_000, 'B 늦게 붙어 마지막 상태')
    expect(B.status).toEqual([{ id: 'hk', source: 'claude', payload: perm }])

    // 이제 둘 다 붙었다 — 다음 훅은 둘이 같은 것을 받는다.
    run('Stop')
    await waitFor(() => A.status.length === 3 && B.status.length === 2, 10_000, '둘 다 Stop')
    expect(A.status[2]).toEqual(B.status[1])
    expect(A.status[2].payload).toEqual({ hook_event_name: 'Stop', session_id: 's', transcript_path: '/tmp/x.jsonl' })
    expect(serverStateOf((await B.agents.list(hostKey, cB))[0]?.status)).toBe('idle')

    // 서버 사용자 설정은 그대로 · ~/.gemini 도 안 생긴다.
    const after = await execSh(cA, 'cat "$HOME/.claude/settings.json"; ls -a "$HOME/.claude"; [ -e "$HOME/.gemini" ] && echo GEMINI')
    expect(after.out).toBe(`${userSettings}.\n..\nsettings.json\n`)

    await B.agents.kill(hostKey, cB, 'hk')
    const end2 = Date.now() + 15_000
    while ((await B.agents.list(hostKey, cB)).length) {
      if (Date.now() > end2) throw new Error('시간 초과: 서버에서 끝내기')
      await new Promise((r) => setTimeout(r, 200))
    }
    cA.end()
    await execSh(cB, 'rm -rf "$HOME/.claude" "$HOME/fake-claude"')
    expect(await uninstallHost(cB)).toEqual([])
    cB.end()
  }, 180_000)

  // 3차 R3 서버 계정 — 가짜 claude(auth login 이 계정 폴더에 자격 증명 표식 파일을 만든다)로: 계정 둘 로그인 → A 로 대화 → B 로 --resume 해서
  // 공유 기록(claude-shared)의 jsonl 을 찾는다(양성 대조) · 서버 본래 로그인(~/.claude)으로는 못 찾는다(음성 대조) · 기본 계정 · 쓰는 중 지우기 거절 ·
  // 지우기 = 그 계정 폴더만(공유 기록은 남는다) · 제거 뒤 계정 폴더·자격 증명 흔적 0 · 서버 ~/.claude 바이트 그대로.
  it('서버 계정 — 로그인 · 다른 계정으로 --resume · 지우기 · 제거 흔적 0 · 서버 ~/.claude 그대로', async () => {
    const h = harness!
    const hostKey = `tester@127.0.0.1:${h.port}`
    const c = await connect(h.port, h.password)
    await installHost(c, '2.11.0')
    const userSettings = '{\n  "model": "opus"\n}\n'
    await execSh(c, `mkdir -p "$HOME/.claude" "$HOME/bin" && printf '%s' '${userSettings}' > "$HOME/.claude/settings.json"`)
    writeFileSync(
      `${sftpRoot}/bin/claude`,
      [
        '#!/usr/bin/env python3',
        'import glob, os, sys',
        'cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.environ["HOME"], ".claude")',
        'a = sys.argv[1:]',
        'if a[:2] == ["auth", "login"]:',
        '    open(os.path.join(cfg, ".credentials.json"), "w").write("{\\"fake\\": 1}")',
        '    print("LOGGED-IN " + cfg)',
        'elif a[:1] == ["new"]:',
        '    d = os.path.join(cfg, "projects", "-repo")',
        '    os.makedirs(d, exist_ok=True)',
        '    open(os.path.join(d, a[1] + ".jsonl"), "w").write("{}\\n")',
        '    print("NEW " + a[1])',
        'elif a[:1] == ["--resume"]:',
        '    hit = glob.glob(os.path.join(cfg, "projects", "*", a[1] + ".jsonl"))',
        '    print(("RESUMED " if hit else "NOT-FOUND ") + a[1] + " CFG=" + cfg)',
        ''
      ].join('\n')
    )
    await execSh(c, 'chmod 700 "$HOME/bin/claude"')

    const out = new Map<string, string>()
    const exits = new Map<string, number>()
    const backends = new Map<string, DaemonBackend>()
    const agents = createRemoteAgents({
      adopt: (b) => {
        backends.set(b.id, b)
        out.set(b.id, '')
        b.onData((d) => out.set(b.id, out.get(b.id) + d))
        b.onExit((code) => exits.set(b.id, code))
      },
      log: () => {}
    })
    const acct = async (req: Parameters<typeof agents.account>[2]): Promise<ServerAccounts> => serverAccountsOf(await agents.account(hostKey, c, req))
    const add = async (label: string): Promise<ServerAccount> => serverAccountsOf({ accounts: [await agents.account(hostKey, c, { op: 'add', agent: 'claude', label })] }).accounts[0]!
    const PATH = 'export PATH="$HOME/bin:$PATH"\n'
    let n = 0
    const run = async (account: { agent: string; id?: string | null }, line: string, meta: Record<string, unknown> = { agent: 'claude', title: 't' }): Promise<{ id: string; account: string | null | undefined }> => {
      const id = `acct-${++n}`
      const info = await agents.create(hostKey, c, { id, cwd: home, env: {}, account, meta })
      backends.get(id)!.write(PATH + line + '\n')
      return { id, account: info.account }
    }

    // 1) 계정 추가 — 설치 폴더 안, 본인만(700). 대화 기록 폴더는 claude-shared 로 링크.
    const A = await add('업무 A')
    expect(A).toMatchObject({ agent: 'claude', label: '업무 A', loggedIn: false })
    const accDir = `${home}/.ara-server/accounts`
    const perm = await execSh(c, `stat -c %a "${accDir}" "${accDir}/${A.id}" "${home}/.ara-server/claude-shared"; readlink "${accDir}/${A.id}/projects"`)
    expect(perm.out.trim().split(/\s+/)).toEqual(['700', '700', '700', `${home}/.ara-server/claude-shared/projects`])

    // 2) 로그인 칸 — 그 계정 env 로 `claude auth login; exit`(앱이 쓰는 줄 그대로) → 계정 폴더에 자격 증명 표식 · 셸이 닫힌다.
    const login = await run({ agent: 'claude', id: A.id }, accountLoginLine('claude'), { kind: 'login', title: '업무 A' })
    await waitFor(() => exits.has(login.id), 20_000, '로그인 셸 끝')
    expect(out.get(login.id)).toContain(`LOGGED-IN ${accDir}/${A.id}`)
    expect((await acct({ op: 'list' })).accounts.find((x) => x.id === A.id)?.loggedIn).toBe(true)
    // 로그인 칸은 서버 세션 목록에 안 나온다(이미 끝났지만 — 목록 거르기는 단위 시험).
    const B = await add('업무 B')
    const loginB = await run({ agent: 'claude', id: B.id }, accountLoginLine('claude'), { kind: 'login', title: '업무 B' })
    await waitFor(() => exits.has(loginB.id), 20_000, 'B 로그인 셸 끝')
    // 양성 대조: 제거 검증이 계정 폴더·자격 증명을 실제로 센다(0 이 "못 찾음"이 아님을).
    expect(remnantsOf((await execSh(c, VERIFY_SCRIPT)).out)).toEqual(expect.arrayContaining(['dir', 'accounts:2', 'creds:2']))

    // 3) A 로 대화 → B 로 --resume: 공유 기록에서 찾는다. 서버 본래 로그인(~/.claude)으로는 못 찾는다(음성 대조).
    const onA = await run({ agent: 'claude', id: A.id }, 'claude new sid-1')
    expect(onA.account).toBe(A.id)
    await waitFor(() => /NEW sid-1/.test(out.get(onA.id)!), 20_000, 'A 대화')
    const onB = await run({ agent: 'claude', id: B.id }, 'claude --resume sid-1')
    await waitFor(() => /(RESUMED|NOT-FOUND) sid-1/.test(out.get(onB.id)!), 20_000, 'B 재개')
    expect(out.get(onB.id)).toContain(`RESUMED sid-1 CFG=${accDir}/${B.id}`)
    const onBase = await run({ agent: 'claude', id: null }, 'claude --resume sid-1')
    await waitFor(() => /(RESUMED|NOT-FOUND) sid-1/.test(out.get(onBase.id)!), 20_000, '본래 로그인 재개')
    expect(onBase.account).toBeNull()
    expect(out.get(onBase.id)).toContain(`NOT-FOUND sid-1 CFG=${home}/.claude`)

    // 4) 기본 계정 — 계정을 안 정한 실행(id 없음)은 기본 계정으로.
    expect((await acct({ op: 'default', id: B.id })).default).toBe(B.id)
    const onDefault = await run({ agent: 'claude' }, 'true')
    expect(onDefault.account).toBe(B.id)
    // 없는 계정·다른 에이전트 계정은 거절.
    await expect(agents.create(hostKey, c, { id: 'bad', cwd: home, env: {}, account: { agent: 'codex', id: A.id }, meta: {} })).rejects.toThrow(/no such account/)

    // 5) 쓰는 중인 계정은 못 지운다 → 세션을 끝내면 지운다. 지우기 = 그 계정 폴더만(링크를 끊고 지운다 — 공유 기록은 남는다).
    await expect(agents.account(hostKey, c, { op: 'remove', id: A.id })).rejects.toThrow(/account in use/)
    for (const id of [onA.id, onB.id, onBase.id, onDefault.id]) await agents.kill(hostKey, c, id)
    await waitFor(() => [onA.id, onB.id, onBase.id, onDefault.id].every((id) => exits.has(id)), 20_000, '세션 끝')
    const afterRemove = await acct({ op: 'remove', id: A.id })
    expect(afterRemove.accounts.map((x) => x.id)).toEqual([B.id])
    const left = await execSh(c, `[ -e "${accDir}/${A.id}" ] && echo A-LEFT; ls "${home}/.ara-server/claude-shared/projects/-repo"`)
    expect(left.out.trim()).toBe('sid-1.jsonl')
    // 기본 계정을 지우면 기본은 서버 본래 로그인으로.
    expect((await acct({ op: 'remove', id: B.id })).default).toBeNull()

    // 6) 서버 사용자 ~/.claude 는 바이트 그대로(우리 기록·로그인은 설치 폴더 안).
    const mine = await execSh(c, 'cat "$HOME/.claude/settings.json"; ls -a "$HOME/.claude"')
    expect(mine.out).toBe(`${userSettings}.\n..\nsettings.json\n`)

    // 7) 제거 뒤 계정 폴더·자격 증명 흔적 0(계정을 하나 더 로그인해 둔 채로 — 제거가 함께 지우는지).
    const C = await add('업무 C')
    const loginC = await run({ agent: 'claude', id: C.id }, accountLoginLine('claude'), { kind: 'login', title: '업무 C' })
    await waitFor(() => exits.has(loginC.id), 20_000, 'C 로그인 셸 끝')
    agents.detach(hostKey)
    expect(await uninstallHost(c)).toEqual([])
    const gone = await execSh(c, `find "$HOME" -name .credentials.json -o -name .ara-account.json | wc -l; cat "$HOME/.claude/settings.json"`)
    expect(gone.out).toBe(`0\n${userSettings}`)
    await execSh(c, 'rm -rf "$HOME/.claude" "$HOME/bin"')
    c.end()
  }, 180_000)

  // 3차 R4 원격 채팅 보기 — 서버 claude-shared 에 jsonl 을 두고, 세션 안에서 orcad 훅(transcript_path·prompt)을 부르면 PC 가 같은 연결의 read 로
  // 읽어 채팅 블록(글·생각함·도구 요약+결과·그림 미리보기)이 나온다 · 덧붙인 줄만 증분으로 · 탭 제목은 로컬과 같은 규칙 · 경로 탈출은 orcad 가 거절.
  it('원격 채팅 보기 — 서버 transcript 를 read 로 · 증분 · 경로 탈출 거절', async () => {
    const h = harness!
    const hostKey = `tester@127.0.0.1:${h.port}`
    const c = await connect(h.port, h.password)
    await installHost(c, '2.11.0')
    const tp = `${home}/.ara-server/claude-shared/projects/-repo/s4.jsonl`
    const J = (o: unknown): string => JSON.stringify(o)
    const lines = [
      J({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: '로그인 버그 고쳐 줘' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] } }),
      J({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '원인을 본다' }, { type: 'text', text: '찾아보겠습니다' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      J({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tests  3 passed (3)' }] } })
    ]
    await execSh(c, `mkdir -p "$HOME/.ara-server/claude-shared/projects/-repo"`)
    writeFileSync(`${sftpRoot}/.ara-server/claude-shared/projects/-repo/s4.jsonl`, lines.join('\n') + '\n')
    writeFileSync(`${sftpRoot}/p.json`, J({ hook_event_name: 'UserPromptSubmit', session_id: 's4', transcript_path: tp, prompt: '로그인 버그 고쳐 줘' }))
    writeFileSync(`${sftpRoot}/secret.jsonl`, '{"secret": 1}\n')

    const status: Record<string, unknown>[] = []
    const pushed: AgentChatEvent[] = []
    let out = ''
    const backends = new Map<string, DaemonBackend>()
    const rc = createRemoteChat({ read: (id, path, offset) => agents.read(id, path, offset), push: (e) => pushed.push(e), pollMs: 100 })
    const agents = createRemoteAgents({
      adopt: (b) => {
        backends.set(b.id, b)
        b.onData((d) => (out += d))
      },
      status: (id, _source, payload) => {
        status.push(payload)
        rc.hook(id, payload)
      },
      log: () => {}
    })
    await agents.create(hostKey, c, { id: 'r4', cwd: home, env: {}, meta: { agent: 'claude', title: '채팅', startedAt: Date.now() } })
    rc.bind('r4', 'claude')
    // 훅 전 = 경로를 모른다 → 빈 화면.
    expect(await rc.open('r4')).toEqual({ messages: [], file: null })

    backends.get('r4')!.write(`python3 "$HOME/.ara-server/orcad.py" hook claude < "$HOME/p.json"; echo HOOKED\n`)
    await waitFor(() => status.length > 0, 20_000, '서버 훅')
    expect(status[0]).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 's4', transcript_path: tp, prompt: '로그인 버그 고쳐 줘' })
    expect(deriveGeneratedTabTitle(String(status[0]['prompt']))).toBeTruthy()
    await waitFor(() => pushed.length > 0, 10_000, '채팅 첫 화면')
    expect(pushed[0].reset).toBe(true)
    const [u, a] = pushed[0].messages
    expect(u.blocks).toEqual([{ type: 'text', text: '로그인 버그 고쳐 줘' }, { type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' }])
    expect(a.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool'])
    expect(a.blocks[2]).toMatchObject({ type: 'tool', name: 'Bash', result: 'Tests  3 passed (3)' })

    // 덧붙인 줄만 증분으로(바이트 오프셋) — 화면 통째로가 아니다.
    await execSh(c, `printf '%s\\n' '${J({ type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '고쳤습니다' }] } })}' >> "${tp}"`)
    await waitFor(() => pushed.length > 1, 10_000, '증분')
    expect(pushed[1].reset).toBeUndefined()
    expect(pushed[1].messages.map((m) => m.blocks)).toEqual([[{ type: 'text', text: '고쳤습니다' }]])

    // 경로 탈출 — 서버 사용자 ~/.claude·설치 폴더 밖·.. 로 빠지기·jsonl 아닌 것은 orcad 가 거절.
    for (const bad of [`${home}/.claude/projects/-repo/s4.jsonl`, `${home}/secret.jsonl`, `${home}/.ara-server/claude-shared/../../secret.jsonl`, `${home}/.ara-server/token`]) {
      await expect(agents.read('r4', bad, null), bad).rejects.toThrow('path not allowed')
    }

    // 서버 본래 로그인(~/.claude/projects) — 그 세션의 훅이 알려 준 파일 하나만, 그 세션의 요청으로만. 다른 세션·projects 밖은 거절.
    const own = `${home}/.claude/projects/-repo/own.jsonl`
    await execSh(c, 'mkdir -p "$HOME/.claude/projects/-repo"')
    writeFileSync(`${sftpRoot}/.claude/projects/-repo/own.jsonl`, lines[0] + '\n')
    writeFileSync(`${sftpRoot}/own.json`, J({ hook_event_name: 'UserPromptSubmit', session_id: 'o1', transcript_path: own }))
    writeFileSync(`${sftpRoot}/out.json`, J({ hook_event_name: 'UserPromptSubmit', session_id: 'o2', transcript_path: `${home}/secret.jsonl` }))
    await agents.create(hostKey, c, { id: 'r4b', cwd: home, env: {}, meta: { agent: 'claude', title: '밖', startedAt: Date.now() } })
    // 훅 전에는 그 세션도 못 연다.
    await expect(agents.read('r4', own, null)).rejects.toThrow('path not allowed')
    const before = status.length
    backends.get('r4')!.write(`python3 "$HOME/.ara-server/orcad.py" hook claude < "$HOME/own.json"\n`)
    backends.get('r4b')!.write(`python3 "$HOME/.ara-server/orcad.py" hook claude < "$HOME/out.json"\n`)
    await waitFor(() => status.length >= before + 2, 20_000, '두 세션 훅')
    expect((await agents.read('r4', own, null)).text).toBe(lines[0] + '\n')
    await expect(agents.read('r4b', own, null), '다른 세션').rejects.toThrow('path not allowed')
    await expect(agents.read('r4b', `${home}/secret.jsonl`, null), 'projects 밖').rejects.toThrow('path not allowed')
    // 앱 쪽도 같은 길로 화면이 나온다(훅 → remoteChat → read).
    await waitFor(() => pushed.some((e) => e.reset && e.messages.length === 1), 10_000, '본래 로그인 채팅')
    await agents.kill(hostKey, c, 'r4b')
    rc.stop()
    await agents.kill(hostKey, c, 'r4')
    expect(out).toContain('HOOKED')
    await execSh(c, 'rm -rf "$HOME/p.json" "$HOME/own.json" "$HOME/out.json" "$HOME/secret.jsonl" "$HOME/.claude"')
    agents.detach(hostKey)
    expect(await uninstallHost(c)).toEqual([])
    c.end()
  }, 120_000)
})
