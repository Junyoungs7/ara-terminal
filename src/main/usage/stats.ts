// M13 통계 — 에이전트 요약(Orca main/stats/collector.ts: 띄운 에이전트·일한 시간·처음 기록)과 토큰 통계(utility process 로 transcript 읽기).
// 요약은 상태 원장의 '일하는 중' 전환으로 센다: 처음 일하기 시작한 탭 = 띄운 에이전트 1, 일하는 중 → 다른 상태 = 그 시간만큼 더한다.
// 저장은 userData/usage-stats.json(5초 모아 쓰기, 끌 때 한 번). 토큰 통계는 통계 화면을 열 때만 utility process 를 띄운다(1분 안에 다시 열면 지난 답).
import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { EMPTY_AGENT_SUMMARY, STATS_DAYS, type AgentSummary, type StatsReport } from '@shared/usageStats'

const SAVE_DEBOUNCE_MS = 5_000
const REPORT_TTL_MS = 60_000
const SCAN_TIMEOUT_MS = 120_000

export type StatsFeature = {
  observe(sessionId: string, working: boolean, now?: number): void
  summary(): AgentSummary
  report(force?: boolean): Promise<StatsReport>
  flush(): void
}

type Fork = (req: { dirs: { claude: string[]; codex: string[] }; since: number }) => Promise<StatsReport>

/** 한 번 띄워 묻고 답을 받으면 끝(상주 안 함). */
const forkScan =
  (modulePath: string): Fork =>
  (req) =>
    new Promise((resolve, reject) => {
      const child = utilityProcess.fork(modulePath, [], { serviceName: 'ara-usage-stats' })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('통계 읽기 시간 초과'))
      }, SCAN_TIMEOUT_MS)
      child.on('message', (m: { ok: boolean; report?: StatsReport; error?: string }) => {
        clearTimeout(timer)
        if (m.ok && m.report) resolve(m.report)
        else reject(new Error(m.error ?? '통계를 읽지 못했습니다'))
      })
      child.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('통계 프로세스가 끝났습니다'))
      })
      child.postMessage(req)
    })

export function createStatsFeature(deps: {
  userData: string
  /** 읽을 Claude 설정 폴더·Codex 홈(시스템 기본 + 아라가 만든 계정 폴더). */
  dirs: () => { claude: string[]; codex: string[] }
  scan?: Fork
  now?: () => number
}): StatsFeature {
  const now = deps.now ?? Date.now
  const file = join(deps.userData, 'usage-stats.json')
  const raw = readJsonWithBackup<Partial<AgentSummary> | null>(file, null)
  const sum: AgentSummary = {
    agentsSpawned: typeof raw?.agentsSpawned === 'number' ? raw.agentsSpawned : 0,
    agentTimeMs: typeof raw?.agentTimeMs === 'number' ? raw.agentTimeMs : 0,
    firstEventAt: typeof raw?.firstEventAt === 'number' ? raw.firstEventAt : EMPTY_AGENT_SUMMARY.firstEventAt
  }
  const seen = new Set<string>()
  const live = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const write = (): void => {
    try {
      writeJsonAtomic(file, sum)
    } catch {
      /* 못 남기면 다음 저장 때 */
    }
  }
  const save = (): void => {
    timer ??= setTimeout(() => {
      timer = null
      write()
    }, SAVE_DEBOUNCE_MS)
  }
  const scan = deps.scan ?? forkScan(join(__dirname, 'usageStatsWorker.js'))
  let cached: StatsReport | null = null
  let inflight: Promise<StatsReport> | null = null

  return {
    observe(id, working, at = now()) {
      if (working) {
        if (live.has(id)) return
        live.set(id, at)
        sum.firstEventAt ??= at
        if (!seen.has(id)) {
          seen.add(id)
          sum.agentsSpawned++
        }
        save()
        return
      }
      const start = live.get(id)
      if (start === undefined) return
      live.delete(id)
      sum.agentTimeMs += Math.max(0, at - start)
      save()
    },
    summary: () => ({ ...sum }),
    report(force = false) {
      if (!force && cached && now() - cached.at < REPORT_TTL_MS) return Promise.resolve(cached)
      inflight ??= scan({ dirs: deps.dirs(), since: now() - STATS_DAYS * 86_400_000 })
        .then((r) => (cached = r))
        .finally(() => (inflight = null))
      return inflight
    },
    flush() {
      const t = now()
      for (const id of [...live.keys()]) this.observe(id, false, t)
      if (timer) clearTimeout(timer)
      timer = null
      write()
    }
  }
}
