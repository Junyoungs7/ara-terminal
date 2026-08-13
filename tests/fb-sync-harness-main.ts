// FB-sync 실기동 스크린샷 하네스용 실(real) main 모듈 번들 엔트리(f7-harness-main.ts 와 같은 패턴).
// 목적: 스텁이 아닌 실제 SshBackend(FB-0007① OSC7 주입) + registerTelemetryIpc(FB-0008 로컬 게이지) 로
// 두 수정을 실제 out/ 앱 위에서 실증한다.
export { MainSessionManager } from '../src/main/sessions/MainSessionManager'
export { connectSsh } from '../src/main/sessions/ssh/SshBackend'
export { registerSessionIpc } from '../src/main/ipc/registerSessionIpc'
export { registerSftpIpc } from '../src/main/ipc/registerSftpIpc'
export { registerTelemetryIpc } from '../src/main/ipc/registerTelemetryIpc'
export { startPasswordServer } from './ssh-harness'
