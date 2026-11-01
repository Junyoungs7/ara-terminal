// M2 작업 단위 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// Orca src/main/ipc/worktrees.ts·repos(orcaRef 7a7f46f8a3)의 채널 이름을 따른다. 원격·SSH 워크트리는 M8.
import { BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { logMainError } from '../log/MainErrorLog'
import { ProjectStore } from './ProjectStore'
import { createWorktreeService, type WorktreeService } from './service'
import type { RemoteRun } from '../managed/remoteWorktrees'

/** remote = M8 DM-04 원격 저장소의 git 길(관리형 서버 기능이 뒤에 서므로 부를 때 찾는다). */
export function registerWorktreesFeature(userData: string, remote?: (hostKey: string) => RemoteRun): WorktreeService {
  const service = createWorktreeService({
    store: new ProjectStore(join(userData, 'projects.json')),
    // 진행은 모든 창에 — 생성 중에 창을 떼어 내도 끝을 안다.
    emit: (e) => {
      for (const w of BrowserWindow.getAllWindows()) pushSend(w.webContents, 'createWorktree:progress', e)
    },
    warn: (msg) => logMainError('worktree-include', new Error(msg)),
    ...(remote ? { remote } : {}),
    // e2e 는 사용자 홈(~/ara/workspaces)에 워크트리를 만들지 않는다 — 그 인스턴스의 임시 userData 안으로.
    ...(process.env.ARA_E2E ? { workspaceDir: join(userData, 'workspaces') } : {})
  })
  handle('repos:list', () => service.listProjects())
  handle('repos:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('repos:add', ({ path }) => service.addProject(path))
  handle('repos:addRemote', ({ hostKey, path }) => service.addRemoteProject(hostKey, path))
  handle('repos:remove', ({ repoId }) => service.removeProject(repoId))
  handle('repos:searchBaseRefs', ({ repoId, query }) => service.searchBaseRefs(repoId, query))
  handle('worktrees:list', ({ repoId }) => service.listWorktrees(repoId))
  handle('worktrees:create', (args) => service.createWorktree(args))
  handle('worktrees:cancelCreate', ({ creationId }) => service.cancelCreate(creationId))
  handle('worktrees:remove', ({ repoId, path, force }) => service.removeWorktree(repoId, path, force))
  handle('worktrees:stats', ({ repoId, path }) => service.worktreeStats(repoId, path))
  handle('worktrees:updateMeta', ({ worktreeId, updates }) => service.updateMeta(worktreeId, updates))
  // M10 R2 WS-21 보존 브랜치 강제 지우기(Orca 이름) · WS-19·20 프로젝트 설정(Orca repos:update 의 일부 칸).
  handle('worktrees:forceDeletePreservedBranch', ({ repoId, branchName, head }) => service.forceDeletePreservedBranch(repoId, branchName, head))
  handle('repos:update', ({ repoId, updates }) => service.updateProject(repoId, updates))
  // M10 WS-15 프로젝트 그룹 — Orca projectGroups:* 이름.
  handle('projectGroups:list', () => service.listGroups())
  handle('projectGroups:create', ({ name }) => service.createGroup(name))
  handle('projectGroups:update', ({ groupId, updates }) => service.updateGroup(groupId, updates))
  handle('projectGroups:delete', ({ groupId }) => service.deleteGroup(groupId))
  handle('projectGroups:moveProject', ({ projectId, groupId }) => service.moveProject(projectId, groupId))
  // 지난번에 앱이 죽어 남은 생성 기록 정리(WS-03). 기동을 막지 않는다.
  void service.reconcilePending().catch((e) => logMainError('worktree-reconcile', e))
  return service
}
