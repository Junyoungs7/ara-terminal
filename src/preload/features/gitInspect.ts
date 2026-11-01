// M7 R1 WS-10 git 조회 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'

export const gitInspectBridge: Pick<EvApi, 'gitInspect'> = {
  gitInspect: {
    status: (worktreePath, host) => ipcRenderer.invoke('git:status', { worktreePath, host }),
    branchCompare: (worktreePath, baseRef, host) => ipcRenderer.invoke('git:branchCompare', { worktreePath, baseRef, host }),
    diff: (args) => ipcRenderer.invoke('git:diff', args)
  }
}
