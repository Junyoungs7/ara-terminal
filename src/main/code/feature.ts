// M6 WS-07·08 코드 에디터 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// Orca src/main/ipc/filesystem/(읽기·쓰기 전제 조건)·watchers(orcaRef 7a7f46f8a3)의 1차 판.
// 모든 요청은 워크트리 루트(root) 안의 경로만 받는다(렌더러가 넘긴 경로가 루트 밖이면 거절).
// M8 R5: 요청에 host 가 있으면 원격 작업 단위 — 백엔드(work/backend)가 SSH(SFTP·exec)로 바꿔 준다. 규칙은 같다.
import { BrowserWindow, dialog } from 'electron'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { isInsidePath } from '@shared/codeFiles'
import { workBackend } from '../work/backend'
import { listFilesOn, searchTextOn } from './search'

const outside = { ok: false as const, message: '작업 단위 폴더 밖의 파일입니다.' }

export function registerCodeFeature(): void {
  const inside = (root: unknown, path: unknown, host: unknown): path is string =>
    typeof root === 'string' && typeof path === 'string' && isInsidePath(root, path, workBackend(host).platform)
  // 열린 탭 수만큼 센다 — 같은 파일을 두 창이 열어도 마지막이 닫을 때 감시를 푼다. 키 = 호스트 + 경로(두 서버의 같은 경로는 다른 파일).
  const watching = new Map<string, { n: number; stop: () => void }>()
  const keyOf = (host: unknown, path: string): string => `${typeof host === 'string' ? host : ''}\0${path}`

  // 이 PC 의 파일 창 — 원격 작업 단위는 렌더러가 부르지 않는다(빠른 열기로 고른다).
  handle('code:pick', async ({ root }) => {
    const res = await dialog.showOpenDialog({ defaultPath: root, properties: ['openFile'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('code:read', ({ root, path, host }) => (inside(root, path, host) ? workBackend(host).readCode(path) : outside))
  handle('code:write', ({ root, path, text, eol, baseSig, force, host }) => {
    if (!inside(root, path, host) || typeof text !== 'string' || typeof baseSig !== 'string') return outside
    return workBackend(host).writeCode(path, text, eol === 'crlf' ? 'crlf' : 'lf', baseSig, force === true)
  })
  handle('code:watch', ({ root, path, host }) => {
    if (!inside(root, path, host)) return
    const k = keyOf(host, path)
    const w = watching.get(k)
    if (w) return void w.n++
    const stop = workBackend(host).watch(path, () => {
      for (const win of BrowserWindow.getAllWindows()) pushSend(win.webContents, 'code:changed', { path })
    })
    watching.set(k, { n: 1, stop })
  })
  handle('code:unwatch', ({ path, host }) => {
    const k = keyOf(host, path)
    const w = watching.get(k)
    if (!w) return
    if (--w.n > 0) return
    watching.delete(k)
    w.stop()
  })
  // M6 R2 WS-06·09 — 워크트리 폴더(root)를 cwd 로 rg(원격은 서버의 rg, 없으면 git). 도는 검색 — id(렌더러가 만든다)별 끊개.
  const searches = new Map<string, AbortController>()
  handle('code:listFiles', ({ root, host }) => (typeof root === 'string' ? listFilesOn(workBackend(host), root) : { ok: false as const, message: outside.message }))
  handle('code:search', async ({ id, root, options, host }, e) => {
    if (typeof root !== 'string' || typeof id !== 'string' || typeof options?.query !== 'string') return { ok: false as const, message: outside.message }
    searches.get(id)?.abort()
    const ac = new AbortController()
    searches.set(id, ac)
    try {
      // 결과는 묶음으로 **물은 창에만** 보낸다(code:searchBatch) — 끝나면 이 응답이 합계·잘림을 알린다.
      return await searchTextOn(workBackend(host), root, options, ac.signal, (files) => pushSend(e.sender, 'code:searchBatch', { id, files }))
    } finally {
      if (searches.get(id) === ac) searches.delete(id)
    }
  })
  handle('code:searchCancel', ({ id }) => void searches.get(id)?.abort())
}
