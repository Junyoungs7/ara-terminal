// F6 E2E 하네스용 실(real) main 모듈 번들 엔트리. esbuild 로 CJS 단일 파일로 묶어 하네스가 require 한다.
// 목적: 스텁이 아닌 실제 WorkspaceStore(저장/flush/.bak/복원) + MainSessionManager(OSC7 cwd 추적) +
// ProfileStore/SafeStorageSecretStore(vault) + 실 IPC 등록부로 복원 파이프라인을 실증한다.
export { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
export { HistoryStore } from '../src/main/history/HistoryStore'
export { MainSessionManager } from '../src/main/sessions/MainSessionManager'
export { SafeStorageSecretStore } from '../src/main/secrets/SafeStorageSecretStore'
export { ProfileStore } from '../src/main/secrets/ProfileStore'
export { registerWorkspaceIpc } from '../src/main/ipc/registerWorkspaceIpc'
export { registerSessionIpc } from '../src/main/ipc/registerSessionIpc'
export { registerProfileIpc } from '../src/main/ipc/registerProfileIpc'
export { registerSshIpc } from '../src/main/ipc/registerSshIpc'
export { startPasswordServer } from './ssh-harness'
