// M7 R1 WS-10 git 조회 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 채널 이름은 Orca git-inspection-api(git:status·git:diff·git:branchCompare).
import { handle } from '../ipc/handle'
import { readBranchCompare, readFileDiff, readGitStatus } from './inspect'

const bad = { ok: false as const, message: '작업 단위 폴더가 없습니다.' }

export function registerGitInspectFeature(): void {
  handle('git:status', ({ worktreePath }) => (typeof worktreePath === 'string' && worktreePath ? readGitStatus(worktreePath) : bad))
  handle('git:branchCompare', ({ worktreePath, baseRef }) => (typeof worktreePath === 'string' && worktreePath ? readBranchCompare(worktreePath, baseRef) : bad))
  handle('git:diff', (args) => (typeof args?.worktreePath === 'string' && args.worktreePath ? readFileDiff(args) : bad))
}
