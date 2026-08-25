// #90(2026-08-16) — AI CLI 를 **내 PC** 에서 시작하기 위해 main 만 알 수 있는 두 가지를 답한다.
//
// ① 이 PC 의 기본 셸이 어느 문법인가. `buildLaunch` 가 `cd A && B`(posix)와
//    `Set-Location …; if ($?) { B }`(PowerShell)와 `cd /d "A" && B`(cmd) 중 하나를 골라야 하는데,
//    **powershell.exe(5.1)는 `&&` 가 파서 오류**라 잘못 고르면 명령이 아예 실행되지 않는다.
//    셸 선택 규칙은 PtyBackend 가 이미 갖고 있으므로 그 함수를 그대로 쓴다(두 벌로 갈리면 안 된다).
//
// ② 그 CLI 가 이 PC 에 있는가. 원격은 `remote:run('which.cli')` 로 보지만 로컬에는 그 채널이 없다.
//    조회 자체는 util/localCli.ts 가 한다(#126 에서 아라 대화도 같은 판정을 쓰게 되면서 꺼냈다).
//    bin 은 렌더러에서 이미 validCliBin 을 통과했지만 여기서 한 번 더 본다(신뢰 경계).
import { handle } from './handle'
import { hasLocalCli } from '../util/localCli'
import { addWorktree, isGitRepo, removeWorktree } from '../util/localGit'
import { defaultLaunchShell } from '../sessions/PtyBackend'
import { validCliBin } from '@shared/aiCli'

/** which/where 가 이보다 오래 걸리면 없는 것으로 친다 — 시작 버튼이 매달려 있으면 안 된다. */
const LOOKUP_TIMEOUT_MS = 4000

export function registerLocalCliIpc(): void {
  // #133 세션 분리(로컬). 명령 조립·검증은 util/localGit.ts 가 한다 — 렌더러는 폴더와 이름만 준다.
  handle('git:isRepo', ({ path }) => isGitRepo(String(path)).then((repo) => ({ repo })))
  handle('git:worktreeAdd', ({ path, name }) => addWorktree(String(path), String(name)))
  handle('git:worktreeRemove', ({ path, dest }) => removeWorktree(String(path), String(dest)))

  handle('app:launchShell', () => ({ shell: defaultLaunchShell() }))

  handle('app:hasCli', ({ bin }) => {
    const safe = validCliBin(bin)
    if (safe === null) return Promise.resolve({ found: false })
    return hasLocalCli(safe, LOOKUP_TIMEOUT_MS).then((found) => ({ found }))
  })
}
