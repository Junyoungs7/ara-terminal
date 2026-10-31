// FD-01 자원 관리자 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const resourcesBridge: Pick<EvApi, 'resources'> = {
  resources: {
    snapshot: () => ipcRenderer.invoke('resources:snapshot'),
    killPty: (id: string) => ipcRenderer.invoke('resources:killPty', { id })
  }
}
