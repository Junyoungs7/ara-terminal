// M14 R1 자동화(AU-01)·스킬(AU-02)·MCP(AU-03) — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'

const on =
  <T>(ch: string) =>
  (cb: (v: T) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, v: T): void => cb(v)
    ipcRenderer.on(ch, listener)
    return () => ipcRenderer.removeListener(ch, listener)
  }

export const automationsBridge: Pick<EvApi, 'automations' | 'skills' | 'mcpServers'> = {
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    create: (input) => ipcRenderer.invoke('automations:create', input),
    update: (id, input) => ipcRenderer.invoke('automations:update', { id, input }),
    setEnabled: (id, enabled) => ipcRenderer.invoke('automations:setEnabled', { id, enabled }),
    remove: (id) => ipcRenderer.invoke('automations:remove', { id }),
    runNow: (id) => ipcRenderer.invoke('automations:runNow', { id }),
    markDispatchResult: (r) => ipcRenderer.invoke('automations:markDispatchResult', r),
    rendererReady: () => ipcRenderer.invoke('automations:rendererReady'),
    onChanged: on('automations:changed'),
    onDispatch: on('automations:dispatch')
  },
  skills: {
    scan: () => ipcRenderer.invoke('skills:scan'),
    delete: (id) => ipcRenderer.invoke('skills:delete', { id }),
    pickFolder: () => ipcRenderer.invoke('skills:pickFolder'),
    add: (source, target) => ipcRenderer.invoke('skills:add', { source, target })
  },
  mcpServers: {
    list: (project) => ipcRenderer.invoke('mcpServers:list', { project }),
    createStarter: (project) => ipcRenderer.invoke('mcpServers:createStarter', { project }),
    add: (project, server) => ipcRenderer.invoke('mcpServers:add', { project, server }),
    remove: (project, name) => ipcRenderer.invoke('mcpServers:remove', { project, name }),
    open: (path) => ipcRenderer.invoke('mcpServers:open', { path })
  }
}
