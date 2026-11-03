// p3-M21 펫 preload 다리(main/pet/feature.ts). preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const petBridge: Pick<EvApi, 'pet'> = {
  pet: {
    import: () => ipcRenderer.invoke('pet:import'),
    image: (image) => ipcRenderer.invoke('pet:image', { image })
  }
}
