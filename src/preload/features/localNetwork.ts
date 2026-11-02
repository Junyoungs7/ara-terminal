// M15 R2 TM-04 macOS 로컬 네트워크 — preload 다리(main/localNetwork/feature.ts). 맥이 아니면 main 이 ok:false·unsupported.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const localNetworkBridge: Pick<EvApi, 'localNetwork'> = {
  localNetwork: {
    request: () => ipcRenderer.invoke('localNetwork:request'),
    openSettings: () => ipcRenderer.invoke('localNetwork:openSettings'),
    test: (host: string, port: number) => ipcRenderer.invoke('localNetwork:test', { host, port })
  }
}
