// M6 WS-07·08 코드 에디터 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { SearchFile } from '@shared/codeSearch'

export const codeBridge: Pick<EvApi, 'code'> = {
  code: {
    pick: (root: string) => ipcRenderer.invoke('code:pick', { root }),
    read: (root: string, path: string) => ipcRenderer.invoke('code:read', { root, path }),
    write: (req) => ipcRenderer.invoke('code:write', req),
    watch: (root: string, path: string) => ipcRenderer.invoke('code:watch', { root, path }),
    unwatch: (path: string) => ipcRenderer.invoke('code:unwatch', { path }),
    onChanged: (cb: (e: { path: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { path: string }) => cb(d)
      ipcRenderer.on('code:changed', listener)
      return () => ipcRenderer.removeListener('code:changed', listener)
    },
    listFiles: (root: string) => ipcRenderer.invoke('code:listFiles', { root }),
    search: (id, root, options) => ipcRenderer.invoke('code:search', { id, root, options }),
    searchCancel: (id: string) => ipcRenderer.invoke('code:searchCancel', { id }),
    onSearchBatch: (cb) => {
      const listener = (_e: IpcRendererEvent, d: { id: string; files: SearchFile[] }) => cb(d)
      ipcRenderer.on('code:searchBatch', listener)
      return () => ipcRenderer.removeListener('code:searchBatch', listener)
    }
  }
}
