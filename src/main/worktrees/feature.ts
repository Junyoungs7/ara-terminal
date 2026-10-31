// M2 작업 단위 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// Orca src/main/ipc/worktrees.ts·repos(orcaRef 7a7f46f8a3)의 채널 이름을 따른다. 원격·SSH 워크트리는 M8.
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { logMainError } from '../log/MainErrorLog'
import { ProjectStore } from './ProjectStore'
import { createWorktreeService, type WorktreeService } from './service'

export function registerWorktreesFeature(userData: string): WorktreeService {
  const service = createWorktreeService({
    store: new ProjectStore(join(userData, 'projects.json')),
    // 진행은 모든 창에 — 생성 중에 창을 떼어 내도 끝을 안다.
    emit: (e) => {
      for (const w of BrowserWindow.getAllWindows()) pushSend(w.webContents, 'createWorktree:progress', e)
    },
    warn: (msg) => logMainError('worktree-include', new Error(msg))
  })
  handle('repos:list', () => service.listProjects())
  handle('repos:add', ({ path }) => service.addProject(path))
  handle('repos:remove', ({ repoId }) => service.removeProject(repoId))
  handle('repos:searchBaseRefs', ({ repoId, query }) => service.searchBaseRefs(repoId, query))
  handle('worktrees:list', ({ repoId }) => service.listWorktrees(repoId))
  handle('worktrees:create', (args) => service.createWorktree(args))
  handle('worktrees:cancelCreate', ({ creationId }) => service.cancelCreate(creationId))
  handle('worktrees:remove', ({ repoId, path, force }) => service.removeWorktree(repoId, path, force))
  // 지난번에 앱이 죽어 남은 생성 기록 정리(WS-03). 기동을 막지 않는다.
  void service.reconcilePending().catch((e) => logMainError('worktree-reconcile', e))
  return service
}
