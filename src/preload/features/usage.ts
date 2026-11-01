// M9 AI-10 사용량 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { UsageState } from '@shared/usage'

export const usageBridge: Pick<EvApi, 'usage'> = {
  usage: {
    get: () => ipcRenderer.invoke('usage:get'),
    refresh: () => ipcRenderer.invoke('usage:refresh'),
    onUpdate: (cb) => {
      const listener = (_e: IpcRendererEvent, s: UsageState): void => cb(s)
      ipcRenderer.on('usage:update', listener)
      return () => ipcRenderer.removeListener('usage:update', listener)
    },
    setPrefs: (p) => ipcRenderer.invoke('usage:setPrefs', p),
    account: (a) => ipcRenderer.invoke('usage:account', a),
    accountUsage: (provider, id) => ipcRenderer.invoke('usage:accountUsage', { provider, id }),
    stats: (force) => ipcRenderer.invoke('usage:stats', { force })
  }
}
