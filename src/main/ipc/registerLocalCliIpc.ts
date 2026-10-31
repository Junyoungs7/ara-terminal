// #90(2026-08-16) — AI CLI 를 **내 PC** 에서 시작하기 위해 main 만 알 수 있는 것을 답한다.
//
// 이 PC 의 기본 셸이 어느 문법인가. `buildLaunch` 가 `cd A && B`(posix)와
//    `Set-Location …; if ($?) { B }`(PowerShell)와 `cd /d "A" && B`(cmd) 중 하나를 골라야 하는데,
//    **powershell.exe(5.1)는 `&&` 가 파서 오류**라 잘못 고르면 명령이 아예 실행되지 않는다.
//    셸 선택 규칙은 PtyBackend 가 이미 갖고 있으므로 그 함수를 그대로 쓴다(두 벌로 갈리면 안 된다).
import { handle } from './handle'
import { addWorktree } from '../util/localGit'
import { defaultLaunchShell } from '../sessions/PtyBackend'

export function registerLocalCliIpc(): void {
  // #133 세션 분리(로컬). 명령 조립·검증은 util/localGit.ts 가 한다 — 렌더러는 폴더와 이름만 준다.
  handle('git:worktreeAdd', ({ path, name }) => addWorktree(String(path), String(name)))

  handle('app:launchShell', () => ({ shell: defaultLaunchShell() }))
}
