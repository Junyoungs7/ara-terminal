// M6 WS-07·08 코드 에디터 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// Orca src/main/ipc/filesystem/(읽기·쓰기 전제 조건)·watchers(orcaRef 7a7f46f8a3)의 1차 판 — 로컬 워크트리만.
// 모든 요청은 워크트리 루트(root) 안의 경로만 받는다(렌더러가 넘긴 경로가 루트 밖이면 거절).
import { BrowserWindow, app, dialog } from 'electron'
import { unwatchFile, watchFile } from 'node:fs'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { isInsidePath } from '@shared/codeFiles'
import { readCode, writeCode } from './io'
import { listFiles, rgBinPath, searchText } from './search'

const outside = { ok: false as const, message: '작업 단위 폴더 밖의 파일입니다.' }
/** 열린 파일 감시 간격. ponytail: stat 폴링(열린 파일만 — 몇 개). 많이 열게 되면 폴더 감시(@parcel/watcher, Orca)로. */
const WATCH_MS = 1000

export function registerCodeFeature(): void {
  const inside = (root: unknown, path: unknown): path is string =>
    typeof root === 'string' && typeof path === 'string' && isInsidePath(root, path, process.platform)
  // 열린 탭 수만큼 센다 — 같은 파일을 두 창이 열어도 마지막이 닫을 때 감시를 푼다.
  const watching = new Map<string, number>()

  handle('code:pick', async ({ root }) => {
    const res = await dialog.showOpenDialog({ defaultPath: root, properties: ['openFile'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('code:read', ({ root, path }) => (inside(root, path) ? readCode(path) : outside))
  handle('code:write', ({ root, path, text, eol, baseSig, force }) => {
    if (!inside(root, path) || typeof text !== 'string' || typeof baseSig !== 'string') return outside
    return writeCode(path, text, eol === 'crlf' ? 'crlf' : 'lf', baseSig, force === true)
  })
  handle('code:watch', ({ root, path }) => {
    if (!inside(root, path)) return
    const n = watching.get(path) ?? 0
    watching.set(path, n + 1)
    if (n > 0) return
    watchFile(path, { interval: WATCH_MS, persistent: false }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
      for (const w of BrowserWindow.getAllWindows()) pushSend(w.webContents, 'code:changed', { path })
    })
  })
  // M6 R2 WS-06·09 — 앱에 실린 rg(설치본은 app.asar.unpacked). 워크트리 폴더(root)를 cwd 로 띄운다.
  const rg = rgBinPath(app.getAppPath(), process.platform, process.arch)
  /** 도는 검색 — id(렌더러가 만든다)별 끊개. 같은 id 로 다시 오면 앞의 것을 끊는다. */
  const searches = new Map<string, AbortController>()
  handle('code:listFiles', ({ root }) => (typeof root === 'string' ? listFiles(rg, root) : { ok: false as const, message: outside.message }))
  handle('code:search', async ({ id, root, options }, e) => {
    if (typeof root !== 'string' || typeof id !== 'string' || typeof options?.query !== 'string') return { ok: false as const, message: outside.message }
    searches.get(id)?.abort()
    const ac = new AbortController()
    searches.set(id, ac)
    try {
      // 결과는 묶음으로 **물은 창에만** 보낸다(code:searchBatch) — 끝나면 이 응답이 합계·잘림을 알린다.
      return await searchText(rg, root, options, ac.signal, (files) => pushSend(e.sender, 'code:searchBatch', { id, files }))
    } finally {
      if (searches.get(id) === ac) searches.delete(id)
    }
  })
  handle('code:searchCancel', ({ id }) => void searches.get(id)?.abort())
  handle('code:unwatch', ({ path }) => {
    const n = watching.get(path)
    if (!n) return
    if (n > 1) return void watching.set(path, n - 1)
    watching.delete(path)
    unwatchFile(path)
  })
}
