// W1 트랙 B(F9/F10/F13) 스크린샷·E2E 하네스용 실(real) main 모듈 번들 엔트리.
// F7 하네스와 같은 구성 + registerTelemetryIpc — 스텁이 아닌 실제 폴링 서비스·LogTail 로 화면을 만든다.
export { MainSessionManager } from '../src/main/sessions/MainSessionManager'
export { connectSsh } from '../src/main/sessions/ssh/SshBackend'
export { registerSessionIpc } from '../src/main/ipc/registerSessionIpc'
export { registerSftpIpc } from '../src/main/ipc/registerSftpIpc'
export { registerTelemetryIpc } from '../src/main/ipc/registerTelemetryIpc'
export { startPasswordServer } from './ssh-harness'
