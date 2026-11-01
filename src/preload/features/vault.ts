// M4 AI-07 지난 에이전트 세션 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { AgentId } from '@shared/agents'

export const vaultBridge: Pick<EvApi, 'vault'> = {
  vault: {
    list: (cwds: string[]) => ipcRenderer.invoke('vault:list', { cwds }),
    detail: (file: string) => ipcRenderer.invoke('vault:detail', { file }),
    resumeCommand: (agent: AgentId, id: string, cwd: string | null) => ipcRenderer.invoke('vault:resumeCommand', { agent, id, cwd }),
    search: (query: string, cwds: string[]) => ipcRenderer.invoke('vault:search', { query, cwds }),
    delete: (file: string) => ipcRenderer.invoke('vault:delete', { file })
  }
}
