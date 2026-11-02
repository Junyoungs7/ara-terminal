// M6 WS-07·08 코드 에디터 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { SearchFile } from '@shared/codeSearch'

export const codeBridge: Pick<EvApi, 'code'> = {
  code: {
    read: (root: string, path: string, host?: string) => ipcRenderer.invoke('code:read', { root, path, host }),
    write: (req) => ipcRenderer.invoke('code:write', req),
    watch: (root: string, path: string, host?: string) => ipcRenderer.invoke('code:watch', { root, path, host }),
    unwatch: (path: string, host?: string) => ipcRenderer.invoke('code:unwatch', { path, host }),
    onChanged: (cb: (e: { path: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { path: string }) => cb(d)
      ipcRenderer.on('code:changed', listener)
      return () => ipcRenderer.removeListener('code:changed', listener)
    },
    listFiles: (root: string, host?: string) => ipcRenderer.invoke('code:listFiles', { root, host }),
    search: (id, root, options, host) => ipcRenderer.invoke('code:search', { id, root, options, host }),
    searchCancel: (id: string) => ipcRenderer.invoke('code:searchCancel', { id }),
    onSearchBatch: (cb) => {
      const listener = (_e: IpcRendererEvent, d: { id: string; files: SearchFile[] }) => cb(d)
      ipcRenderer.on('code:searchBatch', listener)
      return () => ipcRenderer.removeListener('code:searchBatch', listener)
    },
    fsList: (root: string, path: string, host?: string) => ipcRenderer.invoke('code:fsList', { root, path, host }),
    fsOp: (req) => ipcRenderer.invoke('code:fsOp', req),
    readBytes: (root: string, path: string, host?: string) => ipcRenderer.invoke('code:readBytes', { root, path, host }),
    watchTree: (root: string, host?: string) => ipcRenderer.invoke('code:watchTree', { root, host }),
    unwatchTree: (root: string, host?: string) => ipcRenderer.invoke('code:unwatchTree', { root, host }),
    onTreeChanged: (cb: (e: { root: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { root: string }) => cb(d)
      ipcRenderer.on('code:treeChanged', listener)
      return () => ipcRenderer.removeListener('code:treeChanged', listener)
    },
    aiLines: (path: string, text: string) => ipcRenderer.invoke('code:aiLines', { path, text }),
    onAiLinesChanged: (cb: (e: { path: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { path: string }) => cb(d)
      ipcRenderer.on('code:aiLinesChanged', listener)
      return () => ipcRenderer.removeListener('code:aiLinesChanged', listener)
    },
    docPreview: (root: string, path: string, host?: string, remote?: boolean) => ipcRenderer.invoke('code:docPreview', { root, path, host, remote }),
    onDocLink: (cb: (e: { url: string; grant: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { url: string; grant: string }) => cb(d)
      ipcRenderer.on('code:docLink', listener)
      return () => ipcRenderer.removeListener('code:docLink', listener)
    }
  }
}
