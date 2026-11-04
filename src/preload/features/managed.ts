// M8 관리형 서버 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi, ManagedAccountsRequest, ManagedUpdated } from '@shared/ipc'

export const managedBridge: Pick<EvApi, 'managed'> = {
  managed: {
    list: () => ipcRenderer.invoke('managed:list'),
    plan: (hostKey: string) => ipcRenderer.invoke('managed:plan', { hostKey }),
    install: (hostKey: string) => ipcRenderer.invoke('managed:install', { hostKey }),
    check: (hostKey: string) => ipcRenderer.invoke('managed:check', { hostKey }),
    remove: (hostKey: string) => ipcRenderer.invoke('managed:remove', { hostKey }),
    hosts: () => ipcRenderer.invoke('managed:hosts'),
    sessions: () => ipcRenderer.invoke('managed:sessions'),
    accounts: (req: ManagedAccountsRequest) => ipcRenderer.invoke('managed:accounts', req),
    onUpdated: (cb: (e: ManagedUpdated) => void) => {
      const listener = (_e: IpcRendererEvent, v: ManagedUpdated): void => cb(v)
      ipcRenderer.on('managed:updated', listener)
      return () => ipcRenderer.removeListener('managed:updated', listener)
    }
  }
}
