// 오류 신고 #11(2026-10-08) — 컨테이너 시작·새로 만들기 전에 **포트·이름 충돌을 먼저 본다**.
//
// 준영님: "시작을 누르고 같은 이름이 있으면 제거할 거냐 물어보고, 8512 포트를 이미 다른 것이 쓰면
// 만들기 전에 어떤 컨테이너가 쓰고 있는지 알려 주고 제거할 거냐 — 이런 프로세스가 없어서 불편하다."
//
// 여기는 전부 순수 함수다(tests/ctrConflict.test.ts). 화면(ContainerTable)은 결과로 다이얼로그만 고른다.
// 원격 명령은 remoteCatalog 의 표(ctr.list · ctr.ports · ctr.action · ctr.run)만 지난다.

import {
  CTR_RESTARTS,
  PORTS_PB,
  PORTS_SS,
  validCtrName,
  validEnvLine,
  validImageRef,
  validPortSpec,
  type CtrRow
} from './remoteCatalog'

/** 호스트 쪽 포트 하나. ip 가 '' 면 모든 주소(0.0.0.0 · ::). */
export type HostPort = { ip: string; port: number; proto: string }
/** 이 호스트에서 듣고 있는 소켓(ss). 권한이 없으면 proc·pid 가 안 온다. */
export type Listener = HostPort & { proc: string | null; pid: number | null }

const WILD = new Set(['', '0.0.0.0', '::', '*'])
const normIp = (ip: string): string => {
  const s = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  return WILD.has(s) ? '' : s
}

/** 두 바인딩이 같은 자리를 다투나 — 한쪽이 전체 주소면 다툰다, 둘 다 특정 주소면 같을 때만. */
export function portsClash(a: HostPort, b: HostPort): boolean {
  if (a.port !== b.port || a.proto !== b.proto) return false
  const x = normIp(a.ip)
  const y = normIp(b.ip)
  return x === '' || y === '' || x === y
}

// 범위(`8000-8002`)를 펼친다. 상한은 이상한 입력에 매달리지 않게.
function expand(from: number, to: number): number[] {
  if (!(to >= from) || to - from > 1000) return [from]
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/**
 * `docker ps` 의 Ports 칸 → 호스트에 publish 된 포트.
 * `0.0.0.0:8512->6379/tcp, :::8512->6379/tcp` · `[::]:8512->6379/tcp` · `0.0.0.0:8000-8002->8000-8002/tcp`.
 * `6379/tcp`(EXPOSE 만, publish 안 함)는 호스트를 안 잡으므로 건너뛴다.
 */
export function parsePsPorts(ports: string): HostPort[] {
  const out: HostPort[] = []
  for (const raw of ports.split(',')) {
    const m = /^(.*):(\d+)(?:-(\d+))?->[\d-]+\/(\w+)$/.exec(raw.trim())
    if (!m) continue
    const from = Number(m[2])
    for (const port of expand(from, m[3] ? Number(m[3]) : from)) out.push({ ip: normIp(m[1]), port, proto: m[4] })
  }
  return out
}

/**
 * `inspect --format '{{json .HostConfig.PortBindings}}'` → 그 컨테이너가 잡으려는 호스트 포트.
 * `null`·`{}` 는 빈 목록(publish 없음), 읽을 수 없는 출력(없는 컨테이너·런타임 없음)은 null(모름).
 * HostPort 가 빈 칸이면 런타임이 아무 포트나 고른다 — 다툴 일이 없어 뺀다.
 */
export function parseBindings(json: string): HostPort[] | null {
  let v: unknown
  try {
    v = JSON.parse(json.trim())
  } catch {
    return null
  }
  if (v === null) return []
  if (typeof v !== 'object' || Array.isArray(v)) return null
  const out: HostPort[] = []
  for (const [key, list] of Object.entries(v as Record<string, unknown>)) {
    const proto = key.split('/')[1] ?? 'tcp'
    if (!Array.isArray(list)) continue
    for (const b of list as { HostIp?: unknown; HostPort?: unknown }[]) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(String(b?.HostPort ?? ''))
      if (!m) continue
      const from = Number(m[1])
      for (const port of expand(from, m[2] ? Number(m[2]) : from))
        out.push({ ip: normIp(String(b?.HostIp ?? '')), port, proto })
    }
  }
  return out
}

/**
 * `ss -ltunp` → 리스너. 머리줄(`Netid …`)은 건너뛴다(-H 를 모르는 옛 ss).
 * `tcp LISTEN 0 511 0.0.0.0:8512 0.0.0.0:* users:(("docker-proxy",pid=2345,fd=4))`
 */
export function parseSs(out: string): Listener[] {
  const rows: Listener[] = []
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5 || (f[0] !== 'tcp' && f[0] !== 'udp')) continue
    const local = f[4]
    const i = local.lastIndexOf(':')
    const port = Number(local.slice(i + 1))
    if (i < 0 || !Number.isInteger(port) || port <= 0) continue
    const p = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
    rows.push({ ip: normIp(local.slice(0, i)), port, proto: f[0], proc: p ? p[1] : null, pid: p ? Number(p[2]) : null })
  }
  return rows
}

/** ctr.ports 출력 → 두 칸. 바인딩은 id 를 안 줬거나 못 읽었으면 null. */
export function parsePortsProbe(out: string): { bindings: HostPort[] | null; listeners: Listener[] } {
  const pb = out.indexOf(PORTS_PB)
  const ss = out.indexOf(PORTS_SS)
  if (pb < 0 || ss < 0) return { bindings: null, listeners: [] }
  const body = out.slice(pb + PORTS_PB.length, ss).trim()
  return { bindings: body === '' ? null : parseBindings(body), listeners: parseSs(out.slice(ss + PORTS_SS.length)) }
}

/** 포트 매핑 줄들(`8512:6379`) → 호스트 포트. 형식 검증은 remoteCatalog 의 것과 같은 함수다. */
export function specsToHostPorts(specs: readonly string[]): HostPort[] {
  return specs.flatMap((s) => {
    const p = validPortSpec(s)
    return p ? [{ ip: normIp(p.ip), port: p.host, proto: p.proto }] : []
  })
}

/** 포트를 실제로 잡고 있는 상태 — 멈춘(exited·created·dead) 컨테이너는 포트를 안 쥔다. */
const HOLDS = (state: string): boolean => !['exited', 'created', 'dead', 'removing'].includes(state)

export type CtrClash = { id: string; name: string; image: string; state: string; port: HostPort }
export type ProcClash = { port: HostPort; proc: string | null; pid: number | null }
export type Conflicts = { ctrs: CtrClash[]; procs: ProcClash[] }

/**
 * 원하는 포트 × (실행 중인 컨테이너 · 리스너) → 누가 막고 있나.
 * `skip` 은 계산에서 뺄 컨테이너(시작하려는 그 자신 · 어차피 지울 같은 이름).
 * 컨테이너가 이미 설명한 포트는 리스너에서 다시 세지 않는다(docker-proxy 가 그 자리에 보인다).
 */
export function findConflicts(
  want: readonly HostPort[],
  rows: readonly CtrRow[],
  listeners: readonly Listener[],
  skip: readonly string[] = []
): Conflicts {
  const ctrs: CtrClash[] = []
  const procs: ProcClash[] = []
  for (const w of want) {
    let hit = false
    for (const r of rows) {
      if (skip.includes(r.id) || !HOLDS(r.state)) continue
      if (parsePsPorts(r.ports).some((p) => portsClash(p, w))) {
        hit = true
        if (!ctrs.some((c) => c.id === r.id && c.port.port === w.port))
          ctrs.push({ id: r.id, name: r.name, image: r.image, state: r.state, port: w })
      }
    }
    if (hit) continue
    const l = listeners.find((x) => portsClash(x, w))
    if (l) procs.push({ port: w, proc: l.proc, pid: l.pid })
  }
  return { ctrs, procs }
}

/**
 * 다이얼로그 갈래. 컨테이너만 막고 있으면 [정지하고 …][제거하고 …][취소] 를 줄 수 있고,
 * 컨테이너가 아닌 프로세스가 하나라도 끼면 **안내만** 한다(그 프로세스를 죽이는 버튼은 없다).
 */
export function conflictChoice(c: Conflicts): 'none' | 'resolve' | 'info' {
  if (c.procs.length > 0) return 'info'
  return c.ctrs.length > 0 ? 'resolve' : 'none'
}

/** 시작이 포트 때문에 실패했나 — 사전 확인과 시작 사이에 누가 끼어든 경합. docker·podman 문구 둘 다. */
export function isPortClash(out: string): boolean {
  return /port is already allocated|address already in use/i.test(out)
}

/** 같은 컨테이너를 두 번 멈추거나 지우지 않게 id 로 모은다. */
export function uniqueCtrs(c: readonly CtrClash[]): CtrClash[] {
  return c.filter((x, i) => c.findIndex((y) => y.id === x.id) === i)
}

/** 컨테이너를 지우기 전에 먼저 멈춰야 하나(`rm -f` 를 안 쓴다 — ContainerTable.ctrActions 규칙). */
export const needsStop = (state: string): boolean => HOLDS(state)

/**
 * [새 컨테이너] 입력칸 → ctr.run 인자. 형식이 틀린 칸이 있으면 그 칸 이름을 돌려준다
 * (화면이 그 칸 아래에 이유를 쓴다). 빈 줄은 버린다.
 */
export type RunForm = { image: string; name: string; ports: string; env: string; restart: string; cmd: string }
export type RunFormResult =
  | {
      ok: true
      args: { image: string; name?: string; ports: string[]; env: string[]; restart: string; cmd?: string }
      want: HostPort[]
    }
  | { ok: false; field: keyof RunForm; line?: string }

export function parseRunForm(f: RunForm): RunFormResult {
  const lines = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
  const image = f.image.trim()
  if (validImageRef(image) === null) return { ok: false, field: 'image' }
  const name = f.name.trim()
  if (name !== '' && validCtrName(name) === null) return { ok: false, field: 'name' }
  const ports = lines(f.ports)
  const badPort = ports.find((p) => validPortSpec(p) === null)
  if (badPort !== undefined) return { ok: false, field: 'ports', line: badPort }
  // env 는 값 앞뒤 공백이 의미일 수 있어 줄 끝만 다듬지 않는다 — 빈 줄만 버린다.
  const env = f.env.split(/\r?\n/).filter((l) => l.trim() !== '')
  const badEnv = env.find((e) => validEnvLine(e) === null)
  // 비밀값이 든 줄일 수 있다 — 어느 줄인지는 **키만** 돌려준다.
  if (badEnv !== undefined) return { ok: false, field: 'env', line: badEnv.split('=')[0].slice(0, 40) }
  if (!(CTR_RESTARTS as readonly string[]).includes(f.restart)) return { ok: false, field: 'restart' }
  const cmd = f.cmd.trim()
  // eslint-disable-next-line no-control-regex
  if (/[\0\r\n]/.test(cmd)) return { ok: false, field: 'cmd' }
  return {
    ok: true,
    args: { image, ...(name ? { name } : {}), ports, env, restart: f.restart, ...(cmd ? { cmd } : {}) },
    want: specsToHostPorts(ports)
  }
}
