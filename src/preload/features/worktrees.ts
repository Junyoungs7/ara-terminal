// M2 작업 단위 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
// Orca src/preload/api/worktrees-bridge.ts(orcaRef 7a7f46f8a3)의 모양 — 진행 채널 이름도 같다(createWorktree:progress).
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { CreateWorktreeArgs, CreateWorktreeProgressEvent } from '@shared/worktrees'

export const worktreesBridge: Pick<EvApi, 'repos' | 'worktrees'> = {
  repos: {
    list: () => ipcRenderer.invoke('repos:list'),
    add: (path: string) => ipcRenderer.invoke('repos:add', { path }),
    remove: (repoId: string) => ipcRenderer.invoke('repos:remove', { repoId }),
    searchBaseRefs: (repoId: string, query: string) => ipcRenderer.invoke('repos:searchBaseRefs', { repoId, query })
  },
  worktrees: {
    list: (repoId: string) => ipcRenderer.invoke('worktrees:list', { repoId }),
    create: (args: CreateWorktreeArgs) => ipcRenderer.invoke('worktrees:create', args),
    cancelCreate: (creationId: string) => ipcRenderer.invoke('worktrees:cancelCreate', { creationId }),
    remove: (repoId: string, path: string, force?: boolean) => ipcRenderer.invoke('worktrees:remove', { repoId, path, force }),
    onCreateProgress: (cb: (e: CreateWorktreeProgressEvent) => void) => {
      const listener = (_e: IpcRendererEvent, d: CreateWorktreeProgressEvent) => cb(d)
      ipcRenderer.on('createWorktree:progress', listener)
      return () => ipcRenderer.removeListener('createWorktree:progress', listener)
    }
  }
}
