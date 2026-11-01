// W2 IPC 핸들러 — F8 포트 포워딩(F12 로그 폴더는 S4 에서 붙는다). 채널명은 shared/ipc.ts 계약과 일치.
// 내장 브라우저는 M9 R2 에서 지웠다 — 링크·포트 [열기]는 Oriel(main/oriel/feature.ts).
import { shell } from 'electron'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { createForwardService, type ForwardService } from '../forward/PortForward'

// 반환값은 세션 종료 훅(stopSession)과 앱 종료 정리(stopAll)용.
export function registerForwardIpc(
  sessions: MainSessionManager,
  // F12 로그 폴더. 경로는 main 이 정하고 렌더러는 "열어 달라"만 말할 수 있다.
  // 2026-08-23: 설정에서 바꿀 수 있게 되면서 **함수**가 됐다 — 부팅 때 고정하면 폴더를 바꾼 뒤에도
  // 옛 폴더가 열린다.
  logDir: () => string
): { forwards: ForwardService } {
  const forwards = createForwardService(
    (id) => sessions.sshClient(id),
    (id) => sessions.snapshot().find((s) => s.id === id)?.title
  )

  handle('forward:create', ({ sessionId, remotePort, exactPort }) =>
    forwards.create(sessionId, remotePort, exactPort)
  )
  handle('forward:stop', ({ id }) => {
    forwards.stop(id)
    return { ok: true } as const
  })
  handle('forward:list', () => forwards.list())
  // F12: 로그 폴더를 탐색기로 연다. 경로 인자를 받지 않는다 — 렌더러가 임의 폴더를 열 수 없다.
  handle('sessionlog:reveal', async () => ({ ok: (await shell.openPath(logDir())) === '' }))

  return { forwards }
}
