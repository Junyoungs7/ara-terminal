// M11 세션 전문 검색 utility process(electron.vite.config main input — out/main/vaultSearchWorker.js). main/vault/feature.ts 가 띄운다.
// 요청 하나씩 차례로 처리하고, 새 요청이 오면 지금 것은 그만둔다(입력할 때마다 검색 — 낡은 결과는 버린다).
import { searchSessionFiles, type SearchFile } from './search'

type Req = { id: number; query: string; files: SearchFile[] }
type ParentPort = { on(e: 'message', l: (m: { data: unknown }) => void): void; postMessage(m: unknown): void }
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

let latest = 0
parentPort.on('message', ({ data }) => {
  const r = data as Req
  if (!r || typeof r.id !== 'number') return
  latest = r.id
  void searchSessionFiles(r.files, r.query, () => latest !== r.id).then(
    (res) => latest === r.id && parentPort.postMessage({ id: r.id, ok: true, ...res }),
    (e: unknown) => parentPort.postMessage({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  )
})
