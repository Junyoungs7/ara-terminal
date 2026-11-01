// #90(2026-08-16) — 이 PC 의 기본 셸이 어느 문법인가(posix · PowerShell · cmd). M3 부터는 설정 › 에이전트의
// "실행될 명령" 미리보기가 쓴다(실제 실행은 main 이 같은 함수로 정한다 — agents/feature.ts).
// **powershell.exe(5.1)는 `&&` 가 파서 오류**라 잘못 고르면 명령이 아예 실행되지 않는다.
// 셸 선택 규칙은 PtyBackend 가 이미 갖고 있으므로 그 함수를 그대로 쓴다(두 벌로 갈리면 안 된다).
import { handle } from './handle'
import { defaultLaunchShell } from '../sessions/PtyBackend'

export function registerLocalCliIpc(): void {
  handle('app:launchShell', () => ({ shell: defaultLaunchShell() }))
}
