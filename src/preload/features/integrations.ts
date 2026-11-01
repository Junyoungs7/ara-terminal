// M15 연동(GitLab·Slack) — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { IntegrationsState } from '@shared/integrations'

export const integrationsBridge: Pick<EvApi, 'integrations' | 'gitlab'> = {
  integrations: {
    get: () => ipcRenderer.invoke('integrations:get'),
    setGitlab: (p) => ipcRenderer.invoke('integrations:setGitlab', p),
    setSlack: (p) => ipcRenderer.invoke('integrations:setSlack', p),
    onUpdate: (cb) => {
      const listener = (_e: IpcRendererEvent, s: IntegrationsState): void => cb(s)
      ipcRenderer.on('integrations:update', listener)
      return () => ipcRenderer.removeListener('integrations:update', listener)
    }
  },
  gitlab: {
    test: () => ipcRenderer.invoke('gitlab:test'),
    mrs: (cwd, state) => ipcRenderer.invoke('gitlab:mrs', { cwd, state }),
    createMr: (cwd, mr) => ipcRenderer.invoke('gitlab:createMr', { cwd, ...mr })
  }
}
