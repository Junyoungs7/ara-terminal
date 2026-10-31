// M2 워크트리 위치 규칙 — Orca src/main/ipc/worktree-logic.ts·src/shared/constants.ts(orcaRef 7a7f46f8a3)를 따랐다.
// 기본 자리: `<홈>/ara/workspaces/<저장소 이름>/<워크트리 이름>`(Orca 는 `~/orca/workspaces`, nestWorkspaces 기본 true).
// 저장소별 위치(worktreeBasePath)·WSL 미러·SSH 형제 경로는 뺐다(설정 화면과 2차·M8).
import { posix, win32 } from 'node:path'

/** Orca getDefaultWorkspaceDir — 이름만 'ara' 로. */
export function getDefaultWorkspaceDir(homeDir: string): string {
  const separator = homeDir.includes('\\') ? '\\' : '/'
  return [homeDir.replace(/[\\/]+$/, ''), 'ara', 'workspaces'].join(separator)
}

function pathOps(...paths: string[]): typeof posix {
  return paths.some((p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.includes('\\')) ? win32 : posix
}

/** Orca computeWorkspaceRoot — 상대 workspaceDir 은 저장소 기준으로 푼다. */
export function computeWorkspaceRoot(repoPath: string, workspaceDir: string): string {
  const ops = pathOps(repoPath, workspaceDir)
  return ops.isAbsolute(workspaceDir) ? ops.normalize(workspaceDir) : ops.resolve(repoPath, workspaceDir)
}

/** Orca computeWorktreePath. */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: { workspaceDir: string; nestWorkspaces: boolean }
): string {
  const ops = pathOps(repoPath, settings.workspaceDir)
  const root = computeWorkspaceRoot(repoPath, settings.workspaceDir)
  if (!settings.nestWorkspaces) return ops.join(root, sanitizedName)
  return ops.join(root, ops.basename(repoPath).replace(/\.git$/, ''), sanitizedName)
}

/** Orca ensurePathWithinWorkspace — 이름이 `..` 로 밖을 가리키지 못하게. */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const ops = pathOps(targetPath, workspaceDir)
  const resolvedTarget = ops.resolve(targetPath)
  const rel = ops.relative(ops.resolve(workspaceDir), resolvedTarget)
  if (ops.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${ops.sep}`)) throw new Error('Invalid worktree path')
  return resolvedTarget
}
