// M7 R2 WS-12·13 소스 제어 — 기능 틀(docs/feature-module.md)의 preload 다리(git 쓰기). 조회는 gitInspect(M7 R1).
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const scmBridge: Pick<EvApi, 'scm'> = {
  scm: {
    stage: (root, paths, host) => ipcRenderer.invoke('scm:stage', { root, paths, host }),
    unstage: (root, paths, host) => ipcRenderer.invoke('scm:unstage', { root, paths, host }),
    discard: (root, path, host) => ipcRenderer.invoke('scm:discard', { root, path, host }),
    commit: (root, message, host) => ipcRenderer.invoke('scm:commit', { root, message, host }),
    amend: (root, message, confirmed, host) => ipcRenderer.invoke('scm:amend', { root, message, confirmed, host }),
    push: (root, force, confirmed, host) => ipcRenderer.invoke('scm:push', { root, force, confirmed, host }),
    abort: (root, op, host) => ipcRenderer.invoke('scm:abort', { root, op, host }),
    pull: (root, merge, host) => ipcRenderer.invoke('scm:pull', { root, merge, host }),
    ai: (root, kind, host) => ipcRenderer.invoke('scm:ai', { root, kind, host }),
    aiCancel: (root, host) => ipcRenderer.invoke('scm:aiCancel', { root, host }),
    renameBranch: (root, name, host) => ipcRenderer.invoke('scm:renameBranch', { root, name, host })
  }
}
