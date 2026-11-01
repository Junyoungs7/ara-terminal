// M13 통계 utility process 진입점 — main(usage/stats.ts)이 out/main/usageStatsWorker.js 를 띄워 한 번 묻고, 답하면 끝난다.
import { scanUsage } from './statsScan'

type Req = { dirs: { claude: string[]; codex: string[] }; since: number }

const parentPort = (process as unknown as { parentPort?: { on(e: 'message', f: (m: { data: Req }) => void): void; postMessage(m: unknown): void } }).parentPort
parentPort?.on('message', ({ data }) => {
  scanUsage(data.dirs, data.since)
    .then((report) => parentPort.postMessage({ ok: true, report }))
    .catch((e) => parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => setTimeout(() => process.exit(0), 50))
})
