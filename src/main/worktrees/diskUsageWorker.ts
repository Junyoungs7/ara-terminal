// 3차 WS-26 디스크 사용량 utility process — main/worktrees/feature.ts 가 정리 화면에서 [크기 재기]를 누를 때만 띄우고 답을 받으면 끝난다(상주 안 함).
// 메시지: { paths: string[] } → { ok: true, items: DiskUsage[] } | { ok: false, error }.
import { scanDiskUsage } from './diskUsage'
import type { DiskUsage } from '@shared/worktrees'

type Req = { paths: string[] }
const parentPort = (process as unknown as { parentPort?: { on(e: 'message', f: (m: { data: Req }) => void): void; postMessage(m: unknown): void } }).parentPort
parentPort?.on('message', ({ data }) => {
  void (async () => {
    const items: DiskUsage[] = []
    for (const path of Array.isArray(data?.paths) ? data.paths : []) if (typeof path === 'string') items.push(await scanDiskUsage(path))
    parentPort.postMessage({ ok: true, items })
  })()
    .catch((e) => parentPort.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => setTimeout(() => process.exit(0), 50))
})
