// M3 에이전트 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentMemoryOver, EvApi } from '@shared/ipc'
import type { AgentId, AgentSettings } from '@shared/agents'
import type { AgentStatusView } from '@shared/agentHooks'

export const agentsBridge: Pick<EvApi, 'agents'> = {
  agents: {
    detect: (force?: boolean) => ipcRenderer.invoke('agents:detect', { force }),
    getSettings: () => ipcRenderer.invoke('agents:getSettings'),
    setSettings: (settings: AgentSettings) => ipcRenderer.invoke('agents:setSettings', { settings }),
    launch: (agent: AgentId, cwd: string, prompt?: string, resume?: string) => ipcRenderer.invoke('agents:launch', { agent, cwd, prompt, resume }),
    statuses: () => ipcRenderer.invoke('agents:statuses'),
    tabs: () => ipcRenderer.invoke('agents:tabs'),
    killBackground: () => ipcRenderer.invoke('agents:killBackground'),
    quitCompletely: () => ipcRenderer.invoke('agents:quitCompletely'),
    legacyNotice: () => ipcRenderer.invoke('agents:legacyNotice'),
    onStatus: (cb: (v: AgentStatusView) => void) => {
      const listener = (_e: IpcRendererEvent, v: AgentStatusView): void => cb(v)
      ipcRenderer.on('agents:status', listener)
      return () => ipcRenderer.removeListener('agents:status', listener)
    },
    onMemoryOver: (cb: (e: AgentMemoryOver) => void) => {
      const listener = (_e: IpcRendererEvent, v: AgentMemoryOver): void => cb(v)
      ipcRenderer.on('agents:memoryOver', listener)
      return () => ipcRenderer.removeListener('agents:memoryOver', listener)
    }
  }
}
