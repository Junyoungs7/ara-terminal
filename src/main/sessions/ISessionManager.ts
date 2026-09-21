// ISessionManager — 프로세스 위치 불변 인터페이스 (계획서 §B.7).
// Phase 2에서 UtilitySessionManager로 교체해도 renderer/shared 계약 변경 0.
import type { Session } from '@shared/types'
import type { AiCommand } from '@shared/aiCli'

// manualTitle 은 복원 전용: 사용자가 바꿔 둔 탭 이름을 재스폰 후에도 OSC 제목에서 지켜 준다(R3.6).
// winId 는 **부른 창**이다: 떼어낸 창에서 연 새 탭은 그 창 것이어야 한다(안 주면 본창).
// 없을 때 무슨 일이 났었나: 떼어낸 창이 만든 세션의 소유가 본창으로 잡혀 출력이 엉뚱한 창으로
// 갔다 — 받는 쪽에 그 탭이 없으니 아무 데도 안 나왔다.
// aiCli 는 **무엇이 돌았는지의 기억**이다(1.0.8 ②): 아래 command 로 띄운 CLI 이름을 세션 메타에
// 남겨 스냅샷에 실린다 — 재시작 뒤 그 탭을 맨 셸이 아니라 [이어서 시작] 카드로 되살리는 단서다.
export type SessionSpec = Pick<
  Session,
  | 'type'
  | 'shell'
  | 'profileId'
  | 'cwd'
  | 'serverKey'
  | 'title'
  | 'manualTitle'
  | 'winId'
  | 'aiCli'
  // 복원이 **저장해 둔 치수**로 pty 를 연다(`Session.cols` 주석 — 안 주면 80×24 로 열려 첫
  // 프롬프트가 접힌다). 새 세션은 안 준다: 그때는 렌더러가 sizeOf 로 지금 칸을 잰다.
  | 'cols'
  | 'rows'
> & {
  /**
   * D(#168) **이 세션의 프로세스가 곧 이 CLI 다.** 주면 셸을 열지 않는다.
   *
   * `shell` 과 성격이 다르다: 저건 "무슨 셸을 열까"(문자열 하나)라 인자를 실을 자리가 없고,
   * 이건 **명령 + 인자**라 배열이어야 한다(문자열로 이으면 `#152` 의 인용 문제가 돌아온다).
   * `Session` 메타에는 **이 배열을 남기지 않는다** — 스냅샷의 명령줄을 그대로 다시 스폰하는 길을
   * 만들지 않는다(손으로 고칠 수 있는 파일이 곧 실행 인자가 된다). 남는 것은 위 `aiCli` 이름
   * 하나이고, 되살릴 때의 플래그는 그때 최근 목록·설정에서 다시 조립한다(1.0.8 ②).
   *
   * 신뢰 경계: 스폰하는 쪽이 `safeAiCommand` 로 한 번 더 본다(MCP `session_create` 스키마에는
   * 이 필드가 없다 — AI 는 실행파일을 고를 수 없다는 S1 규칙 그대로다).
   */
  command?: AiCommand
}

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
  /**
   * 세션을 **없앴다**(`destroy`). 위 `opened` 의 짝이다 — 만들 때만 알리고 없앨 때 안 알리면
   * 한쪽만 온전한 길이 된다(#201 B).
   *
   * 없어서 무슨 일이 났나: 아라가 MCP `session_destroy` 로 탭을 끄면 화면이 그것을 영영 모른다 —
   * 탭·칸·상태점이 그대로 남고, SSH 면 `closedByUser` 표시가 없어 뒤따르는 exit 이
   * **"연결이 끊겼습니다" 재접속 카드**를 띄운다. 아라가 **일부러** 끈 세션에 그렇다
   * (그 도구의 설명은 *"탭을 닫는 것과 같습니다"* 다).
   *
   * 🔴 **핸들을 지우기 전에** 부른다 — 라우터가 `winIdOf(id)` 로 보낼 창을 찾는데 핸들이
   *    사라진 뒤엔 그 값이 없어 본창으로 떨어진다(떼어낸 창이 못 받는다).
   * ⚠️ `destroyAll()`(앱 종료)도 이 길을 지난다. 창이 닫히는 중일 수 있어 받는 쪽은 죽은
   *    webContents 를 견뎌야 한다 — `pushSend` 가 이미 그것을 삼킨다(util/windowPush.ts).
   */
  closed?(meta: Session): void
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
