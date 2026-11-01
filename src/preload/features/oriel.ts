// M9 R2 Oriel — 기능 틀의 preload 다리(옛 내장 브라우저 browser.ts 자리). preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const orielBridge: Pick<EvApi, 'oriel'> = {
  // 링크를 Oriel 에서(미설치·실패면 OS 기본 브라우저). 스킴 검증은 main 이 한다.
  oriel: {
    open: (url: string) => ipcRenderer.invoke('oriel:open', { url }),
    status: (force?: boolean) => ipcRenderer.invoke('oriel:status', { force })
  }
}
