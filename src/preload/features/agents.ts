// M3 에이전트 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentLaunchOptions, AgentMemoryOver, AgentNameEvent, EvApi } from '@shared/ipc'
import type { AgentId, AgentSettings } from '@shared/agents'
import type { AgentStatusView } from '@shared/agentHooks'
import type { AgentChatEvent } from '@shared/agentChat'

export const agentsBridge: Pick<EvApi, 'agents'> = {
  agents: {
    detect: (force?: boolean) => ipcRenderer.invoke('agents:detect', { force }),
    getSettings: () => ipcRenderer.invoke('agents:getSettings'),
    setSettings: (settings: AgentSettings) => ipcRenderer.invoke('agents:setSettings', { settings }),
    launch: (agent: AgentId, cwd: string, prompt?: string, resume?: string, options?: AgentLaunchOptions) => ipcRenderer.invoke('agents:launch', { agent, cwd, prompt, resume, options }),
    models: (agent: AgentId, force?: boolean) => ipcRenderer.invoke('agents:models', { agent, force }),
    slash: (agent: AgentId, cwd: string) => ipcRenderer.invoke('agents:slash', { agent, cwd }),
    onName: (cb: (e: AgentNameEvent) => void) => {
      const listener = (_e: IpcRendererEvent, v: AgentNameEvent): void => cb(v)
      ipcRenderer.on('agents:name', listener)
      return () => ipcRenderer.removeListener('agents:name', listener)
    },
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
    chatOpen: (sessionId: string) => ipcRenderer.invoke('agents:chatOpen', { sessionId }),
    chatClose: (sessionId: string) => ipcRenderer.invoke('agents:chatClose', { sessionId }),
    chatSend: (sessionId: string, agent: AgentId, text: string) => ipcRenderer.invoke('agents:chatSend', { sessionId, agent, text }),
    onChat: (cb: (e: AgentChatEvent) => void) => {
      const listener = (_e: IpcRendererEvent, v: AgentChatEvent): void => cb(v)
      ipcRenderer.on('agents:chat', listener)
      return () => ipcRenderer.removeListener('agents:chat', listener)
    },
    onMemoryOver: (cb: (e: AgentMemoryOver) => void) => {
      const listener = (_e: IpcRendererEvent, v: AgentMemoryOver): void => cb(v)
      ipcRenderer.on('agents:memoryOver', listener)
      return () => ipcRenderer.removeListener('agents:memoryOver', listener)
    }
  }
}
