// M7 R2 WS-12·13 소스 제어 — 기능 틀(docs/feature-module.md)의 preload 다리(git 쓰기). 조회는 gitInspect(M7 R1).
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const scmBridge: Pick<EvApi, 'scm'> = {
  scm: {
    stage: (root, paths) => ipcRenderer.invoke('scm:stage', { root, paths }),
    unstage: (root, paths) => ipcRenderer.invoke('scm:unstage', { root, paths }),
    discard: (root, path) => ipcRenderer.invoke('scm:discard', { root, path }),
    commit: (root, message) => ipcRenderer.invoke('scm:commit', { root, message }),
    amend: (root, message, confirmed) => ipcRenderer.invoke('scm:amend', { root, message, confirmed }),
    push: (root, force, confirmed) => ipcRenderer.invoke('scm:push', { root, force, confirmed }),
    pull: (root, merge) => ipcRenderer.invoke('scm:pull', { root, merge })
  }
}
