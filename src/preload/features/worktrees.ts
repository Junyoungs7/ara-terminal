// M2 작업 단위 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
// Orca src/preload/api/worktrees-bridge.ts(orcaRef 7a7f46f8a3)의 모양 — 진행 채널 이름도 같다(createWorktree:progress).
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { CreateWorktreeArgs, CreateWorktreeProgressEvent, ProjectUpdate, WorktreeMetaUpdate } from '@shared/worktrees'

export const worktreesBridge: Pick<EvApi, 'repos' | 'worktrees' | 'projectGroups' | 'sparsePresets'> = {
  repos: {
    list: () => ipcRenderer.invoke('repos:list'),
    pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),
    add: (path: string) => ipcRenderer.invoke('repos:add', { path }),
    addRemote: (hostKey: string, path: string) => ipcRenderer.invoke('repos:addRemote', { hostKey, path }),
    remove: (repoId: string) => ipcRenderer.invoke('repos:remove', { repoId }),
    searchBaseRefs: (repoId: string, query: string) => ipcRenderer.invoke('repos:searchBaseRefs', { repoId, query }),
    update: (repoId: string, updates: ProjectUpdate) => ipcRenderer.invoke('repos:update', { repoId, updates }),
    orcaYaml: (repoId: string) => ipcRenderer.invoke('repos:orcaYaml', { repoId }),
    trustOrcaScripts: (repoId: string, hashes: string[]) => ipcRenderer.invoke('repos:trustOrcaScripts', { repoId, hashes })
  },
  // 3차 WS-27 Orca sparsePresets:*
  sparsePresets: {
    list: (repoId: string) => ipcRenderer.invoke('sparsePresets:list', { repoId }),
    save: (repoId: string, preset: { id?: string; name: string; directories: string[] }) => ipcRenderer.invoke('sparsePresets:save', { repoId, preset }),
    remove: (repoId: string, presetId: string) => ipcRenderer.invoke('sparsePresets:remove', { repoId, presetId })
  },
  worktrees: {
    list: (repoId: string) => ipcRenderer.invoke('worktrees:list', { repoId }),
    create: (args: CreateWorktreeArgs) => ipcRenderer.invoke('worktrees:create', args),
    cancelCreate: (creationId: string) => ipcRenderer.invoke('worktrees:cancelCreate', { creationId }),
    remove: (repoId: string, path: string, force?: boolean) => ipcRenderer.invoke('worktrees:remove', { repoId, path, force }),
    stats: (repoId: string, path: string) => ipcRenderer.invoke('worktrees:stats', { repoId, path }),
    updateMeta: (worktreeId: string, updates: WorktreeMetaUpdate) => ipcRenderer.invoke('worktrees:updateMeta', { worktreeId, updates }),
    forceDeletePreservedBranch: (repoId: string, branchName: string, head: string) =>
      ipcRenderer.invoke('worktrees:forceDeletePreservedBranch', { repoId, branchName, head }),
    cleanupScan: (repoId: string) => ipcRenderer.invoke('worktrees:cleanupScan', { repoId }),
    diskUsage: (repoId: string, paths: string[]) => ipcRenderer.invoke('worktrees:diskUsage', { repoId, paths }),
    onCreateProgress: (cb: (e: CreateWorktreeProgressEvent) => void) => {
      const listener = (_e: IpcRendererEvent, d: CreateWorktreeProgressEvent) => cb(d)
      ipcRenderer.on('createWorktree:progress', listener)
      return () => ipcRenderer.removeListener('createWorktree:progress', listener)
    }
  },
  // M10 WS-15 Orca projectGroups:*
  projectGroups: {
    list: () => ipcRenderer.invoke('projectGroups:list'),
    create: (name: string) => ipcRenderer.invoke('projectGroups:create', { name }),
    update: (groupId: string, updates: { name?: string; isCollapsed?: boolean }) => ipcRenderer.invoke('projectGroups:update', { groupId, updates }),
    delete: (groupId: string) => ipcRenderer.invoke('projectGroups:delete', { groupId }),
    moveProject: (projectId: string, groupId: string | null) => ipcRenderer.invoke('projectGroups:moveProject', { projectId, groupId })
  }
}
