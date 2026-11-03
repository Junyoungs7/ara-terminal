// P3 R2-A 터미널 3차 preload 다리(main/termExtraIpc.ts). preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const termExtraBridge: Pick<EvApi, 'termExtra'> = {
  termExtra: {
    shells: () => ipcRenderer.invoke('term:shells'),
    importPreview: (source) => ipcRenderer.invoke('term:importPreview', { source })
  }
}
