// FD-01 자원 관리자 — 기능 틀(docs/feature-module.md)의 main 등록 함수. Orca src/main/memory/collector.ts
// (orcaRef 7a7f46f8a3)를 따라: 앱 프로세스는 Electron getAppMetrics, PTY 는 호스트 프로세스 표에서 셸 트리 합산.
// 수집은 렌더러가 물을 때만 한다(팝오버가 열린 동안 2초마다) — 상시 폴러가 없다.
import { app } from 'electron'
import os from 'node:os'
import { handle } from '../ipc/handle'
import { runProcess } from '../util/runProcess'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import {
  aggregatePtys,
  appKind,
  applyWinCpu,
  parsePs,
  parseWinCim,
  snapshotOf,
  type AppProc,
  type ProcRow,
  type ResourceLimit,
  type ResourceLimitTarget,
  type ResourceSnapshot,
  type WinSample
} from '@shared/resources'

const EXEC_TIMEOUT_MS = 5_000
const EXEC_MAX_BUFFER = 10 * 1024 * 1024

async function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await runProcess(file, args, { env, timeoutMs: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER })
  return r.error ? '' : r.stdout
}

// Orca windows-process-resource-collector 와 같은 CIM 질의(typeperf 폴백은 뺐다 — 실패하면 PTY 칸이 0 으로 남는다).
const WIN_CIM =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ' +
  'ForEach-Object { [string]::Join([char]9, @($_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,([uint64]$_.KernelModeTime+[uint64]$_.UserModeTime))) }'

let prevWin: { sample: WinSample; at: number } | null = null

async function hostProcesses(): Promise<ProcRow[]> {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WIN_CIM])
    const sample = parseWinCim(out)
    const at = Date.now()
    const rows = applyWinCpu(sample, prevWin?.sample ?? null, prevWin ? at - prevWin.at : 0, os.cpus().length)
    prevWin = { sample, at }
    return rows
  }
  // 소수점이 로캘 쉼표로 나오면 parseFloat 가 잘린다(Orca 주석) — C 로캘로 고정.
  return parsePs(await run('ps', ['-eo', 'pid=,ppid=,pcpu=,rss='], { LC_ALL: 'C', LANG: 'C' }))
}

function appProcs(): AppProc[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    kind: appKind(m.type),
    name: m.name ?? m.serviceName,
    cpu: m.cpu.percentCPUUsage,
    memory: m.memory.workingSetSize * 1024
  }))
}

export type ResourcesService = {
  snapshot(): Promise<ResourceSnapshot>
  /** TODO(M4, 묶음 0·13): Windows Job Object(SetInformationJobObject)·macOS 로 상한을 건다. 지금은 기록만 하고 적용 안 함. */
  setLimit(target: ResourceLimitTarget, limit: ResourceLimit | null): void
  /** TODO(M4): 새 PTY/에이전트 프로세스가 생길 때 저장된 상한을 적용한다. */
  applyLimit(target: ResourceLimitTarget, pid: number): Promise<{ ok: false; reason: 'unsupported' }>
}

export function registerResourcesFeature(sessions: MainSessionManager): ResourcesService {
  let inflight: Promise<ResourceSnapshot> | null = null
  const limits = new Map<string, ResourceLimit>()
  const service: ResourcesService = {
    // 창 두 개가 같이 물어도 한 번만 잰다(Orca collectMemorySnapshot 의 inflight 와 같은 이유).
    snapshot() {
      inflight ??= hostProcesses()
        .then((rows) => {
          const app = appProcs()
          const appPids = new Set(app.map((a) => a.pid))
          // 앱 프로세스는 Electron 값으로 이미 셌다 — PTY 트리 합산에서 겹치지 않게 뺀다.
          return snapshotOf(app, aggregatePtys(rows.filter((r) => !appPids.has(r.pid)), sessions.ptyList()))
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
    setLimit(target, limit) {
      const key = target.kind === 'pty' ? 'pty:' + target.sessionId : 'agent:' + target.agentId
      if (limit) limits.set(key, limit)
      else limits.delete(key)
    },
    async applyLimit() {
      return { ok: false, reason: 'unsupported' }
    }
  }
  handle('resources:snapshot', () => service.snapshot())
  // 안전 종료 = 탭 닫기와 같은 길(sessions.destroy → 화면에 session:closed 가 간다). 렌더러가 보낸 id 는 목록에서 확인한다.
  handle('resources:killPty', ({ id }) => {
    if (!sessions.ptyList().some((p) => p.id === id)) return { ok: false }
    sessions.destroy(id)
    return { ok: true }
  })
  return service
}
