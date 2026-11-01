// FD-01 호스트 프로세스 표 — 자원 관리자(feature.ts)와 로컬 데몬(daemon/daemonEntry.ts, M4 메모리 상한)이 같이 쓴다.
// ⚠️ 데몬 번들에도 들어간다 — electron 을 import 하지 않는다.
import os from 'node:os'
import { runProcess } from '../util/runProcess'
import { applyWinCpu, parsePs, parseWinCim, type ProcRow, type WinSample } from '@shared/resources'

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

/** 표 하나를 잰다. Windows CPU 는 앞 표본과의 차라 부르는 쪽마다 하나씩(createHostProcs) — 두 쪽이 한 표본을 나눠 쓰면 % 가 틀린다. */
export function createHostProcs(): () => Promise<ProcRow[]> {
  let prevWin: { sample: WinSample; at: number } | null = null
  return async () => {
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
}

/** 에이전트 트리를 낮은 우선순위로(M4 R3). 이미 끝난 pid·권한 없음은 조용히 넘어간다. */
export function lowerPriority(pid: number): boolean {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
    return true
  } catch {
    return false
  }
}
