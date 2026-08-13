// W1 F9/F10/F13 검증 — 파서 픽스처(순수 함수) + 폴링 수명(구독 0이면 중지) +
// ssh2 하네스로 exec 폴링·tail 스트림 실증(실서버 접속 없음).
import { describe, it, expect, afterEach } from 'vitest'
import type { Client, ServerChannel } from 'ssh2'
import { connectSsh, type SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { SHELL_PID_CMD } from '../src/main/sessions/ssh/remoteCwd'
import {
  COLLECT_CMD,
  createTelemetryService,
  parseCpuSample,
  parseMem,
  parsePorts,
  parseTelemetry,
  parseGpu
} from '../src/main/telemetry/RemoteTelemetry'
import { createLogTailService, shQuote } from '../src/main/telemetry/LogTail'
import { gaugesOf, statusModel } from '../src/renderer/components/StatusBar'
import { fileMenu } from '../src/renderer/interactions/actions'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { Session } from '../src/renderer/store/sessions'
import type { SshProfile } from '../src/shared/types'
import type { TelemetryData, LogTailData, LogTailExit } from '../src/shared/ipc'

// ── 픽스처 ──

// ss -tlnp: 권한이 있으면 users:(("proc",pid=N,fd=M)), 없으면 그 칸이 통째로 빈다.
const SS_OUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=812,fd=3))
LISTEN 0      511        127.0.0.1:8080       0.0.0.0:*     users:(("node",pid=2451,fd=18))
LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=812,fd=4))
LISTEN 0      70         127.0.0.1:33060      0.0.0.0:*
`

// netstat -tlnp 폴백 형식. 마지막 줄은 권한 없음('-') + ESTABLISHED 섞임(리슨만 골라야 한다).
const NETSTAT_OUT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address     Foreign Address    State       PID/Program name
tcp        0      0 0.0.0.0:22        0.0.0.0:*          LISTEN      812/sshd
tcp        0      0 127.0.0.1:5432    0.0.0.0:*          LISTEN      -
tcp6       0      0 :::443            :::*               LISTEN      1180/nginx: master
tcp        0      0 10.0.0.5:22       10.0.0.9:51234     ESTABLISHED 3312/sshd
`

const STAT_OUT = (busy: number): string =>
  `cpu  ${busy} 0 ${busy} 10000 100 0 0 0 0 0
MemTotal:       32869180 kB
MemFree:         2100340 kB
MemAvailable:   20481024 kB
`

const collectOut = (ports: string, busy: number, gpu?: string): string =>
  `${ports}__ARA_STAT__\n${STAT_OUT(busy)}__ARA_GPU__\n${gpu ?? ''}`

describe('포트 파서', () => {
  it('ss -tlnp 출력에서 포트·프로세스·PID 를 뽑는다', () => {
    const ports = parsePorts(SS_OUT)
    expect(ports.map((p) => p.port)).toEqual([22, 22, 8080, 33060])
    expect(ports[0]).toEqual({ proto: 'tcp', port: 22, pid: 812, process: 'sshd' })
    // IPv6 는 [::]:22 형태 — 주소 모양으로 판별한다(ss 는 -t 필터 시 Netid 열을 찍지 않는다).
    expect(ports[1].proto).toBe('tcp6')
    expect(ports.find((p) => p.port === 8080)).toEqual({ proto: 'tcp', port: 8080, pid: 2451, process: 'node' })
  })

  it('권한이 없어 프로세스 칸이 비어도 포트는 남는다', () => {
    const row = parsePorts(SS_OUT).find((p) => p.port === 33060)!
    expect(row.process).toBeUndefined()
    expect(row.pid).toBeUndefined()
  })

  it('netstat 폴백 형식도 같은 결과로 파싱한다(리슨 아닌 줄은 버린다)', () => {
    const ports = parsePorts(NETSTAT_OUT)
    // 정렬은 포트 번호 오름차순(주소 순서가 아니라) — 사람이 포트를 찾는 순서다.
    expect(ports.map((p) => `${p.proto}:${p.port}`)).toEqual(['tcp:22', 'tcp6:443', 'tcp:5432'])
    expect(ports.find((p) => p.port === 443)!.process).toBe('nginx:')
    expect(ports.find((p) => p.port === 5432)!.pid).toBeUndefined() // PID 칸이 '-'
  })

  it('헤더·빈 줄·쓰레기 입력은 조용히 무시한다', () => {
    expect(parsePorts('')).toEqual([])
    expect(parsePorts('command not found\n\n???')).toEqual([])
  })
})

describe('리소스 파서', () => {
  it('/proc/stat 집계 줄에서 total·idle 을 뽑는다(idle=idle+iowait)', () => {
    const s = parseCpuSample(STAT_OUT(500))!
    expect(s.idle).toBe(10100)
    expect(s.total).toBe(500 + 500 + 10000 + 100)
  })

  it('/proc/meminfo 는 MemAvailable 기준으로 사용량을 낸다', () => {
    const m = parseMem(STAT_OUT(0))!
    expect(m.memTotalKb).toBe(32869180)
    expect(m.memUsedKb).toBe(32869180 - 20481024)
  })

  it('/proc 이 없는 서버는 stats 만 null 이고 포트 목록은 살아 있다', () => {
    const r = parseTelemetry(`${SS_OUT}__ARA_STAT__\n__ARA_GPU__\n`, null)
    expect(r.stats).toBeNull()
    expect(r.ports.length).toBe(4)
  })

  it('CPU 사용률은 두 샘플의 차이 — 첫 바퀴는 0, 다음 바퀴부터 실값', () => {
    const first = parseTelemetry(collectOut(SS_OUT, 1000), null)
    expect(first.stats!.cpuPct).toBe(0)
    // 다음 샘플: busy 가 2000 씩(user+system) 늘고 idle 은 그대로 → 100%
    const second = parseTelemetry(collectOut(SS_OUT, 3000), first.cpu)
    expect(second.stats!.cpuPct).toBe(100)
  })

  it('nvidia-smi 가 없으면 gpuPct 는 아예 없다', () => {
    expect(parseTelemetry(collectOut(SS_OUT, 100), null).stats!.gpuPct).toBeUndefined()
    expect(parseTelemetry(collectOut(SS_OUT, 100, '37\n'), null).stats!.gpuPct).toBe(37)
  })

  it('GPU 메모리 사용량/총량도 같은 줄에서 읽는다', () => {
    const s = parseTelemetry(collectOut(SS_OUT, 100, '45, 2048, 24576\n'), null).stats!
    expect(s.gpuPct).toBe(45)
    expect(s.gpuMemUsedMb).toBe(2048)
    expect(s.gpuMemTotalMb).toBe(24576)
  })
})

// 이 조각만 따로 본다 — nvidia-smi 형태가 서버마다 갈리는 자리다.
describe('GPU 조각 파싱', () => {
  it('빈 줄이면 아무 필드도 만들지 않는다(칸 자체가 안 생겨야 한다)', () => {
    expect(parseGpu('')).toEqual({})
    expect(parseGpu('\n  \n')).toEqual({})
  })

  it('사용률만 오는 예전 형태도 받는다 — 메모리만 비운다', () => {
    expect(parseGpu('61\n')).toEqual({ gpuPct: 61 })
  })

  it('총량이 0 이거나 숫자가 아니면 메모리를 싣지 않는다(0 나눗셈·NaN 방지)', () => {
    expect(parseGpu('61, 0, 0')).toEqual({ gpuPct: 61 })
    expect(parseGpu('61, [N/A], [N/A]')).toEqual({ gpuPct: 61 })
  })

  it('사용률이 숫자가 아니면 통째로 버린다', () => {
    expect(parseGpu('[N/A], 1, 2')).toEqual({})
  })

  it('사용률은 0~100 으로 자른다', () => {
    expect(parseGpu('140, 1, 2').gpuPct).toBe(100)
  })
})

describe('폴링 수명', () => {
  // exec 을 세는 가짜 클라이언트. 명령을 받으면 픽스처를 흘리고 채널을 닫는다.
  function fakeClient(onExec: () => void): Client {
    return {
      exec(_cmd: string, cb: (err: Error | null, stream: unknown) => void) {
        onExec()
        const handlers = new Map<string, ((c?: Buffer) => void)[]>()
        const on = (ev: string, fn: (c?: Buffer) => void): unknown => {
          handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
          return null
        }
        const stream = { on, stderr: { on }, close: () => {} }
        cb(null, stream)
        setImmediate(() => {
          for (const fn of handlers.get('data') ?? []) fn(Buffer.from(collectOut(SS_OUT, 100)))
          for (const fn of handlers.get('close') ?? []) fn()
        })
      }
    } as unknown as Client
  }

  it('start 는 즉시 한 바퀴 돌고, stop 이후에는 폴링이 멈춘다', async () => {
    let execs = 0
    const got: TelemetryData[] = []
    const svc = createTelemetryService(() => fakeClient(() => (execs += 1)), (d) => got.push(d), 20)
    svc.start('s1')
    await wait(80)
    expect(svc.activeCount()).toBe(1)
    expect(got[0].ports.length).toBe(4)
    svc.stop('s1')
    const after = execs
    await wait(80)
    expect(svc.activeCount()).toBe(0)
    expect(execs).toBe(after) // 구독 0 → 더 이상 명령을 보내지 않는다
  })

  it('세션이 사라지면(클라이언트 null) 폴러가 스스로 정리된다', async () => {
    const svc = createTelemetryService(() => null, () => {}, 20)
    svc.start('gone')
    await wait(40)
    expect(svc.activeCount()).toBe(0)
  })

  it('같은 세션에 start 를 두 번 불러도 폴러는 하나다(= 새로고침)', async () => {
    const svc = createTelemetryService(() => fakeClient(() => {}), () => {}, 50)
    svc.start('s1')
    svc.start('s1')
    expect(svc.activeCount()).toBe(1)
    svc.stopAll()
    expect(svc.activeCount()).toBe(0)
  })
})

describe('F10 상태바 게이지 · F13 메뉴 항목', () => {
  const sshSession = { id: 's1', type: 'ssh', title: '결제서버', serverKey: '결제서버' } as Session
  const localSession = { id: 's2', type: 'local', title: '셸 1', serverKey: 'local' } as Session
  const stats = { cpuPct: 34, memUsedKb: 13002342, memTotalKb: 32869180 }

  it('FB-0008: SSH·로컬 모두 stats 가 있으면 게이지가 붙고, 없으면 빈다', () => {
    expect(statusModel(sshSession, undefined, {}, null, stats).gauges.map((g) => g.key)).toEqual(['cpu', 'mem'])
    expect(statusModel(localSession, undefined, {}, null, stats).gauges.map((g) => g.key)).toEqual(['cpu', 'mem'])
    expect(statusModel(sshSession, undefined, {}, null, null).gauges).toEqual([])
    expect(statusModel(localSession, undefined, {}, null, null).gauges).toEqual([])
    expect(statusModel(null, undefined, {}, null, stats).gauges).toEqual([]) // 세션 없음 → idle, 게이지 없음
  })

  it('메모리는 GiB 표기 + 사용률 막대, GPU 는 값이 있을 때만 칸이 생긴다', () => {
    const g = gaugesOf(stats)
    expect(g[1].text).toBe('12.4/31.3G')
    expect(g[1].pct).toBe(40)
    expect(gaugesOf({ ...stats, gpuPct: 61 }).map((x) => x.key)).toEqual(['cpu', 'mem', 'gpu'])
  })

  it('[tail로 보기]는 원격 파일 하나를 골랐을 때만 뜬다', () => {
    const ids = (ctx: Parameters<typeof fileMenu>[0]) => fileMenu(ctx).map((m) => m.id)
    expect(ids({ count: 1, isDir: false, canDownload: true, canTail: true })).toContain('file.tail')
    // 폴더·다중 선택·로컬 세션에는 붙지 않는다.
    expect(ids({ count: 1, isDir: true, canDownload: false, canTail: true })).not.toContain('file.tail')
    expect(ids({ count: 3, isDir: false, canDownload: true, canTail: true })).not.toContain('file.tail')
    expect(ids({ count: 1, isDir: false, canDownload: false, canTail: false })).not.toContain('file.tail')
  })
})

describe('로그 tail 경로 인용', () => {
  it("작은따옴표가 든 경로도 셸에서 한 인자로 남는다", () => {
    expect(shQuote('/var/log/app.log')).toBe("'/var/log/app.log'")
    expect(shQuote("/tmp/it's; rm -rf /")).toBe("'/tmp/it'\\''s; rm -rf /'")
  })

  it('SSH 세션이 아니면 exit 이벤트로 사유가 온다', async () => {
    const exits: LogTailExit[] = []
    const svc = createLogTailService(() => null, () => {}, (d) => exits.push(d))
    svc.start('local-session', '/var/log/x.log')
    await wait(20)
    expect(exits[0].error).toContain('SSH')
    expect(svc.activeCount()).toBe(0)
  })
})

// ── ssh2 하네스 통합(실서버 없음) ──

let harness: Harness | null = null
let backend: SshBackend | null = null

afterEach(async () => {
  backend?.kill()
  backend = null
  await harness?.close()
  harness = null
})

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

async function connect(): Promise<Client> {
  const res = await connectSsh(pwProfile(harness!.port), {
    knownHosts: {},
    secret: harness!.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  backend = res.backend
  return res.backend.sshClient()!
}

describe('ssh2 하네스 exec 폴링', () => {
  it('실제 exec 채널로 수집 명령을 보내고 파싱 결과를 방출한다', async () => {
    const commands: string[] = []
    let round = 0
    harness = await startPasswordServer({
      execHandler: (command, stream: ServerChannel) => {
        // SshBackend 가 접속 직후 한 번 보내는 셸 PID 질의(remoteCwd)는 폴링과 무관하다 — 빈 답만 주고 뺀다.
        if (command === SHELL_PID_CMD) {
          stream.exit(0)
          stream.end()
          return
        }
        commands.push(command)
        round += 1
        // 두 번째 바퀴부터 CPU 가 돌기 시작한 서버를 흉내 낸다.
        stream.write(collectOut(SS_OUT, round === 1 ? 1000 : 3000, '18\n'))
        stream.exit(0)
        stream.end()
      }
    })
    const client = await connect()
    const got: TelemetryData[] = []
    const svc = createTelemetryService((id) => (id === 'sid' ? client : null), (d) => got.push(d), 60)
    svc.start('sid')
    await waitFor(() => got.length >= 2, 4000)
    svc.stop('sid')

    // 보낸 명령은 고정된 수집 명령 하나뿐이다(임의 명령 실행 경로 없음).
    expect(new Set(commands)).toEqual(new Set([COLLECT_CMD]))
    expect(got[0].sessionId).toBe('sid')
    expect(got[0].ports.find((p) => p.port === 8080)!.process).toBe('node')
    expect(got[0].stats!.cpuPct).toBe(0) // 첫 바퀴는 기준점
    expect(got[1].stats!.cpuPct).toBeGreaterThan(0)
    expect(got[1].stats!.gpuPct).toBe(18)
    expect(got[1].stats!.memTotalKb).toBe(32869180)

    const sent = commands.length
    await wait(150)
    expect(commands.length).toBe(sent) // stop 이후 폴링 없음
  })
})

describe('ssh2 하네스 tail 스트림', () => {
  it('tail 출력을 청크로 흘리고, stop 하면 원격 채널이 닫힌다', async () => {
    let tailCmd = ''
    let closed = false
    let timer: NodeJS.Timeout | null = null
    harness = await startPasswordServer({
      execHandler: (command, stream: ServerChannel) => {
        tailCmd = command
        stream.write('배포 시작\r\n')
        // 채널이 열려 있는 동안 계속 흘린다 — 닫히면(사용자가 뷰어를 닫으면) 멈춰야 한다.
        timer = setInterval(() => stream.write('.\r\n'), 30)
        // 클라이언트가 채널을 닫으면 ssh2 서버 채널은 'finish'(쓰기측 종료)로 알려 온다.
        // 실서버(sshd)는 이 시점에 세션 프로세스 그룹에 SIGHUP 을 보내 tail 을 죽인다 —
        // 하네스는 죽일 프로세스가 없으므로 "닫힘이 원격까지 갔다"까지만 확인한다.
        for (const ev of ['finish', 'close']) {
          stream.on(ev, () => {
            closed = true
            if (timer) clearInterval(timer)
          })
        }
      }
    })
    const client = await connect()
    const chunks: LogTailData[] = []
    const exits: LogTailExit[] = []
    const svc = createLogTailService(
      (id) => (id === 'sid' ? client : null),
      (d) => chunks.push(d),
      (d) => exits.push(d)
    )
    const id = svc.start('sid', "/var/log/배포'로그.log")
    await waitFor(() => chunks.length >= 2, 4000)

    // 경로는 인용돼 한 인자로 들어간다. 명령은 tail 고정.
    // -n 0: 과거는 뷰어가 SFTP 창 읽기로 가져온다 — tail 이 같이 뱉으면 그 창과 겹쳐 두 번 보인다.
    expect(tailCmd).toBe(`tail -n 0 -F -- '/var/log/배포'\\''로그.log'`)
    expect(chunks[0].id).toBe(id)
    expect(chunks[0].chunk).toContain('배포 시작')
    expect(chunks[0].chunk).not.toContain('\r') // pty CRLF 정리

    svc.stop(id)
    await waitFor(() => closed, 4000)
    expect(svc.activeCount()).toBe(0)
    // 사용자가 닫은 경우는 exit 이벤트를 쏘지 않는다(뷰어가 이미 사라졌다).
    expect(exits).toEqual([])
    if (timer) clearInterval(timer)
  })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('조건이 시간 안에 만족되지 않았습니다')
    await wait(10)
  }
}
