// ISessionManager — 프로세스 위치 불변 인터페이스 (계획서 §B.7).
// Phase 2에서 UtilitySessionManager로 교체해도 renderer/shared 계약 변경 0.
import type { Session } from '@shared/types'

// manualTitle 은 복원 전용: 사용자가 바꿔 둔 탭 이름을 재스폰 후에도 OSC 제목에서 지켜 준다(R3.6).
export type SessionSpec = Pick<
  Session,
  'type' | 'shell' | 'profileId' | 'cwd' | 'serverKey' | 'title' | 'manualTitle'
>

// main→renderer 스트림 싱크. IPC 레이어가 주입한다(세션 매니저는 IPC를 모른다).
export interface SessionSink {
  // 배치된 출력 청크 (바이트 버짓 배칭 후). Uint8Array transferable로 전송.
  data(id: string, chunk: Uint8Array): void
  exit(id: string, exitCode: number, signal?: number): void
  // F7: OSC7 로 cwd 가 바뀌면 알림 → SFTP 파일 트리 자동 이동(터미널→트리 동기).
  cwd(id: string, cwd: string): void
}

export interface ISessionManager {
  create(spec: SessionSpec): Promise<string> // → sessionId
  // renderer 가 xterm 을 만든 직후 인계받는 재생 버퍼(세션 전환·재마운트·부트 복원 후 스크롤백 복구).
  // attach 전 출력은 링버퍼에만 쌓이므로 구독자 없는 구간의 출력도 유실되지 않는다.
  attach(id: string): Uint8Array
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  destroy(id: string): void
  // 백프레셔 메커니즘 2: renderer의 xterm write 백로그 임계치 초과 시 pty read 일시정지/재개.
  pause(id: string): void
  resume(id: string): void
  snapshot(): Session[]
  // 앱 종료 시 전체 pty 정리(좀비 프로세스 금지).
  destroyAll(): void
}
