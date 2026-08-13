// F7 E2E 하네스용 실(real) main 모듈 번들 엔트리. esbuild 로 CJS 단일 파일로 묶어 스크린샷 하네스가 require 한다.
// 목적: 스텁이 아닌 실제 MainSessionManager(OSC7 cwd 추적) + 실 registerSessionIpc/registerSftpIpc +
// 실 SftpService(커넥션 재사용·진행률·취소·부분 파일 정리)로 SFTP 파이프라인 전체를 실증한다.
export { MainSessionManager } from '../src/main/sessions/MainSessionManager'
export { connectSsh } from '../src/main/sessions/ssh/SshBackend'
export { registerSessionIpc } from '../src/main/ipc/registerSessionIpc'
export { registerSftpIpc } from '../src/main/ipc/registerSftpIpc'
export { startPasswordServer } from './ssh-harness'
