// 원격 텔레메트리 (W1 F9 포트 모니터 + F10 리소스 바). SSH 세션의 ssh2 커넥션에서 읽기 전용
// 명령 하나를 주기적으로 실행하고 결과를 파싱해 렌더러로 밀어 준다.
//
// 설계 메모
// - 명령은 아래 COLLECT 한 줄로 고정이다. 렌더러가 명령을 넘길 수 있는 경로는 없다(임의 실행 금지).
// - 폴링 한 바퀴당 exec 채널 1개, 다음 바퀴는 이전 바퀴가 끝난 뒤에만 연다(busy 가드) — 느린 서버에서
//   채널이 겹쳐 쌓이지 않는다. 원격에 `while :; do …; sleep 2; done` 루프를 띄우는 방식(문자 그대로의
//   "채널 1개 재사용")은 채택하지 않았다: 연결이 끊긴 뒤 원격에 루프가 남을 수 있어서다.
// - 파싱 실패는 조용히 빈 값. 포트만 읽히는 서버에서도 목록은 나와야 하므로 stats 실패가 ports 를 지우지 않는다.
import type { Client } from 'ssh2'
import type { RemotePort, RemoteStats } from '@shared/types'
import type { TelemetryData } from '@shared/ipc'

// 폴링 주기. 2~3초 — 사람이 게이지를 보고 있을 때 "멈춘 것 같지 않은" 최저 빈도.
const POLL_MS = 2500
// 한 바퀴 상한. 응답 없는 서버가 폴러를 영구히 붙잡지 못하게 한다.
const COLLECT_TIMEOUT_MS = 10000

// 섹션 구분자 — 명령 하나로 세 가지를 읽고 여기서 잘라 쓴다.
const STAT_MARK = '__ARA_STAT__'
const GPU_MARK = '__ARA_GPU__'

// 원격에서 도는 유일한 명령(읽기 전용). ss 가 없으면 netstat, /proc 이 없으면 그 섹션만 빈다.
// GPU 는 nvidia-smi 가 있는 서버에서만.
export const COLLECT_CMD = [
  '(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null)',
  `echo ${STAT_MARK}`,
  'head -1 /proc/stat 2>/dev/null',
  'head -3 /proc/meminfo 2>/dev/null',
  `echo ${GPU_MARK}`,
  // 사용률만으로는 "지금 몇 GB 를 쓰고 있나"를 못 본다(준영님 피드백 2026-08-13). 같은 왕복에서
  // 메모리까지 받는다 — nounits 라 `45, 2048, 24576` 처럼 MiB 숫자만 온다.
  '(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)'
].join('; ')

// /proc/stat 한 줄에서 뽑은 누적 지터. CPU 사용률은 두 샘플의 차이라 직전 값을 들고 있어야 한다.
export type CpuSample = { total: number; idle: number }

// ── 파서 (순수 함수 — 픽스처 단위 테스트 대상) ──

// ss -tlnp / netstat -tlnp 의 리슨 소켓 목록. 두 형식을 한 루프에서 받는다:
//   netstat: `tcp6  0  0 :::22  :::*  LISTEN  812/sshd`
//   ss:      `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))`
// 권한이 없으면 pid/프로세스 칸이 비어 온다(그대로 비운다 — 포트는 보여야 한다).
export function parsePorts(out: string): RemotePort[] {
  const byKey = new Map<string, RemotePort>()
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const f = line.split(/\s+/)
    let addr: string
    let procField: string
    let proto: RemotePort['proto']
    if (/^tcp6?$/i.test(f[0])) {
      if (!/\bLISTEN\b/.test(line)) continue // netstat 은 -l 이 없으면 ESTABLISHED 도 섞여 온다
      addr = f[3] ?? ''
      procField = f[6] ?? ''
      proto = f[0].toLowerCase() === 'tcp6' ? 'tcp6' : 'tcp'
    } else if (f[0] === 'LISTEN') {
      addr = f[3] ?? ''
      procField = f.slice(4).join(' ') // peer 주소 + users:(…) — 아래 정규식만 걸린다
      proto = /\[|::/.test(addr) ? 'tcp6' : 'tcp'
    } else {
      continue // 헤더·빈 줄·다른 프로토콜
    }
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    // ss: users:(("sshd",pid=812,fd=3)) / netstat: 812/sshd (권한 없으면 '-')
    const ssProc = /"([^"]+)",pid=(\d+)/.exec(procField)
    const netProc = /^(\d+)\/(.+)$/.exec(procField)
    const process = ssProc?.[1] ?? netProc?.[2]
    const pid = Number(ssProc?.[2] ?? netProc?.[1])
    const key = `${proto}:${port}`
    const prev = byKey.get(key)
    // 같은 포트를 여러 주소에서 듣는 경우는 한 줄로 합친다. 프로세스 정보가 있는 쪽을 남긴다.
    if (prev && !(process && !prev.process)) continue
    byKey.set(key, {
      proto,
      port,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(process ? { process } : {})
    })
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
}

// /proc/stat 의 집계 cpu 줄 → 누적 total/idle. idle 에는 iowait 을 포함한다(대기도 놀고 있는 시간).
export function parseCpuSample(text: string): CpuSample | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return null
  const nums = line.trim().split(/\s+/).slice(1).map(Number)
  if (nums.length < 5 || nums.some((n) => !Number.isFinite(n))) return null
  const total = nums.reduce((a, b) => a + b, 0)
  const idle = nums[3] + nums[4] // idle + iowait
  return { total, idle }
}

// /proc/meminfo → 사용량. MemAvailable 이 있으면 그쪽이 진실에 가깝다(캐시를 쓸 수 있는 메모리로 친다).
export function parseMem(text: string): { memTotalKb: number; memUsedKb: number } | null {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const total = kb('MemTotal')
  if (!total) return null
  const avail = kb('MemAvailable') ?? kb('MemFree')
  if (avail === null) return null
  return { memTotalKb: total, memUsedKb: Math.max(0, total - avail) }
}

// 명령 출력 전체 → 렌더러로 보낼 값 + 다음 바퀴에 쓸 CPU 샘플.
// prev 가 없는 첫 바퀴는 CPU 사용률을 알 수 없어 0 으로 둔다(다음 바퀴부터 실값).
export function parseTelemetry(
  out: string,
  prev: CpuSample | null
): { ports: RemotePort[]; stats: RemoteStats | null; cpu: CpuSample | null } {
  const [portsPart = '', rest = ''] = splitOnce(out, STAT_MARK)
  const [statPart = '', gpuPart = ''] = splitOnce(rest, GPU_MARK)
  const ports = parsePorts(portsPart)
  const cpu = parseCpuSample(statPart)
  const mem = parseMem(statPart)
  if (!mem) return { ports, stats: null, cpu }
  return { ports, stats: { cpuPct: cpuPctOf(cpu, prev), ...mem, ...parseGpu(gpuPart) }, cpu }
}

/**
 * `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`
 * → `45, 2048, 24576`. 예전 형태(사용률 한 칸)도 그대로 받는다 — 값이 하나면 메모리만 비운다.
 * GPU 가 없는 서버는 이 조각이 통째로 비어 오고, 그러면 아무 필드도 만들지 않는다(칸 자체가 안 생긴다).
 */
export function parseGpu(part: string): Pick<RemoteStats, 'gpuPct' | 'gpuMemUsedMb' | 'gpuMemTotalMb'> {
  const line = part.trim().split('\n')[0]?.trim()
  if (!line) return {}
  const [pct, used, total] = line.split(',').map((s) => Number(s.trim()))
  if (!Number.isFinite(pct)) return {}
  const mem =
    Number.isFinite(used) && Number.isFinite(total) && total > 0
      ? { gpuMemUsedMb: Math.max(0, Math.round(used)), gpuMemTotalMb: Math.round(total) }
      : {}
  return { gpuPct: clampPct(Math.round(pct)), ...mem }
}

// 두 CPU 스냅샷의 차분 → 사용률(%). FB-0008: 로컬 텔레메트리(LocalTelemetry.ts)도 os.cpus() 스냅샷을
// 같은 모양(CpuSample)으로 만들어 이 계산을 그대로 재사용한다(원격/로컬 계산 로직 중복 금지).
export function cpuPctOf(cur: CpuSample | null, prev: CpuSample | null): number {
  if (!cur || !prev) return 0
  const dTotal = cur.total - prev.total
  const dIdle = cur.idle - prev.idle
  if (dTotal <= 0) return 0
  return clampPct(Math.round(((dTotal - dIdle) / dTotal) * 100))
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n))

function splitOnce(s: string, mark: string): [string, string] {
  const i = s.indexOf(mark)
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + mark.length)]
}

// ── 폴링 서비스 ──

export type TelemetryService = {
  // 구독 시작(이미 구독 중이면 즉시 한 바퀴 = 수동 새로고침).
  start(sessionId: string): void
  /** 구독을 늘리지 않고 즉시 한 바퀴(수동 새로고침). */
  tickNow(sessionId: string): void
  // 구독 해지 → 그 세션 폴링 중지.
  stop(sessionId: string): void
  stopAll(): void
  // 테스트용: 현재 폴링 중인 세션 수.
  activeCount(): number
}

// refs: **몇 창이 이 세션을 보고 있나.** 2026-08-21 포트 모니터 독립 창이 생기면서 한 세션을
// 두 창이 함께 볼 수 있게 됐다 — 계수가 없으면 한쪽이 닫힐 때 다른 쪽 폴링까지 멎는다.
type Sub = { timer: NodeJS.Timeout; busy: boolean; prev: CpuSample | null; refs: number }

// getClient: 세션 id → ssh2 Client(로컬·종료된 세션은 null → 폴링 자동 중지).
export function createTelemetryService(
  getClient: (sessionId: string) => Client | null,
  emit: (d: TelemetryData) => void,
  intervalMs: number = POLL_MS
): TelemetryService {
  const subs = new Map<string, Sub>()

  async function tick(sessionId: string): Promise<void> {
    const sub = subs.get(sessionId)
    if (!sub || sub.busy) return // 이전 바퀴가 아직 안 끝났으면 건너뛴다(채널 중첩 금지)
    const client = getClient(sessionId)
    if (!client) {
      stop(sessionId) // 세션이 닫혔다 — 폴러도 함께 정리
      return
    }
    sub.busy = true
    const out = await collect(client).catch(() => null)
    sub.busy = false
    if (!subs.has(sessionId) || out === null) return // 폴링 중 구독 해지 / 명령 실패는 조용히
    const { ports, stats, cpu } = parseTelemetry(out, sub.prev)
    if (cpu) sub.prev = cpu
    emit({ sessionId, ports, stats })
  }

  function stop(sessionId: string): void {
    const sub = subs.get(sessionId)
    if (!sub) return
    sub.refs--
    if (sub.refs > 0) return // 아직 보고 있는 창이 남았다
    clearInterval(sub.timer)
    subs.delete(sessionId)
  }

  return {
    start(sessionId) {
      const sub = subs.get(sessionId)
      if (sub) sub.refs++
      else
        subs.set(sessionId, {
          timer: setInterval(() => void tick(sessionId), intervalMs),
          busy: false,
          prev: null,
          refs: 1
        })
      void tick(sessionId) // 첫 화면을 주기만큼 기다리지 않게
    },
    // 수동 새로고침 — **구독을 늘리지 않고** 지금 한 바퀴만 돈다. 예전엔 이것도 start 였는데
    // 참조 계수가 생기면서 두 뜻을 가르지 않으면 새로고침마다 참조가 샌다.
    tickNow(sessionId) {
      void tick(sessionId)
    },
    stop,
    // 앱 종료 정리 — 여기서는 **참조 계수를 보지 않는다.** 계수를 통과시키면 두 창이 보던
    // 세션은 폴러가 남아 프로세스가 안 죽는다(2026-08-21 단위 테스트가 잡았다).
    stopAll() {
      for (const sub of subs.values()) clearInterval(sub.timer)
      subs.clear()
    },
    activeCount: () => subs.size
  }
}

// 명령 한 바퀴. stderr(권한 없음 등)는 버리고 stdout 만 모은다. 무응답은 타임아웃으로 끊는다.
function collect(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(COLLECT_CMD, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let out = ''
      const timer = setTimeout(() => {
        stream.close()
        resolve(out)
      }, COLLECT_TIMEOUT_MS)
      const done = (): void => {
        clearTimeout(timer)
        resolve(out)
      }
      stream.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      stream.stderr.on('data', () => {})
      stream.on('close', done)
      stream.on('error', () => done())
    })
  })
}
