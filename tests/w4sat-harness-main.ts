// W4sat F20 E2E 하네스용 실(real) main 모듈 번들 엔트리 — F7 패턴 재사용(tests/f7-harness-main.ts).
// 실 registerFsIpc(로컬)·registerSftpIpc(원격) + connectSsh/startPasswordServer 로 탐색기 2패널의
// 로컬↔원격 복사/이동을 실제 IPC 파이프라인으로 실증한다.
export { connectSsh } from '../src/main/sessions/ssh/SshBackend'
export { registerSessionIpc } from '../src/main/ipc/registerSessionIpc'
export { registerFsIpc } from '../src/main/ipc/registerFsIpc'
export { registerSftpIpc } from '../src/main/ipc/registerSftpIpc'
export { startPasswordServer } from './ssh-harness'
