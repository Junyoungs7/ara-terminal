// IPC 타입 계약 (단일 진실). main 핸들러·preload 브리지·renderer 호출부가 이 파일을 import한다.
// 계획서 §B.2. F1은 workspace 도메인만; F2에서 session 도메인이 붙는다.

import type { LaunchShell } from './aiCli'
import type {
  WorkspaceSnapshot,
  WorkspaceSaveInput,
  DetachedWindowState,
  Session,
  ConnectionProfile,
  ProfileInput,
  FontConfig,
  SidebarState,
  UiPrefs,
  RemotePort,
  RemoteStats,
  HostStats,
  PortForward,
  ForwardResult,
  AiState,
  AiKeyResult,
  AiEnd,
  AiEnv,
  McpState,
  McpSessionMode,
  McpApprovalDecision,
  McpApprovalRequest,
  McpActivity,
  WorkProfile
} from './types'
import type { AiCliRecent } from './aiCli'
import type { BrowserTabView } from './browserWin'
import type { SpanDisplay, SpanPlan } from './rdpSpan'
import type { SessionSpec } from '../main/sessions/ISessionManager'
import type { RunFailReason, RunResult } from '../main/remote/RemoteConsoleService'
import type { CmdId } from './remoteCatalog'
import type { TmuxListResult } from './tmuxList'
import type { PastLog } from '../main/log/SessionLog'
export type { PastLog }

// 디렉토리 항목(계획서 §C F7 / design-system 5.2 파일 행). 폴더 우선 정렬은 main이 담당.
// R7: 로컬 파일시스템(fs:*)과 원격 SFTP(sftp:*)가 같은 항목·결과 타입을 쓴다 — [파일] 탭은
// 백엔드만 갈아끼우고 렌더 코드는 하나다.
export type FileEntry = {
  name: string
  // 심볼릭 링크는 **가리키는 대상**의 종류로 채운다 — 그래야 링크 폴더가 폴더처럼 정렬·동작한다
  // (끊긴 링크는 'file' + broken). 링크라는 사실 자체는 link 로 구분해 아이콘에 쓴다.
  type: 'dir' | 'file'
  link?: boolean
  broken?: boolean // 링크인데 대상이 없다(권한 부족 포함)
  size: number // 바이트(디렉토리는 0). UI는 사람이 읽는 단위로 포맷.
  mtime: number // epoch ms
}

// 목록 결과. 실패(권한/경로없음/연결끊김)는 예외 대신 구조화 반환(트리 영역에 표시, 크래시 금지).
// parent 는 상위 경로 — 경로 구분자(posix '/' vs Windows '\')를 아는 쪽이 main 이므로 거기서 계산한다.
export type FileListResult =
  | { ok: true; path: string; parent: string; entries: FileEntry[] }
  | { ok: false; message: string }

// 편집기 읽기 결과. eol 은 저장할 때 원본 줄바꿈을 되돌리기 위한 것(CRLF 파일을 LF 로 바꿔
// 저장하면 diff 가 통째로 뒤집힌다).
export type EditorReadResult =
  | { ok: true; text: string; eol: 'lf' | 'crlf'; bytes: number }
  | { ok: false; message: string }

// 로그 패널 읽기 결과. source='file' 이면 세션 시작부터의 기록(F12), 'buffer' 면 최근 화면 버퍼뿐이다.
// start=0 이면 앞이 더 없다(= 처음까지 다 불러왔다). size 는 전체 크기(진행 표시용).
export type SessionLogReadResult =
  | { ok: true; text: string; source: 'file' | 'buffer'; start: number; size: number }
  | { ok: false; message: string }

// 파일 조작(이름 변경·새 폴더·삭제) 결과. canceled 는 진행 중 재귀 삭제를 사용자가 멈춘 경우.
export type FileOpResult = { ok: true } | { ok: false; message: string; canceled?: boolean }

// 전송 결과. 취소·실패 시 부분 파일 정리 여부를 함께 알린다(C-4).
export type SftpXferResult =
  | { ok: true }
  | { ok: false; canceled: boolean; message: string; cleaned: boolean }

// 전송 진행 이벤트(sftp:progress:{transferId}). transferred/total 바이트.
export type SftpProgress = { transferId: string; transferred: number; total: number }

// SSH 연결 결과(계획서 §C F3). 성공/호스트키확인필요/실패를 구조화(예외 대신 판별 유니온).
export type SshConnectResult =
  // title 은 main 이 정한 탭 이름(같은 서버 다중 세션은 ·2, ·3 로 구분 — R2.1).
  // 옛 테스트 하네스는 돌려주지 않으므로 호출측은 프로필명으로 폴백한다.
  | { ok: true; id: string; title?: string }
  // 최초 접속(TOFU): 사용자에게 지문 확인 후 acceptHostKey=true로 재호출.
  | { ok: false; reason: 'hostKeyNew'; hostId: string; algorithm: string; fingerprint: string }
  // 호스트키 불일치(MITM 가능): 연결 차단.
  | { ok: false; reason: 'hostKeyMismatch'; hostId: string; algorithm: string; fingerprint: string; knownFingerprint: string }
  // vault에 secretRef 키 없음(고아 참조) → 재인증 필요.
  | { ok: false; reason: 'orphanSecret' }
  | { ok: false; reason: 'auth'; message: string }
  | { ok: false; reason: 'network'; message: string }

/**
 * [접속 테스트] 결과 (2026-08-21 준영님 요청 — 저장 후 접속 하나였던 버튼을 셋으로 갈랐다).
 *
 * 세션을 만들지 않는다: SSH 는 붙어 보고 **바로 끊는다**, RDP 는 서버에 닿는지까지만 본다
 * (RDP 비밀번호 검증은 wasm 클라이언트 전 경로가 필요해 실제 접속과 다를 게 없다 — 그 한계를
 * note 로 말한다. 조용히 "성공"이라고 하지 않는다).
 *
 * 처음 보는 서버는 hostKeyNew 로 떨어진다. 테스트가 지문을 대신 수락하면 TOFU 가 무의미해지므로
 * knownHosts 를 건드리지 않고, 화면이 "[저장 후 접속]에서 지문을 확인해 주세요"로 안내한다.
 */
export type ConnTestResult =
  | { ok: true; note?: 'rdpReachOnly' }
  | { ok: false; reason: 'hostKeyNew' | 'hostKeyMismatch' | 'orphanSecret' | 'auth' | 'network'; message?: string }

// invoke(요청→응답) 채널의 요청/응답 타입.
export type InvokeContract = {
  'workspace:load': { req: void; res: WorkspaceSnapshot }
  // 저장은 렌더러 소유 필드만(WorkspaceSaveInput). main 이 나머지를 유지한 채 병합한다 — 전체 스냅샷을
  // 받던 시절엔 뒤늦게 도착한 저장이 지운 프로필·호스트키·그룹을 되살렸다(T1 BLOCKER-1).
  'workspace:save': { req: WorkspaceSaveInput; res: { ok: true } }
  // 터미널 동작 설정(R5 설정 창). 우클릭 스타일 하나만 받던 ui:setCtxMenuStyle 을 대체한다 —
  // 설정 창이 여섯 값을 한 화면에서 바꾸는데 채널을 여섯 개로 늘릴 이유가 없다.
  'ui:setPrefs': { req: UiPrefs; res: { ok: true } }
  // R6 연결 그룹 목록. 프로필이 없는 빈 그룹은 파생으로 나오지 않아 여기 저장해야 살아남는다.
  'ui:setGroups': { req: { groups: string[] }; res: { ok: true } }
  // 작업 프로필 목록(서버+폴더 즐겨찾기). 그룹 목록과 같은 형태 — 전체를 통째로 덮어쓴다.
  'ui:setWorkProfiles': { req: { list: WorkProfile[] }; res: { ok: true } }
  // F27 AI CLI 최근 목록. 작업 프로필과 같은 형태(전체를 통째로 덮어쓴다) — 상한은 렌더러가 지키고
  // main 은 배열인지만 본다(WorkProfile 과 같은 규칙).
  'ui:setAiCliRecent': { req: { list: AiCliRecent[] }; res: { ok: true } }
  // 폰트 설정(F5). ui.font{term,sizePx,lineHeight} 만 갱신 + 즉시 flush(재시작 후 유지).
  'ui:setFont': { req: FontConfig; res: { ok: true } }
  // 사이드바 폭·접힘·활성 탭(R4.3). setFont 와 같은 좁은 필드 갱신 — 전체 스냅샷 저장(workspace:save)과
  // 경쟁하지 않는다(그쪽은 세션·레이아웃 담당).
  'ui:setSidebar': { req: SidebarState; res: { ok: true } }
  'app:getVersion': { req: void; res: string }
  // R3.3: 터미널 안 URL 을 기본 브라우저로 연다. 렌더러가 shell 모듈을 직접 쓰지 못하므로 main 경유이며,
  // main 이 http/https 만 통과시킨다(file:·custom scheme 로 임의 프로그램 실행 금지).
  'app:openExternal': { req: { url: string }; res: { ok: boolean } }
  // #90: AI CLI 를 내 PC 에서 시작할 때 main 만 알 수 있는 두 가지.
  //   launchShell — 기본 셸의 조립 규칙(powershell.exe 5.1 은 `&&` 가 파서 오류다).
  //   hasCli      — 그 실행 파일이 이 PC 에 있는가(where/which, 셸을 거치지 않는다).
  'app:launchShell': { req: void; res: { shell: LaunchShell } }
  /**
   * 2026-08-23 설정 [기록 폴더] — 지금 **실제로 쓰이는** 두 폴더와 기본 자리.
   * 화면이 저장된 설정값만 보면 "빈 값 = 기본"이 어디인지 못 보여 준다(그 값은 main 만 안다).
   */
  'app:logPaths': { req: void; res: { sessionLogDir: string; appLogDir: string; defaultDir: string } }
  'app:hasCli': { req: { bin: string }; res: { found: boolean } }
  // session 도메인 (계획서 §B.2/§B.7). create/resize/destroy/list.
  'session:create': { req: SessionSpec; res: { id: string } }
  'session:resize': { req: { id: string; cols: number; rows: number }; res: { ok: true } }
  'session:destroy': { req: { id: string }; res: { ok: true } }
  'session:list': { req: void; res: Session[] }
  // F30 AI 세션 패널: 세션별 마지막 출력 시각. session:list 와 나눈 이유는 그쪽이 workspace.json 으로
  // 영속되는 타입이기 때문이다(매 출력마다 바뀌는 값을 넣으면 스냅샷이 늘 더럽다).
  'session:activity': { req: void; res: { id: string; lastDataAt: number }[] }
  // 탭 이름 변경(R2.1). main 의 meta.title 이 진실이라(persist 가 session:list 를 저장한다)
  // 여기서 갱신해야 재시작 후에도 이름이 남는다.
  'session:rename': { req: { id: string; title: string }; res: { ok: true } }
  // R3.6: 셸이 보낸 OSC 0/2 제목. 사용자가 rename 한 세션(manualTitle)에는 적용하지 않는다 —
  // applied=false 면 렌더러도 탭 라벨을 그대로 둔다.
  'session:autoTitle': { req: { id: string; title: string }; res: { applied: boolean } }
  // xterm 생성 직후 재생 버퍼를 인계받고 라이브 스트림을 연다(세션 전환·재마운트 후 스크롤백 복구).
  'session:attach': { req: { id: string }; res: { backlog: Uint8Array } }
  // window 도메인 (R2.6). 프레임리스 타이틀바의 신호등 버튼이 실제로 창을 조작한다.
  'window:minimize': { req: void; res: { ok: true } }
  'window:toggleMaximize': { req: void; res: { maximized: boolean } }
  'window:close': { req: void; res: { ok: true } }
  // F32 세션 창 — 탭을 별도 OS 창으로 떼어내고 되돌린다. 세션은 main 에 살아 있으므로
  // 이 두 채널은 **소유 표시만** 바꾼다(재접속·화면 재생이 없다).
  // at: 탭을 창 밖으로 끌어다 놓은 **화면 좌표**(2026-08-22 준영님 제보 4·31 — "탭 드래그로 새 창").
  // 그 자리에 창을 띄운다: 다른 모니터로 끌어냈는데 창이 주 모니터에 뜨면 끌어낸 의미가 없다.
  'win:detach': { req: { sessionId: string; at?: { x: number; y: number } }; res: { ok: boolean; winId?: string } }
  /**
   * 세션의 **소유 창을 바꾼다**. winId 를 주면 그 창으로, 안 주면 본창으로.
   *
   * 2026-08-23: `win:reattach`(본창으로만) 를 여기로 일반화했다 — 크롬처럼 **탭을 다른 창의
   * 탭바에 끌어다 놓으면 그 창으로 합쳐지기** 때문에 목적지가 본창 하나가 아니게 됐다.
   * 없는 창을 목적지로 주면 거절한다(ok:false) — 세션이 아무 창도 못 그리는 곳에 갇히면 안 된다.
   */
  'win:moveTo': { req: { sessionId: string; winId?: string }; res: { ok: boolean } }
  /**
   * 떼어낸 창을 닫을 때의 답(2026-08-22 준영님 결정 "물어보고 세션 종료").
   * main 이 창 닫기를 **막고** `win:closeAsk` 를 보내면, 그 창이 목록을 보여 주고 여기로 답한다.
   *   kill=true  → 이 창의 세션을 종료하고 닫는다
   *   kill=false → 본창으로 되돌리고 닫는다(실수로 닫았을 때의 탈출구)
   * 취소는 아무것도 부르지 않는다 — 창은 그대로 열려 있다.
   */
  'win:closeConfirm': { req: { winId: string; kill: boolean }; res: { ok: true } }
  /**
   * F32 R2 복원 — 본창이 세션을 **다 되살린 뒤** 한 번 부른다.
   *
   * 복원은 세션을 새로 만들므로(pty 는 재시작을 못 넘는다) id 가 전부 바뀐다. 그래서 소유를
   * 다시 붙여 줘야 하고, 그 일이 끝난 **다음에** 창을 열어야 그 창이 자기 세션을 찾는다 —
   * 순서가 뒤집히면 빈 창이 뜬다. 두 가지를 한 호출로 묶은 이유가 그 순서다.
   */
  'win:restore': {
    req: { assign: { sessionId: string; winId: string }[]; windows: DetachedWindowState[] }
    res: { opened: number }
  }
  // profile 도메인 (계획서 §B.2/§C F3). 비밀은 vault로, workspace.json엔 secretRef만.
  'profile:list': { req: void; res: ConnectionProfile[] }
  'profile:save': { req: ProfileInput; res: { profile: ConnectionProfile } }
  'profile:delete': { req: { id: string }; res: { ok: true } }
  // ssh 연결(호스트키 TOFU + vault 비밀 복호). acceptHostKey는 최초 접속 확인 후 재호출용.
  // password: 이번 접속에만 쓰는 비밀번호(2026-08-21 준영님 제보 18번 — "따로 저장하지 않고 연결 후
  // 입력"). 저장돼 있는 비밀보다 우선하고 **vault 에 쓰지 않는다**. RDP 는 예전부터 이 흐름이었고
  // (rdp-creds 화면) SSH 에는 없어서, 비밀번호를 저장하지 않으면 접속할 길이 아예 없었다.
  'ssh:connect': { req: { profileId: string; acceptHostKey?: boolean; password?: string }; res: SshConnectResult }
  // 호스트키 재설정: 프로필의 knownHosts 항목 삭제 → 다음 접속이 다시 TOFU 확인이 된다.
  // 서버 재설치로 지문이 바뀐 경우 mismatch 차단을 푸는 유일한 경로(사용자 확인 후 호출).
  'ssh:forgetHostKey': { req: { profileId: string }; res: { ok: true; removed: boolean } }
  // [접속 테스트] — 세션을 만들지 않고 붙는지만 본다. **저장하기 전의 폼 값**으로 시험하므로
  // profileId 가 아니라 ProfileInput 을 받는다(그게 이 버튼을 [저장]과 가르는 점이다).
  // 비밀이 비어 있고 id 가 있으면 vault 의 기존 비밀을 쓴다(폼의 "비우면 기존 유지"와 같은 규칙).
  'conn:test': { req: { input: ProfileInput }; res: ConnTestResult }
  // (2026-08-09 제거) W4sat F21 의 `rdp:launch` — OS 클라이언트 외부 실행. F25 이후 진입점이 없었고
  // 준영님이 A-40 을 "안 쓴다"로 닫았다. 앱은 이제 RDP 를 내장 뷰로만 연다.
  // 앱 내장 RDP(F25): main 이 loopback 릴레이를 띄우고 그 주소를 돌려준다. 접속 대상(host:port)은
  // **프로필에서 main 이 정한다** — 렌더러는 profileId 만 말할 수 있어 임의 호스트로 못 간다(F8 원칙).
  'rdp:relay': {
    req: { profileId: string }
    res:
      // password: 프로필에 저장해 둔 비밀번호가 있을 때만 실린다. RDP 클라이언트(wasm)가 렌더러에
      // 있어 main 이 대신 인증해 줄 수 없다 — ssh 와 달리 비밀이 렌더러까지 와야 접속이 된다.
      // 없으면(미저장) 렌더러가 그때 사용자에게 입력받는다.
      | { ok: true; relayId: string; url: string; token: string; destination: string; username: string; password?: string }
      | { ok: false; message: string }
  }
  'rdp:relayStop': { req: { relayId: string }; res: { ok: true; reason?: string } }
  // 다중 모니터(2026-08-09): 모니터 목록을 렌더러에 넘겨 어디에 펼칠지 고르게 한다.
  // 좌표·배율은 OS 가 준 값 그대로 — 렌더러의 window.screen 은 창이 있는 모니터만 알기 때문에 못 쓴다.
  'rdp:displays': { req: Record<string, never>; res: { displays: SpanDisplay[] } }
  // 고른 모니터를 감싸는 자리에 테두리 없는 창을 띄우고, 그 창이 원격에 요구할 크기를 함께 돌려준다.
  // displayIds 가 비면 전체 모니터. 접속 대상은 여전히 profileId 로만 정한다(임의 호스트 금지).
  'rdp:openSpan': {
    req: { profileId: string; name: string; displayIds: number[] }
    res: { ok: true; plan: SpanPlan } | { ok: false; message: string }
  }
  'rdp:closeSpan': { req: { profileId: string }; res: { ok: true } }
  // 다중 모니터 창이 뜬 뒤 자기 계획(모니터별 좌표)을 받아 간다.
  'rdp:spanPlan': { req: { profileId: string }; res: { plan: SpanPlan | null } }
  // fs 도메인 (R7). 로컬 세션의 [파일] 탭. sftp:* 와 같은 계약 형태 — sessionId 만 없다.
  // path '.' 는 홈 디렉토리. rename/mkdir 의 name 은 경로 구분자를 포함할 수 없다(디렉토리 탈출 금지).
  'fs:list': { req: { path: string }; res: FileListResult }
  'fs:rename': { req: { path: string; name: string }; res: FileOpResult }
  'fs:mkdir': { req: { dir: string; name: string }; res: FileOpResult }
  // #88 R2: 새 파일(빈 파일). 이미 있으면 실패한다 — 있는 파일을 0바이트로 날리지 않는다.
  'fs:newFile': { req: { dir: string; name: string }; res: FileOpResult }
  // #88 R2: 잘라내기(이동). 같은 볼륨이면 rename, 다르면 복사 후 원본 삭제. 덮어쓰기는 하지 않는다.
  // 로컬↔로컬 전용 — 원격이 끼면 전송이라 sftp:* 가 맡는다.
  'fs:move': { req: { paths: string[]; destDir: string }; res: FileOpResult }
  // #88 R2: 드라이브 목록(윈도우 "내 PC"). 맥은 루트 + /Volumes 마운트.
  /** 폴더 하나 고르기(설정의 기록 폴더). 취소하면 null — 경로를 렌더러가 지어내지 못한다. */
  'fs:pickDir': { req: void; res: { dir: string | null } }
  'fs:drives': { req: void; res: { drives: { path: string; label: string }[] } }
  // #89: 로컬 삭제는 **휴지통**(shell.trashItem)이다. 이름이 remove 가 아닌 이유 — 실제로 그렇게
  // 동작하고, 영구 삭제 경로는 남겨 두지 않는다(있으면 언젠가 실수로 그쪽이 배선된다).
  // 원격 삭제는 sftp:remove 로 따로 가고 그쪽은 영구다(서버에 휴지통이 없다).
  // 여러 항목을 한 번에 — 하나라도 실패하면 그 지점에서 멈추고 사유 반환.
  'fs:trash': { req: { paths: string[] }; res: FileOpResult }
  // #89: OS 기본 프로그램으로 열기(이미지·PDF·xlsx). 로컬 전용 — 원격 파일은 실체가 이 PC 에 없다.
  'fs:openPath': { req: { path: string }; res: FileOpResult }
  // #92: 탐색기에서 그 파일을 고른 채로 폴더 열기.
  'fs:reveal': { req: { path: string }; res: FileOpResult }
  // #92: 원격 파일을 받는 기본 폴더(OS 다운로드 폴더).
  'fs:downloadsDir': { req: void; res: { dir: string } }
  // #92: dir 안에서 비어 있는 이름(`보고서 (2).xlsx`). 덮어쓰기를 피한다.
  'fs:freeName': { req: { dir: string; name: string }; res: { name: string } }
  // W4sat F20: 로컬↔로컬 패널 간 복사(재귀).
  // #90: 중간 단계까지 만든다(mkdir -p). AI CLI 시작 창의 [없으면 만들기] 로컬 경로.
  'fs:mkdirp': { req: { path: string }; res: FileOpResult }
  'fs:copy': { req: { paths: string[]; destDir: string }; res: FileOpResult }
  // 편집기 창(노트) — sessionId 가 있으면 원격(SFTP), 없으면 로컬. 읽기/쓰기 한 쌍뿐이다.
  // 큰 파일·바이너리는 main 이 거른다(shared/textFile.ts) — 열지 못한 이유를 문구로 돌려준다.
  // 로그 패널 — 세션의 CLI 내역. before 를 주면 그 위치 앞쪽 창을 읽는다("이전 불러오기").
  'sessionlog:read': { req: { sessionId: string; before?: number }; res: SessionLogReadResult }
  // #86: 지난 세션 기록 목록·읽기. 그 세션은 이미 없으므로 **파일 이름**으로 다룬다
  //  (이름 검증은 main 이 한다 — 경로 구분자가 든 이름은 거절된다).
  'sessionlog:list': { req: void; res: { list: PastLog[] } }
  'sessionlog:readFile': { req: { file: string; before?: number }; res: SessionLogReadResult }
  // 내려받기: 창이 아니라 전체를 저장한다. 저장 위치는 main 의 저장 대화상자가 받는다(취소 시 ok:false).
  'sessionlog:save': { req: { sessionId: string }; res: FileOpResult }
  // 창 제목에 쓸 서버 이름은 main 이 세션 메타에서 꺼낸다(렌더러가 정하지 않는다).
  'editor:open': { req: { sessionId: string | null; path: string }; res: { ok: boolean } }
  'editor:read': { req: { sessionId: string | null; path: string }; res: EditorReadResult }
  // eol 은 읽을 때 받은 값을 그대로 돌려준다(원본 줄바꿈 보존 — main 이 상태를 들고 있지 않게).
  'editor:write': {
    req: { sessionId: string | null; path: string; text: string; eol: 'lf' | 'crlf' }
    res: FileOpResult
  }
  // sftp 도메인 (계획서 §B.2/§C F7). 활성 SSH 세션의 커넥션에서 sftp 서브시스템 재사용(새 연결 금지).
  'sftp:list': { req: { sessionId: string; path: string }; res: FileListResult }
  // R7 원격 파일 조작 — fs:* 와 같은 형태(+sessionId). remove 는 opId 로 취소할 수 있다(sftp:cancel).
  'sftp:rename': { req: { sessionId: string; path: string; name: string }; res: FileOpResult }
  'sftp:mkdir': { req: { sessionId: string; dir: string; name: string }; res: FileOpResult }
  'sftp:remove': { req: { sessionId: string; opId: string; paths: string[] }; res: FileOpResult }
  // 같은 서버 안 복사. SFTP 에 서버측 copy op 가 없어 원격에서 `cp -a` 를 돌린다(경로는 인용된다).
  'sftp:copyRemote': { req: { sessionId: string; paths: string[]; destDir: string }; res: FileOpResult }
  // download: 원격 remotePath → 로컬 localPath. upload: 로컬 → 현재 디렉토리(remoteDir).
  // transferId는 진행 이벤트·취소용(호출측이 생성). 결과는 취소/부분정리 포함 구조화.
  'sftp:download': { req: { sessionId: string; transferId: string; remotePath: string; localPath: string; size: number }; res: SftpXferResult }
  'sftp:upload': { req: { sessionId: string; transferId: string; localPath: string; remoteDir: string }; res: SftpXferResult }
  // 서버 A → 서버 B. 디스크를 거치지 않고 두 SFTP 스트림을 main 에서 직접 잇는다.
  // 두 세션 id 가 같으면 거절한다 — 같은 서버는 sftp:copyRemote(exec cp)가 네트워크를 안 탄다.
  'sftp:copyBetween': {
    req: { srcSessionId: string; destSessionId: string; transferId: string; remotePath: string; destDir: string; size: number }
    res: SftpXferResult
  }
  // 진행 중 전송 취소(C-4). abort + 부분 파일 정리는 main이 수행.
  'sftp:cancel': { req: { transferId: string }; res: { ok: true } }
  // 다운로드 저장 위치/업로드 파일 선택(드래그 불가 환경 폴백 + 저장 대화상자). 취소 시 null/빈배열.
  'sftp:pickSavePath': { req: { defaultName: string }; res: { path: string | null } }
  // 다중 다운로드는 파일마다 저장 대화상자를 띄우지 않고 받을 폴더를 한 번만 고른다.
  'sftp:pickSaveDir': { req: void; res: { path: string | null } }
  'sftp:pickUploadPaths': { req: void; res: { paths: string[] } }
  // W1 텔레메트리(F9/F10). SSH 세션당 exec 채널 하나로 폴링하고, 구독이 0이 되면 멈춘다.
  // 구독 단위는 세션이라 start 를 두 번 불러도 폴러는 하나다.
  'telemetry:start': { req: { sessionId: string }; res: { ok: true } }
  'telemetry:stop': { req: { sessionId: string }; res: { ok: true } }
  // 수동 새로고침 — **구독을 늘리지 않고** 지금 한 바퀴만 돈다. 예전엔 start 를 다시 불렀는데,
  // 창이 둘이 되면서 start 에 참조 계수가 생겨 그 방식으로는 참조가 샌다(2026-08-21).
  'telemetry:refresh': { req: { sessionId: string }; res: { ok: true } }
  // 포트 모니터 독립 창 열기(없으면 만들고, 있으면 앞으로). 창은 하나 · 서버는 그 안의 탭.
  'portwin:open': { req: Record<string, never>; res: { ok: true } }
  // 내장 브라우저 탭(2026-08-21). 탭 줄 렌더러 → main. 페이지 본문은 WebContentsView 라
  // 이 채널들은 **우리 탭 줄에서만** 불린다(원격 페이지엔 preload 가 없다).
  'browser:select': { req: { id: string }; res: { ok: true } }
  'browser:closeTab': { req: { id: string }; res: { ok: true } }
  // 오리진으로 닫기 — 포트 표의 [닫기]가 쓴다(그쪽은 탭 id 를 모르고 주소만 안다).
  // 마지막 탭이면 창까지 닫히는 것은 closeTab 의 기존 규칙 그대로다.
  'browser:closeOrigin': { req: { origin: string }; res: { ok: boolean } }
  'browser:reload': { req: Record<string, never>; res: { ok: true } }
  'browser:back': { req: Record<string, never>; res: { ok: true } }
  // F29 시스템 모니터 [로컬] 탭 — **세션과 무관한** 내 PC 통계. telemetry:* 와 달리 sessionId 가 없다:
  // 로컬 셸을 하나도 안 열어 둔 상태(SSH 만 쓰는 중)에서도 내 PC 를 보여 줘야 하기 때문이다.
  // 패널이 열려 있는 동안만 돈다 — 닫으면 stop 이 폴러를 끈다(원격 텔레메트리와 같은 규칙).
  'sys:start': { req: void; res: { ok: true } }
  'sys:stop': { req: void; res: { ok: true } }
  // W1 로그 뷰어(F13). tail -F 스트림 하나가 id 하나 — stop 이 원격 프로세스를 죽인다.
  'logtail:start': { req: { sessionId: string; path: string }; res: { id: string } }
  'logtail:stop': { req: { id: string }; res: { ok: true } }
  // [이전 불러오기] — tail 은 과거를 못 보여 준다. 파일 뒤에서부터 창 단위로 읽어 앞쪽을 잇는다.
  'logtail:history': { req: { sessionId: string; path: string; before?: number }; res: SessionLogReadResult }
  // FB-monitor: 트리 우클릭 tmux 서브메뉴 — 호버 시 1회 조회(폴링 아님). 대상 세션의 ssh2 커넥션을
  // telemetry 와 동일하게 재사용한다(새 연결 금지 — sftp:*/telemetry:* 와 같은 규칙).
  'tmux:listSessions': { req: { sessionId: string }; res: TmuxListResult }
  // ── F26 서버 콘솔 ──
  // **명령 문자열을 받는 채널이 없다는 것이 계약이다.** 렌더러가 말할 수 있는 것은 cmdId 와 인자뿐이고,
  // 실제 문자열은 main 이 shared/remoteCatalog.ts 의 buildCommand() 로 조립한다 — 표에 없는 id·검증에
  // 걸린 인자는 아무것도 실행하지 않고 reason:'badArgs' 로 돌아온다. 이 선이 이 기능의 보안 경계다.
  // 커넥션은 텔레메트리·SFTP 와 같은 활성 SSH 세션 것을 재사용한다(새 연결 금지).
  'remote:run': { req: { sessionId: string; cmdId: CmdId; args?: unknown }; res: RunResult }
  // 주기 실행(2.5초, 텔레메트리와 같은 주기). 상태를 바꾸는 명령은 구독할 수 없다 — main 이 거절한다.
  'remote:watch': { req: { sessionId: string; cmdId: CmdId; args?: unknown }; res: { ok: true } }
  'remote:unwatch': { req: { sessionId: string; cmdId: CmdId }; res: { ok: true } }
  // ── W2 F8 포트 포워딩 ──
  // 원격 목적지는 언제나 127.0.0.1 이다 — 렌더러는 **포트 번호만** 말할 수 있다(remoteHost 필드 없음).
  // 로컬 리스너도 127.0.0.1 고정이라 바인드 주소를 지정할 경로가 계약에 존재하지 않는다(설계 §2 불변식 1·2).
  // exactPort=true 는 OAuth 경로: redirect_uri 에 포트가 박혀 오므로 그 번호가 아니면 실패해야 한다
  // (임의 포트로 조용히 폴백하면 "브라우저는 떴는데 인증이 영영 안 끝나는" 상태가 된다).
  'forward:create': { req: { sessionId: string; remotePort: number; exactPort?: boolean }; res: ForwardResult }
  'forward:stop': { req: { id: string }; res: { ok: true } }
  // push 채널을 만들지 않는다: [모니터] 탭이 이미 telemetry:data 틱마다 다시 그리므로 그때 함께 부른다.
  'forward:list': { req: void; res: PortForward[] }
  // W2 F8 내장 브라우저. http/https 만(app:openExternal 과 같은 isSafeExternal 게이트를 재사용 —
  // 두 번째 화이트리스트를 만들지 않는다). 창 하나를 재사용해 navigate 한다.
  'browser:open': { req: { url: string }; res: { ok: boolean } }
  // W2 F12 로그 폴더 열기. 기록 on/off·보존기간은 ui:setPrefs 로 간다(전용 설정 채널 없음).
  'sessionlog:reveal': { req: void; res: { ok: boolean } }
  // ── W3 F16 아라 (AI 어시스턴트) ──
  // 패널 마운트 시 대화 전량 인계(session:attach 와 같은 역할 — 대화의 주인은 main 이다).
  // ⚠️ 응답에 API 키는 존재하지 않는다(hasKey: boolean). **키를 반환하는 채널을 만들지 않는 것이 계약이다.**
  'ai:getState': { req: void; res: AiState }
  // 키 저장 + 검증(models.retrieve — GET 이라 토큰 과금 0). key:'' 는 삭제. 읽는 채널은 없다.
  'ai:setKey': { req: { key: string }; res: AiKeyResult }
  // 질문 전송. 응답은 즉시 turnId 만 돌려주고 본문은 ai:delta 로 흐른다.
  // context 는 렌더러가 이미 마스킹한 텍스트지만 main 이 전송 직전 한 번 더 마스킹한다(설계 §3.3 —
  // 렌더러 마스킹은 미리보기용 이중 방어이고 실제 방어선은 main 이다).
  'ai:send': { req: { text: string; context?: string; env?: AiEnv }; res: { turnId: string } }
  'ai:cancel': { req: void; res: { ok: true } }
  // 새 대화(대화 비우기). 컨텍스트 길이·비용 관리용.
  'ai:clear': { req: void; res: { ok: true } }
  // 트랙 C 소비 채널 — 타입만 선확정(핸들러는 트랙 C).
  'clipboard:readFiles': { req: void; res: { paths: string[] } }
  // RDP 원격 클립보드에서 내려받은 바이트를 사용자가 고른 폴더에 쓴다. name·sub 는 원격이 준
  // 문자열이라 main 이 조각마다 검사한다(폴더 밖 쓰기 차단).
  'fs:saveBytes': { req: { dir: string; sub?: string; name: string; bytes: Uint8Array }; res: FileOpResult }
  'history:load': { req: { scope: string }; res: { entries: string[] } }
  'history:append': { req: { scope: string; command: string }; res: { ok: true } }
  // ── W4 F23 MCP 조종 모드 (설계 §6) ──
  'mcp:getState': { req: void; res: McpState }
  'mcp:setEnabled': { req: { enabled: boolean }; res: { ok: true; port?: number } }
  // 새 토큰 발급(+구 토큰 즉시 무효). 반환된 token 은 이 응답에만 존재 — 재조회 채널 없음(ai:getKey 부재와 같은 계약).
  'mcp:issueToken': { req: void; res: { token: string } }
  'mcp:disconnectClient': { req: void; res: { ok: true } }
  'mcp:setSessionMode': { req: { sessionId: string; mode: McpSessionMode; minutes?: number }; res: { ok: true } }
  // 인계/중단(설계 §2.4). kill=true 면 서버까지 끄고 클라이언트 연결을 끊는다.
  'mcp:handback': { req: { kill: boolean }; res: { ok: true } }
  // D2: 인계 해제 — session_create/ssh_connect 즉시거부를 푼다. 사용자가 UI에서 명시적으로만 호출.
  'mcp:resumeControl': { req: void; res: { ok: true } }
  'mcp:approvalRespond': { req: McpApprovalDecision; res: { ok: true } }
  // ── F24 앱 내 피드백 수집 ──
  // 항목 저장(캡처 데이터 포함 — attachCapture=true면 main이 이 호출 시점에 창을 캡처한다).
  // 읽기 채널은 없다: 앱이 목록을 보여주지 않으므로(파일을 열면 되는 것이 목적) 불필요하다.
  // F12 로그 폴더 열기와 같은 shell.openPath 패턴.
}

export type InvokeChannel = keyof InvokeContract
export type InvokeReq<C extends InvokeChannel> = InvokeContract[C]['req']
export type InvokeRes<C extends InvokeChannel> = InvokeContract[C]['res']

// renderer → main 단방향 send (고빈도 키 입력은 invoke 왕복 대신 send, 계획서 §B.2).
export type SendContract = {
  'session:input': { id: string; data: string }
  // xterm write 백로그 임계치 초과 시 pty read 일시정지/재개 (백프레셔 메커니즘 2).
  'session:pause': { id: string }
  'session:resume': { id: string }
}
export type SendChannel = keyof SendContract

// main → renderer 이벤트. session:data는 Uint8Array transferable (백프레셔 메커니즘 3).
export type SessionExit = { id: string; exitCode: number; signal?: number }
// F7: OSC7 로 감지한 cwd 변경(session:cwd:{id}) → SFTP 트리 자동 이동.
export type SessionCwd = { id: string; cwd: string }
// W1 F9/F10: 폴링 한 바퀴의 결과(telemetry:data:{sessionId}). stats 는 파싱 실패 시 null —
// 포트만 읽히는 서버에서도 목록은 나와야 하므로 한쪽 실패가 다른 쪽을 지우지 않는다.
export type TelemetryData = { sessionId: string; ports: RemotePort[]; stats: RemoteStats | null }
// W1 F13: tail 스트림 청크·종료(logtail:data:{id} / logtail:exit:{id}). error 는 원격이 죽은 사유.
export type LogTailData = { id: string; chunk: string }
export type LogTailExit = { id: string; error?: string }
// W3 F16: 스트리밍 텍스트 조각(ai:delta). 대화가 하나뿐이고 진행 중 턴도 하나뿐이라 채널명에 id 를
// 붙이지 않는다(session:data:{id} 와 달리 구독자를 나눌 이유가 없다). 종료는 ai:end 로 AiEnd 가 온다.
export type AiDelta = { turnId: string; text: string }
// F26: watch 한 명령의 한 바퀴 결과(remote:data). 파싱은 렌더러가 shared/remoteCatalog.ts 의 파서로
// 한다(main 은 명령을 고르고 출력을 나르기만 한다). 콘솔 창이 하나뿐이라 채널을 대상별로 쪼개지 않고
// 페이로드에 sessionId·cmdId 를 싣는다 — ai:delta 와 같은 규칙(구독자를 나눌 이유가 없다).
export type RemoteData = {
  sessionId: string
  cmdId: CmdId
  out: string
  /** 원격 종료코드. 파싱 결과가 비었는데 이 값이 0 이 아니면 out 이 곧 오류 메시지다(#68). */
  code?: number
  /** 한 바퀴가 아예 실패했을 때의 사유(exec·timeout·noSession·badArgs). 이때 out 은 빈 문자열이다. */
  err?: RunFailReason
}

// MS-1: SSH 대량 붙여넣기 유실 방지용 write ack 이벤트 계약(옵션 준비 — 현재 소비자 없음).
// ssh2 stream.write 콜백이 오면 session:inputAck:{id}로 푸시할 수 있도록 타입만 확정한다.
export type SessionInputAck = { id: string; bytes: number }

// preload가 노출하는 좁은 도메인 API. renderer는 window.ev만 호출한다.
export type EvApi = {
  workspace: {
    load(): Promise<WorkspaceSnapshot>
    save(state: WorkspaceSaveInput): Promise<{ ok: true }>
  }
  ui: {
    setPrefs(prefs: UiPrefs): Promise<{ ok: true }>
    setGroups(groups: string[]): Promise<{ ok: true }>
    setWorkProfiles(list: WorkProfile[]): Promise<{ ok: true }>
    setAiCliRecent(list: AiCliRecent[]): Promise<{ ok: true }>
    setFont(font: FontConfig): Promise<{ ok: true }>
    setSidebar(sidebar: SidebarState): Promise<{ ok: true }>
  }
  app: {
    getVersion(): Promise<string>
    // R3.3: 기본 브라우저로 URL 열기(http/https 만). 차단되면 ok:false.
    openExternal(url: string): Promise<{ ok: boolean }>
    /** #90: 이 PC 기본 셸의 조립 규칙(`&&` 가 되는지). AI CLI 시작이 미리보기·전송에 함께 쓴다. */
    launchShell(): Promise<LaunchShell>
    /** #90: 그 실행 파일이 이 PC 에 있는가(where/which). 원격의 cliInstalled 에 대응한다. */
    hasCli(bin: string): Promise<boolean>
    /** 지금 쓰이는 기록 폴더 두 곳 + 기본 자리(설정 화면이 보여 준다). */
    logPaths(): Promise<{ sessionLogDir: string; appLogDir: string; defaultDir: string }>
  }
  window: {
    minimize(): Promise<{ ok: true }>
    toggleMaximize(): Promise<{ maximized: boolean }>
    close(): Promise<{ ok: true }>
    /**
     * F32: 세션을 별도 창으로 떼어낸다. 세션은 main 에 살아 있어 죽지 않고 소유 창만 바뀐다.
     * at 은 탭을 놓은 화면 좌표 — 주면 그 자리에 창이 뜬다(탭 드래그로 떼어낼 때).
     */
    detachSession(sessionId: string, at?: { x: number; y: number }): Promise<{ ok: boolean; winId?: string }>
    /**
     * 세션을 그 창으로 옮긴다(winId 없으면 본창). 크롬식 탭 병합·되돌리기가 같은 창구를 쓴다.
     * 떼어낸 창이 닫힐 때 남은 세션을 본창으로 되돌리는 일은 main 이 알아서 한다.
     */
    moveSession(sessionId: string, winId?: string): Promise<{ ok: boolean }>
    /** 떼어낸 창의 닫기를 main 이 막고 물어 온다 — 그 창만 구독한다(본창에는 오지 않는다). */
    onCloseAsk(cb: () => void): () => void
    /** 물어본 것에 답한다(kill=true 종료 / false 본창으로). 취소면 부르지 않는다. */
    confirmClose(winId: string, kill: boolean): Promise<{ ok: true }>
    /** 세션 소유 창이 바뀌었다 — 양쪽 창이 자기 탭바를 다시 그린다. */
    onSessionMoved(cb: (e: { sessionId: string; winId?: string }) => void): () => void
    /** F32 R2: 복원을 마친 본창이 소유를 다시 붙이고 저장된 창들을 연다(순서가 중요하다). */
    restoreWindows(
      assign: { sessionId: string; winId: string }[],
      windows: DetachedWindowState[]
    ): Promise<{ opened: number }>
  }
  profile: {
    list(): Promise<ConnectionProfile[]>
    save(input: ProfileInput): Promise<{ profile: ConnectionProfile }>
    delete(id: string): Promise<{ ok: true }>
  }
  ssh: {
    /** password 는 이번 접속에만 쓰이고 저장되지 않는다(비밀번호를 vault 에 두지 않는 사용자용). */
    connect(profileId: string, acceptHostKey?: boolean, password?: string): Promise<SshConnectResult>
    forgetHostKey(profileId: string): Promise<{ ok: true; removed: boolean }>
    /** [접속 테스트] — 저장하지 않고 폼 값으로 붙어 본다(ssh=인증까지, rdp=도달까지). */
    test(input: ProfileInput): Promise<ConnTestResult>
  }
  // F25: 앱 내장 RDP 는 relay 로만 연다(OS 클라이언트 외부 실행은 2026-08-09 제거 — A-40).
  rdp: {
    /** password 는 프로필에 저장해 둔 값이 있을 때만 실린다(없으면 렌더러가 입력받는다). */
    relay(profileId: string): Promise<
      | { ok: true; relayId: string; url: string; token: string; destination: string; username: string; password?: string }
      | { ok: false; message: string }
    >
    relayStop(relayId: string): Promise<{ ok: true; reason?: string }>
    /** 다중 모니터 — OS 가 보는 모니터 목록(렌더러의 window.screen 은 자기 모니터만 안다). */
    displays(): Promise<{ displays: SpanDisplay[] }>
    /** displayIds 가 비면 전체 모니터에 펼친다. */
    openSpan(profileId: string, name: string, displayIds: number[]): Promise<{ ok: true; plan: SpanPlan } | { ok: false; message: string }>
    closeSpan(profileId: string): Promise<{ ok: true }>
    spanPlan(profileId: string): Promise<{ plan: SpanPlan | null }>
    onSpanClosed(cb: (e: { profileId: string }) => void): () => void
    /** 릴레이가 실패로 끝났을 때 그 사유(TCP·TLS·프로토콜). 클라이언트 오류는 "general error" 뿐이라
     *  이 채널이 없으면 원인을 알 수 없다. */
    onRelayClosed(cb: (e: { relayId: string; reason: string }) => void): () => void
  }
  sftp: {
    list(sessionId: string, path: string): Promise<FileListResult>
    rename(sessionId: string, path: string, name: string): Promise<FileOpResult>
    mkdir(sessionId: string, dir: string, name: string): Promise<FileOpResult>
    remove(sessionId: string, opId: string, paths: string[]): Promise<FileOpResult>
    copyRemote(sessionId: string, paths: string[], destDir: string): Promise<FileOpResult>
    download(req: { sessionId: string; transferId: string; remotePath: string; localPath: string; size: number }): Promise<SftpXferResult>
    upload(req: { sessionId: string; transferId: string; localPath: string; remoteDir: string }): Promise<SftpXferResult>
    /** 서버 A → 서버 B(디스크 경유 없음). 같은 서버면 copyRemote 를 쓴다. */
    copyBetween(req: {
      srcSessionId: string
      destSessionId: string
      transferId: string
      remotePath: string
      destDir: string
      size: number
    }): Promise<SftpXferResult>
    // transferId 또는 remove 의 opId. 진행 중 전송·재귀 삭제를 멈춘다.
    cancel(transferId: string): Promise<{ ok: true }>
    // 로컬 파일 저장 위치 선택(다운로드용 save dialog). 취소 시 null.
    pickSavePath(defaultName: string): Promise<string | null>
    // 다중 다운로드용 저장 폴더 선택. 취소 시 null.
    pickSaveDir(): Promise<string | null>
    // 업로드할 로컬 파일 선택(드래그가 불가한 환경 폴백). 취소 시 null.
    pickUploadPaths(): Promise<string[]>
    // sftp:progress:{transferId} 구독. 해지 함수 반환.
    onProgress(transferId: string, cb: (p: SftpProgress) => void): () => void
  }
  // W1 F9/F10 원격 텔레메트리. 활성 SSH 세션 하나만 구독한다(세션 전환 시 stop→start).
  portwin: { open(): Promise<{ ok: true }> }
  browserTabs: {
    select(id: string): Promise<{ ok: true }>
    closeTab(id: string): Promise<{ ok: true }>
    /** 오리진으로 닫기 — 포트 표의 [닫기]. 열려 있지 않았으면 ok:false. */
    closeOrigin(origin: string): Promise<{ ok: boolean }>
    reload(): Promise<{ ok: true }>
    back(): Promise<{ ok: true }>
    /** 탭 목록 변경 — 브라우저 창의 탭 줄과 **본창**(포트 표)이 함께 받는다. */
    onTabs(cb: (e: { tabs: BrowserTabView[]; activeId: string | null }) => void): () => void
  }
  telemetry: {
    // 이미 구독 중인 세션에 다시 호출하면 즉시 한 바퀴 돈다 = [모니터] 탭 새로고침 버튼.
    start(sessionId: string): Promise<{ ok: true }>
    refresh(sessionId: string): Promise<{ ok: true }>
    stop(sessionId: string): Promise<{ ok: true }>
    // telemetry:data:{sessionId} 구독. 해지 함수 반환.
    onData(sessionId: string, cb: (d: TelemetryData) => void): () => void
  }
  // F29 시스템 모니터 [로컬] 탭. 세션 인자가 없다 — 내 PC 는 세션에 매이지 않는다.
  sys: {
    start(): Promise<{ ok: true }>
    stop(): Promise<{ ok: true }>
    onData(cb: (s: HostStats) => void): () => void
  }
  // W1 F13 로그 뷰어. start 는 실패해도 id 를 주고 사유는 onExit 으로 온다(코드 경로 하나).
  logtail: {
    history(sessionId: string, path: string, before?: number): Promise<SessionLogReadResult>
    start(sessionId: string, path: string): Promise<{ id: string }>
    stop(id: string): Promise<{ ok: true }>
    onData(id: string, cb: (d: LogTailData) => void): () => void
    onExit(id: string, cb: (d: LogTailExit) => void): () => void
  }
  // FB-monitor: 트리 우클릭 tmux 서브메뉴 — 세션 목록 1회 조회(구독 없음).
  tmux: {
    list(sessionId: string): Promise<TmuxListResult>
  }
  // F26 서버 콘솔. **명령 문자열을 받는 함수가 없다는 것이 계약이다** — cmdId 와 인자만 건넬 수 있고
  // 표(shared/remoteCatalog.ts) 밖의 명령은 존재하지 않는다.
  remote: {
    run(sessionId: string, cmdId: CmdId, args?: unknown): Promise<RunResult>
    watch(sessionId: string, cmdId: CmdId, args?: unknown): Promise<{ ok: true }>
    unwatch(sessionId: string, cmdId: CmdId): Promise<{ ok: true }>
    // remote:data 구독(창 하나뿐이라 채널도 하나 — 대상은 페이로드가 들고 온다). 해지 함수 반환.
    onData(cb: (d: RemoteData) => void): () => void
  }
  // R7 로컬 파일시스템 — sftp 와 같은 모양(sessionId 없음).
  fs: {
    list(path: string): Promise<FileListResult>
    rename(path: string, name: string): Promise<FileOpResult>
    mkdir(dir: string, name: string): Promise<FileOpResult>
    /** #88 R2: 빈 파일 만들기. 이미 있으면 실패한다(0바이트로 날리지 않는다). 로컬 전용. */
    newFile(dir: string, name: string): Promise<FileOpResult>
    /** #88 R2: 잘라내기(이동). 로컬↔로컬 전용 — 원격이 끼면 그건 전송이라 sftp:* 가 맡는다. */
    move(paths: string[], destDir: string): Promise<FileOpResult>
    /** #88 R2: 드라이브 목록(윈도우 "내 PC"). 맥은 루트 + /Volumes 마운트. */
    drives(): Promise<{ path: string; label: string }[]>
    /** 폴더 고르기(설정의 기록 폴더). 취소면 null. */
    pickDir(): Promise<string | null>
    /** #89: 로컬 삭제는 **휴지통**으로. 원격(sftp.remove)은 영구 — 서버에 휴지통이 없다. */
    trash(paths: string[]): Promise<FileOpResult>
    /** #89: 연결 프로그램으로 열기(이미지·PDF·xlsx). 로컬 전용 — 원격은 편집기/다운로드. */
    openPath(path: string): Promise<FileOpResult>
    /** #92: 탐색기에서 그 파일을 선택한 채로 폴더 열기. */
    reveal(path: string): Promise<FileOpResult>
    /** #92: 원격 파일을 받는 기본 폴더(OS 다운로드 폴더). */
    downloadsDir(): Promise<string>
    /** #92: dir 안에서 비어 있는 이름(`보고서 (2).xlsx`). 덮어쓰기를 피한다. */
    freeName(dir: string, name: string): Promise<string>
    /** #90: 중간 단계까지 만든다(mkdir -p). 원격의 ensureRemoteDir 에 대응하는 로컬 경로. */
    mkdirp(path: string): Promise<FileOpResult>
    // W4sat F20: 탐색기 패널 간 로컬↔로컬 복사(재귀).
    copy(paths: string[], destDir: string): Promise<FileOpResult>
    /** 원격에서 내려받은 바이트를 폴더에 저장(RDP 클립보드 파일 받기). */
    saveBytes(req: { dir: string; sub?: string; name: string; bytes: Uint8Array }): Promise<FileOpResult>
  }
  // 편집기 창(노트). open 은 창을 띄우고, read/write 는 그 창이 쓴다.
  editor: {
    open(sessionId: string | null, path: string): Promise<{ ok: boolean }>
    read(sessionId: string | null, path: string): Promise<EditorReadResult>
    write(sessionId: string | null, path: string, text: string, eol: 'lf' | 'crlf'): Promise<FileOpResult>
  }
  session: {
    create(spec: SessionSpec): Promise<{ id: string }>
    input(id: string, data: string): void
    resize(id: string, cols: number, rows: number): Promise<{ ok: true }>
    destroy(id: string): Promise<{ ok: true }>
    list(): Promise<Session[]>
    /** F30: 세션별 마지막 출력 시각(epoch ms) — "조용한 AI" 판정의 유일한 근거. */
    activity(): Promise<{ id: string; lastDataAt: number }[]>
    rename(id: string, title: string): Promise<{ ok: true }>
    autoTitle(id: string, title: string): Promise<{ applied: boolean }>
    // onData 구독 직후 호출 — 지금까지의 출력(backlog)을 받고 그 다음부터 라이브 이벤트가 온다.
    attach(id: string): Promise<{ backlog: Uint8Array }>
    pause(id: string): void
    resume(id: string): void
    // session:data:{id} 구독. 청크는 Uint8Array. 해지 함수 반환.
    onData(id: string, cb: (chunk: Uint8Array) => void): () => void
    onExit(id: string, cb: (info: SessionExit) => void): () => void
    // F7: 세션 cwd 변경 구독(터미널→SFTP 트리 동기). 해지 함수 반환.
    onCwd(id: string, cb: (info: SessionCwd) => void): () => void
  }
  // F14: 클립보드에 담긴 로컬 파일 경로(탐색기에서 복사한 파일). 파일이 아니면 빈 배열 —
  // 호출측은 그때 기존 텍스트 붙여넣기로 폴백한다.
  clipboard: {
    readFiles(): Promise<{ paths: string[] }>
  }
  // F11 명령어 히스토리. scope = SSH 는 serverKey, 로컬은 'local'.
  history: {
    load(scope: string): Promise<string[]>
    append(scope: string, command: string): Promise<{ ok: true }>
  }
  // W4 F23 MCP 조종 모드. **getToken 이 없다는 것이 계약이다** — issueToken 응답에만 원문이 존재.
  mcp: {
    getState(): Promise<McpState>
    setEnabled(enabled: boolean): Promise<{ ok: true; port?: number }>
    issueToken(): Promise<{ token: string }>
    disconnectClient(): Promise<{ ok: true }>
    setSessionMode(sessionId: string, mode: McpSessionMode, minutes?: number): Promise<{ ok: true }>
    handback(kill: boolean): Promise<{ ok: true }>
    resumeControl(): Promise<{ ok: true }>
    respondApproval(d: McpApprovalDecision): Promise<{ ok: true }>
    onApprovalRequest(cb: (r: McpApprovalRequest) => void): () => void
    onActivity(cb: (a: McpActivity) => void): () => void
    onStateChanged(cb: (s: McpState) => void): () => void
  }
  // W2 F8 포트 포워딩. 포트 번호 외에는 아무것도 넘길 수 없다(호스트·바인드 주소는 main 하드코딩).
  forward: {
    create(sessionId: string, remotePort: number, exactPort?: boolean): Promise<ForwardResult>
    stop(id: string): Promise<{ ok: true }>
    list(): Promise<PortForward[]>
  }
  // W2 F8 내장 브라우저(별도 창 하나 재사용). 스킴이 http/https 가 아니면 ok:false 로 거부된다.
  browser: { open(url: string): Promise<{ ok: boolean }> }
  // W2 F12 세션 로그 폴더 열기.
  sessionLog: {
    reveal(): Promise<{ ok: boolean }>
    // 로그 패널: before 를 주면 그 앞쪽 창을 읽는다(뒤에서부터 창 단위 — 긴 로그도 한 번에 안 들고 온다).
    read(sessionId: string, before?: number): Promise<SessionLogReadResult>
    /** #86: 지난 세션 기록 목록(최근 것이 앞). */
    list(): Promise<PastLog[]>
    /** #86: 그 파일의 창 단위 읽기. before 를 주면 앞쪽 창. */
    readFile(file: string, before?: number): Promise<SessionLogReadResult>
    save(sessionId: string): Promise<FileOpResult>
  }
  // W3 F16 아라. **getKey 가 없다는 것이 계약이다** — 저장한 키를 읽어 갈 창구가 표면에 존재하지 않는다.
  ai: {
    getState(): Promise<AiState>
    setKey(key: string): Promise<AiKeyResult> // '' → 삭제
    send(req: { text: string; context?: string; env?: AiEnv }): Promise<{ turnId: string }>
    cancel(): Promise<{ ok: true }>
    clear(): Promise<{ ok: true }>
    onDelta(cb: (d: AiDelta) => void): () => void
    onEnd(cb: (e: AiEnd) => void): () => void
  }
  // F24 앱 내 피드백 수집. **읽기 채널이 없다는 것이 계약이다** — 목록 화면을 만들지 않으므로
  // 저장된 항목을 렌더러로 되돌리는 창구가 표면에 존재하지 않는다(폴더 열기로 충분).
}

declare global {
  interface Window {
    ev: EvApi
  }
}
