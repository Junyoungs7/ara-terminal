// M14 R2 `ara` CLI — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'

const on =
  <T>(ch: string) =>
  (cb: (v: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, v: T): void => cb(v)
    ipcRenderer.on(ch, listener)
    return () => ipcRenderer.removeListener(ch, listener)
  }

export const cliBridge: Pick<EvApi, 'cli'> = {
  cli: {
    status: () => ipcRenderer.invoke('cli:status'),
    install: () => ipcRenderer.invoke('cli:install'),
    uninstall: () => ipcRenderer.invoke('cli:uninstall'),
    skillStatus: () => ipcRenderer.invoke('cli:skillStatus'),
    skillInstall: (rootId) => ipcRenderer.invoke('cli:skillInstall', { rootId }),
    launchAgentResult: (reqId, result) => ipcRenderer.invoke('cli:launchAgentResult', { reqId, result }),
    onLaunchAgent: on('cli:launchAgent'),
    onWorktreesChanged: on('cli:worktreesChanged')
  }
}
