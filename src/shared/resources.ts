// FD-01 자원 관리자 — 계약 + 순수 로직(집계·트리). Orca src/main/memory/process-index.ts·collector.ts
// (orcaRef 7a7f46f8a3)를 따라 줄여 옮겼다. main 의 수집기와 단위 시험이 함께 쓰므로 electron 을 import 하지 않는다.
import type { FeatureContrib } from './featureModule'

export const RESOURCES_FEATURE: FeatureContrib = { id: 'resources', settings: [], menu: [] }

/** 호스트 프로세스 한 줄. cpu = 코어 하나 기준 %(여러 코어면 100 을 넘는다), memory = 바이트(RSS·working set). */
export type ProcRow = { pid: number; ppid: number; cpu: number; memory: number }

/** 앱 프로세스 종류. Electron getAppMetrics 의 type 을 줄인 것. */
export type AppProcKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'other'
export type AppProc = { pid: number; kind: AppProcKind; name?: string; cpu: number; memory: number }

/** PTY 하나 = 셸 pid 와 그 자식 트리 전부(로컬 셸·그 안의 ssh·claude 등). SSH(ssh2) 세션은 프로세스가 없어 pid 가 없다. */
export type PtyUsage = {
  id: string
  title: string
  type: string
  pid?: number
  cpu: number
  memory: number
  procCount: number
}

export type ResourceSnapshot = {
  at: number
  app: AppProc[]
  ptys: PtyUsage[]
  /** 앱 전체(앱 프로세스 + PTY 트리). */
  total: { cpu: number; memory: number }
}

/** 상한(M4 에서 구현 — Windows Job Object / macOS). 지금은 모양만. */
export type ResourceLimit = { memoryBytes?: number; cpuPct?: number }
export type ResourceLimitTarget = { kind: 'pty'; sessionId: string } | { kind: 'agent'; agentId: string }

export function appKind(type: string): AppProcKind {
  const t = type.toLowerCase()
  if (t === 'browser') return 'main'
  if (t === 'renderer' || t === 'tab') return 'renderer'
  if (t === 'gpu') return 'gpu'
  if (t === 'utility') return 'utility'
  return 'other'
}

export function childrenIndex(rows: readonly ProcRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const r of rows) {
    const s = out.get(r.ppid)
    if (s) s.push(r.pid)
    else out.set(r.ppid, [r.pid])
  }
  return out
}

/** root 와 그 자손 pid(목록에 있는 것만). claimed 에 든 pid 는 건너뛴다 — 겹치는 트리를 두 번 세지 않는다. */
export function collectSubtree(
  byPid: ReadonlyMap<number, ProcRow>,
  childrenOf: ReadonlyMap<number, number[]>,
  root: number,
  claimed?: ReadonlySet<number>
): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid) || claimed?.has(pid)) continue
    seen.add(pid)
    if (byPid.has(pid)) out.push(pid)
    for (const k of childrenOf.get(pid) ?? []) stack.push(k)
  }
  return out
}

/** PTY 마다 셸 트리를 합산. 등록 순서대로 한 번만 센다(Orca collector 와 같은 규칙). */
export function aggregatePtys(
  rows: readonly ProcRow[],
  ptys: readonly { id: string; title: string; type: string; pid?: number }[]
): PtyUsage[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const kids = childrenIndex(rows)
  const claimed = new Set<number>()
  return ptys.map((p) => {
    let cpu = 0
    let memory = 0
    let procCount = 0
    if (p.pid != null) {
      for (const pid of collectSubtree(byPid, kids, p.pid, claimed)) {
        const r = byPid.get(pid) as ProcRow
        claimed.add(pid)
        cpu += r.cpu
        memory += r.memory
        procCount++
      }
    }
    return { ...p, cpu, memory, procCount }
  })
}

export function snapshotOf(app: AppProc[], ptys: PtyUsage[], at = Date.now()): ResourceSnapshot {
  const sum = (xs: { cpu: number; memory: number }[]) =>
    xs.reduce((a, x) => ({ cpu: a.cpu + x.cpu, memory: a.memory + x.memory }), { cpu: 0, memory: 0 })
  return { at, app, ptys, total: sum([...app, ...ptys]) }
}

/** `ps -eo pid=,ppid=,pcpu=,rss=` 출력(rss = KB). */
export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4) continue
    const pid = parseInt(f[0], 10)
    const ppid = parseInt(f[1], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue
    const cpu = parseFloat(f[2])
    const kb = parseInt(f[3], 10)
    rows.push({ pid, ppid, cpu: cpu > 0 ? cpu : 0, memory: kb > 0 ? kb * 1024 : 0 })
  }
  return rows
}

/** Windows CIM 한 줄: pid \t ppid \t workingSet \t (kernel+user, 100ns 단위). cpu 는 두 표본의 차로 나중에 채운다. */
export type WinSample = { rows: ProcRow[]; ticks: Map<number, number> }

export function parseWinCim(stdout: string): WinSample {
  const rows: ProcRow[] = []
  const ticks = new Map<number, number>()
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split('\t')
    if (f.length < 4) continue
    const pid = parseInt(f[0], 10)
    const ppid = parseInt(f[1], 10)
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue
    const ws = Number(f[2])
    const t = Number(f[3])
    rows.push({ pid, ppid, cpu: 0, memory: ws > 0 ? ws : 0 })
    if (Number.isFinite(t)) ticks.set(pid, t)
  }
  return { rows, ticks }
}

const TICKS_PER_MS = 10_000

/** 이전 표본과의 CPU 시간 차 → %. 카운터가 줄었으면(pid 재사용) 0 으로 둔다. */
export function applyWinCpu(cur: WinSample, prev: WinSample | null, elapsedMs: number, cores: number): ProcRow[] {
  if (!prev || elapsedMs <= 0) return cur.rows
  const max = Math.max(1, cores) * 100
  for (const r of cur.rows) {
    const a = prev.ticks.get(r.pid)
    const b = cur.ticks.get(r.pid)
    if (a === undefined || b === undefined || b < a) continue
    r.cpu = Math.min(max, ((b - a) / TICKS_PER_MS / elapsedMs) * 100)
  }
  return cur.rows
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  return Math.round(n / 1024) + ' KB'
}
