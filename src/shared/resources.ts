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
  /** AI 작업 공간 에이전트 탭(로컬 데몬 세션 포함) — 상한(AgentLimits)이 걸리는 줄. */
  agent?: boolean
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
  /** 에이전트 상한(설정 › 에이전트) — 팝오버가 보여 준다. */
  agentLimits: AgentLimits
}

/**
 * M4 에이전트 자원 상한(설정 › 에이전트 › 자원). 로컬 데몬이 적용한다 — 새 네이티브 의존 없이:
 *  · lowPriority: 에이전트 셸(과 그 자손)을 낮은 우선순위로(os.setPriority). 자식은 부모 우선순위를 물려받는다.
 *  · memoryBytes: 세션 트리 작업 세트가 넘으면 알림만(자동 종료 안 함). 0 = 끔.
 * ponytail: 하드 상한(Windows Job Object·cgroup)이 아니다 — 넘어도 OS 가 막지 않는다. 필요하면 네이티브 의존과 함께 2차.
 */
export type AgentLimits = { lowPriority: boolean; memoryBytes: number }
export const NO_AGENT_LIMITS: AgentLimits = { lowPriority: false, memoryBytes: 0 }

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
  ptys: readonly { id: string; title: string; type: string; pid?: number; agent?: boolean }[]
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

export function snapshotOf(app: AppProc[], ptys: PtyUsage[], at = Date.now(), agentLimits: AgentLimits = NO_AGENT_LIMITS): ResourceSnapshot {
  const sum = (xs: { cpu: number; memory: number }[]) =>
    xs.reduce((a, x) => ({ cpu: a.cpu + x.cpu, memory: a.memory + x.memory }), { cpu: 0, memory: 0 })
  return { at, app, ptys, total: sum([...app, ...ptys]), agentLimits }
}

/**
 * 우선순위를 낮출 pid — roots(에이전트 셸) 트리 전부에서 이미 낮춘 것(done)을 뺀다.
 * 셸을 띄울 때 한 번 낮추면 자식은 물려받지만, 스스로 우선순위를 되돌리는 도구가 있어 표본마다 트리를 다시 본다.
 */
export function priorityTargets(rows: readonly ProcRow[], roots: readonly number[], done: ReadonlySet<number>): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const kids = childrenIndex(rows)
  const out = new Set<number>()
  for (const root of roots) for (const pid of collectSubtree(byPid, kids, root)) if (!done.has(pid)) out.add(pid)
  return [...out]
}

/**
 * 메모리 상한 판정 — **넘어설 때 한 번만** 알린다. over 는 이미 알린 세션(호출 사이에 들고 다닌다):
 * 상한 아래로 내려오거나 세션이 없어지면 빠져서 다시 넘으면 또 알린다. cap 0 = 끔(아무것도 안 알리고 비운다).
 * 돌려주는 것 = 이번에 새로 넘은 세션.
 */
export function overMemory(usage: readonly { id: string; memory: number }[], cap: number, over: Set<string>): { id: string; memory: number }[] {
  const fresh: { id: string; memory: number }[] = []
  const seen = new Set<string>()
  for (const u of usage) {
    seen.add(u.id)
    if (cap > 0 && u.memory > cap) {
      if (!over.has(u.id)) fresh.push(u)
      over.add(u.id)
    } else over.delete(u.id)
  }
  for (const id of over) if (!seen.has(id)) over.delete(id)
  return fresh
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
