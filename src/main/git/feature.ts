// M7 R1 WS-10 git 조회 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 채널 이름은 Orca git-inspection-api(git:status·git:diff·git:branchCompare).
// M8 R5: host 가 있으면 원격 작업 단위 — 같은 조회를 SSH exec·SFTP 로(work/backend).
import { handle } from '../ipc/handle'
import { workBackend } from '../work/backend'
import { readBranchCompare, readFileDiff, readFileDiffImage, readGitStatus } from './inspect'

const bad = { ok: false as const, message: '작업 단위 폴더가 없습니다.' }

export function registerGitInspectFeature(): void {
  handle('git:status', ({ worktreePath, host }) => (typeof worktreePath === 'string' && worktreePath ? readGitStatus(worktreePath, workBackend(host).inspect) : bad))
  handle('git:branchCompare', ({ worktreePath, baseRef, host }) =>
    typeof worktreePath === 'string' && worktreePath ? readBranchCompare(worktreePath, baseRef, workBackend(host).inspect) : bad
  )
  handle('git:diff', (args) => (typeof args?.worktreePath === 'string' && args.worktreePath ? readFileDiff(args, workBackend(args.host).inspect) : bad))
  handle('git:diffImage', (args) => (typeof args?.worktreePath === 'string' && args.worktreePath ? readFileDiffImage(args, workBackend(args.host).inspect) : bad))
}
