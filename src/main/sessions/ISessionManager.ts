// ISessionManager — 프로세스 위치 불변 인터페이스 (계획서 §B.7).
// Phase 2에서 UtilitySessionManager로 교체해도 renderer/shared 계약 변경 0.
import type { Session } from '@shared/types'

// manualTitle 은 복원 전용: 사용자가 바꿔 둔 탭 이름을 재스폰 후에도 OSC 제목에서 지켜 준다(R3.6).
// winId 는 **부른 창**이다: 떼어낸 창에서 연 새 탭은 그 창 것이어야 한다(안 주면 본창).
// 없을 때 무슨 일이 났었나: 떼어낸 창이 만든 세션의 소유가 본창으로 잡혀 출력이 엉뚱한 창으로
// 갔다 — 받는 쪽에 그 탭이 없으니 아무 데도 안 나왔다.
export type SessionSpec = Pick<
  Session,
  'type' | 'shell' | 'profileId' | 'cwd' | 'serverKey' | 'title' | 'manualTitle' | 'winId'
>

// main→renderer 스트림 싱크. IPC 레이어가 주입한다(세션 매니저는 IPC를 모른다).
export interface SessionSink {
  // 배치된 출력 청크 (바이트 버짓 배칭 후). Uint8Array transferable로 전송.
  data(id: string, chunk: Uint8Array): void
  exit(id: string, exitCode: number, signal?: number): void
  // F7: OSC7 로 cwd 가 바뀌면 알림 → SFTP 파일 트리 자동 이동(터미널→트리 동기).
  cwd(id: string, cwd: string): void
  /**
   * 세션이 생겼다(로컬 create · SSH adopt 공통).
   *
   * **화면이 main 의 세션을 알게 되는 유일한 길이다.** 그전에는 렌더러가 "내가 연 것"만 기억했고,
   * 그래서 렌더러가 열지 않은 세션은 영영 탭이 없었다 — 아라가 MCP `ssh_connect` 로 서버에 붙으면
   * 연결은 진짜로 살아 있는데 화면에는 아무것도 안 떴다(2026-08-26 준영님 제보: *"접속했습니다라고
   * 뜨고 화면에 세션창이 안떠"*). 사람이 닫을 수도 없는 유령 세션이라 더 나빴다.
   *
   * 여기 한 곳에 두는 이유: MCP 만 고치면 main 에서 세션을 만드는 **다음** 경로가 같은 구멍을
   * 다시 판다(F26 서버 콘솔이 이미 그 자리에 있다). 생성 경로는 register() 하나로 모인다.
   */
  opened?(meta: Session): void
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
