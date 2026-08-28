// main 프로세스 진입점 — 앱 생명주기·BrowserWindow·IPC·영속화 (계획서 §B.1).
import { app, BrowserWindow, session } from 'electron'
import { join, isAbsolute } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { WorkspaceStore } from './workspace/WorkspaceStore'
import { HistoryStore } from './history/HistoryStore'
import { SafeStorageSecretStore } from './secrets/SafeStorageSecretStore'
import { ProfileStore } from './secrets/ProfileStore'
import { registerWorkspaceIpc } from './ipc/registerWorkspaceIpc'
import { registerSessionIpc } from './ipc/registerSessionIpc'
import { registerSessionWindowIpc } from './ipc/registerSessionWindowIpc'
import { registerProfileIpc } from './ipc/registerProfileIpc'
import { registerSshIpc } from './ipc/registerSshIpc'
import { registerRdpIpc, stopAllRdpRelays } from './ipc/registerRdpIpc'
import { closeAllRdpSpanWindows } from './rdp/RdpWindows'
import { closeAllSessionWindows, sessionWindowOf } from './windows/SessionWindows'
import { registerSftpIpc } from './ipc/registerSftpIpc'
import { registerFsIpc } from './ipc/registerFsIpc'
import { registerLocalCliIpc } from './ipc/registerLocalCliIpc'
import { registerEditorIpc } from './ipc/registerEditorIpc'
import { closeEditorsForSession } from './editor/EditorWindows'
import { closePortWindow, portWindowContents } from './windows/PortWindow'
import { registerSessionLogIpc } from './ipc/registerSessionLogIpc'
import { registerTelemetryIpc } from './ipc/registerTelemetryIpc'
import { registerRemoteIpc } from './ipc/registerRemoteIpc'
import { registerWindowIpc } from './ipc/registerWindowIpc'
import { registerUpdateIpc } from './ipc/registerUpdateIpc'
import { registerForwardIpc } from './ipc/registerForwardIpc'
import { registerAiIpc } from './ipc/registerAiIpc'
import { registerVoiceIpc } from './ipc/registerVoiceIpc'
import { registerMcpIpc, type McpRuntime } from './ipc/registerMcpIpc'
import type { AraToolGate } from './mcp/tools'
import { registerAraIpc, type AraRuntime } from './ipc/registerAraIpc'
import { clearStaleSelfToken } from './ai/engine/araMcp'
import { createSessionLog, type SessionLogService } from './log/SessionLog'
import { setApiPersona } from './ai/prompt'
import { setMainErrorLogDir } from './log/MainErrorLog'
import { pushSend } from './util/windowPush'
import { logMainError } from './log/MainErrorLog'
import { aiModelsOf, aiProviderOf, isBottomId, DEFAULT_LOG_RETENTION_DAYS, DEFAULT_SESSION_LOG } from '@shared/types'
import type { MainSessionManager } from './sessions/MainSessionManager'
import { drainKilledPtys } from './sessions/PtyBackend'
import type { ForwardService } from './forward/PortForward'
import type { RemoteConsoleService } from './remote/RemoteConsoleService'
import { aiKeyVaultId, type AiPrefs, type AraSession } from './ai/AraSession'
import { buildPersona, callNameOf } from '@shared/araPersona'

/**
 * 모델이 준 인자(JSON 문자열)를 게이트에 넘기고 답을 글로 되돌린다(2026-08-26).
 *
 * **JSON 이 깨져 있을 수 있다** — 스트림으로 조각조각 오다 끊기면 그렇다. 그때 던지면 대화가
 * 통째로 죽으니, 모델이 고쳐서 다시 부를 수 있게 사람 말로 알려 준다.
 */
async function runGate(gate: AraToolGate, name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    return '인자를 읽지 못했습니다(JSON 이 깨졌습니다). 다시 불러 주세요.'
  }
  if (name === 'ara_tools') return gate.tools(typeof args.group === 'string' ? args.group : undefined)
  if (name === 'ara_call') {
    const res = await gate.call(String(args.tool ?? ''), (args.args as Record<string, unknown>) ?? {})
    return res.content.map((c) => c.text).join('\n')
  }
  return `"${name}" 이라는 도구가 없습니다. ara_tools 로 목록을 보세요.`
}

let store: WorkspaceStore
let history: HistoryStore
let sessions: MainSessionManager
// W1: 폴링·tail 정리 훅(종료 시 원격에 프로세스를 남기지 않는다).
let telemetry: { stopAll: () => void } | null = null
// F26 서버 콘솔: 프로세스 표 등 주기 실행 구독. 텔레메트리와 같은 정리 훅.
// 타입을 서비스로 둔다 — MCP(server_run)가 같은 인스턴스를 쓴다.
let remoteConsole: RemoteConsoleService | null = null
// W2 F8: 활성 포워딩. 세션 종료·앱 종료 때 리스너와 소켓을 접는다.
let forwards: ForwardService | null = null
// W2 F12: 세션 로그 tee. 기본 off — 설정에서 켜야 파일이 생긴다.
let sessionLog: SessionLogService | null = null
// W3 F16: 아라 대화. main 이 소유하므로 패널을 닫아도 살아 있고, 종료 시 진행 중 스트림을 끊는다.
let ara: AraSession | null = null
// W4 F23: MCP 서버 + 승인 매니저. **기본 켜짐**(2026-08-26) — 아라가 우리 도구를 쓰는 길이
// 이것뿐이라 꺼진 채로 시작하면 아라가 반쪽이 된다. 설정 [MCP]에서 끌 수는 있다(확인을 받는다).
let mcp: McpRuntime | null = null
let araChat: AraRuntime | null = null
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // F6: 저장된 창 크기·위치로 복원. 없으면 기본 크기(최초 실행).
  const bounds = store?.get().ui.window
  const win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    show: false,
    frame: false,
    backgroundColor: '#0d1119',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 보안 기본값 불변식 (계획서 §A.1 / §B.1)
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // F6: 창 크기·위치 변경을 스냅샷에 반영(주기 flush 경로 재사용 — 별도 저장 경로 없음).
  // 최대화 중 bounds 를 저장하면 다음 기동이 "최대화 크기의 일반 창"으로 뜨므로 건너뛴다(R2.6).
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    store?.setWindowBounds(win.getBounds())
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

  // e2e 는 창을 300번 띄운다 — 그때마다 show() 가 사용자가 타이핑하던 창에서 포커스를 빼앗는다.
  // 숨기지는 않는다(숨은 창은 Chromium 이 rAF 를 늦춰 xterm 렌더가 틀어진다) — 포커스만 안 뺏는다.
  win.once('ready-to-show', () => (process.env['ARA_E2E'] === '1' ? win.showInactive() : win.show()))

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  store = new WorkspaceStore(join(userData, 'workspace.json'), app.getVersion())
  history = new HistoryStore(join(userData, 'history.json'))
  const secrets = new SafeStorageSecretStore(join(userData, 'secrets.vault'))
  const profiles = new ProfileStore(store, secrets)

  // 현재 창의 webContents 접근자(세션·SFTP·AI·MCP 이벤트 공용). 반환값이 이미 destroyed 일 수도
  // 있다(창 close()~'closed' 구간) — 실제 파괴 가드는 util/windowPush.ts 하나로 모았다(FIX-destroyed).
  const mainWc = () => {
    try {
      return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
    } catch {
      return null
    }
  }

  /**
   * F32: **세션 출력은 그 세션을 가진 창으로 간다.**
   *
   * 인자를 안 주면 지금까지대로 본창이다 — 아라·MCP·RDP 처럼 창을 떼어낼 수 없는 것들이 그렇다.
   * sessionId 를 주면 소유 창(Session.winId)을 찾아 그쪽으로 보낸다. 소유 창이 이미 닫혔으면
   * 본창으로 떨어진다 — 창이 사라지는 순간에 도착한 출력을 버리지 않으려는 폴백이다
   * (세션은 창보다 오래 산다. 그게 이 기능이 성립하는 이유이기도 하다).
   */
  const getWebContents = (sessionId?: string) => {
    if (sessionId) {
      const winId = sessions?.winIdOf(sessionId)
      if (winId) {
        const w = sessionWindowOf(winId)
        if (w) {
          try {
            return w.webContents
          } catch {
            return mainWc()
          }
        }
      }
    }
    return mainWc()
  }

  const logDir = join(userData, 'logs')
  /**
   * 2026-08-23 준영님 요청 — 기록 폴더를 설정에서 고른다. 빈 값이면 기본 자리.
   * **절대경로만 받는다**: 렌더러가 보낸 값이라 신뢰 경계 밖이고, 상대경로는 main 의 cwd(설치
   * 폴더)를 기준으로 풀려 엉뚱한 데 쓰게 된다.
   */
  const dirPref = (v: string | undefined): string => (v && isAbsolute(v) ? v : logDir)
  const savedDirs = store.get().ui
  const sessionDir = dirPref(savedDirs.sessionLogDir)
  setMainErrorLogDir(dirPref(savedDirs.appLogDir))
  // ui:setPrefs 가 도착하면 로거에 즉시 반영한다(전용 설정 채널을 만들지 않는다).
  registerWorkspaceIpc(store, history, (prefs) => {
    sessionLog?.setPrefs(prefs.sessionLog, prefs.logRetentionDays)
    sessionLog?.setDir(dirPref(prefs.sessionLogDir))
    setMainErrorLogDir(dirPref(prefs.appLogDir))
  })
  // F8/F23: 세션이 끝나면 그 세션의 포워딩도 접는다. 사람이 타이핑하면(session:input) MCP 승인
  // 매니저가 그 세션의 autoAllow 를 해제한다(설계 §3.3). forwards·mcp 는 아래에서 대입되지만 화살표가
  // 변수를 캡처하므로 실행 시점엔 채워져 있다(늦은 바인딩 — forwards 와 같은 최소 diff 경로).
  sessions = registerSessionIpc(
    getWebContents,
    (id) => {
      forwards?.stopSession(id)
      mcp?.approval.forget(id) // S3: 세션 종료 시 승인 매니저의 유령 항목도 같이 지운다(GAP #6).
      // 커넥션이 없으면 저장할 길이 없다 — 그 세션으로 연 편집기 창도 함께 닫는다.
      closeEditorsForSession(id)
    },
    (id) => mcp?.approval.onHumanInput(id)
  )
  // F32: 탭을 별도 창으로 떼어내기 / 본창으로 되돌리기(세션은 main 에 있어 죽지 않는다).
  registerSessionWindowIpc(sessions, () => mainWindow)
  registerProfileIpc(profiles)
  registerSshIpc(profiles, store, sessions)
  registerRdpIpc(profiles, getWebContents)
  const sftpService = registerSftpIpc(sessions, getWebContents)
  registerFsIpc()
  registerLocalCliIpc()
  // #98 자동 업데이트 — 본창으로만 알린다(떼어낸 창에 같은 배너를 두 번 띄울 이유가 없다).
  registerUpdateIpc(mainWc)
  registerEditorIpc(sftpService, sessions, () => mainWindow)
  // 포트 모니터 독립 창은 세션을 **소유하지 않는다** — 그래서 getWebContents 로는 안 잡힌다.
  // 포트 목록은 읽기 화면이라 소유 창과 **함께** 받으면 된다(채널명이 이미 세션별로 갈려 있다).
  telemetry = registerTelemetryIpc(sessions, getWebContents, sftpService, () => {
    const wc = portWindowContents()
    return wc ? [wc] : []
  })
  // F26: 서버 콘솔의 원격 exec. 명령은 shared/remoteCatalog.ts 의 표에 있는 것만 — 렌더러가 문자열을
  // 넘길 수 있는 경로는 계약에 존재하지 않는다.
  const remoteSvc = registerRemoteIpc(sessions, getWebContents, profiles)
  remoteConsole = remoteSvc
  // 브라우저 서비스도 받아 둔다 — MCP 가 아라 브라우저에 닿는 유일한 길이다(2026-08-26).
  const fwdIpc = registerForwardIpc(sessions, () => mainWindow, () => sessionLog?.dir ?? sessionDir)
  forwards = fwdIpc.forwards
  // F12: 저장된 설정으로 로거를 만들고 기동 시 1회 보존 스윕(우리 이름 패턴의 .log 만 지운다).
  const savedUi = store.get().ui
  sessionLog = createSessionLog(
    sessionDir,
    savedUi.sessionLog ?? DEFAULT_SESSION_LOG,
    savedUi.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS
  )
  sessionLog.sweep()
  sessions.setLog(sessionLog)
  // 로그 패널: 기록 파일이 있으면 그걸, 없으면 링버퍼를 읽어 준다(늦은 바인딩 — 로거가 방금 생겼다).
  registerSessionLogIpc(sessions, () => sessionLog)
  // W5: F16 시절 단일 키(`ai.apiKey`)를 프로바이더별 분리 저장(`ai.apiKey.<provider>`)으로 옮긴 뒤 —
  // 1회성, 이미 옮겨졌으면 조건이 거짓이라 매 기동마다 비용이 없다. 사용자가 다시 키를 입력하지 않게 한다.
  const LEGACY_AI_KEY_VAULT = 'ai.apiKey'
  if (secrets.has(LEGACY_AI_KEY_VAULT) && !secrets.has(aiKeyVaultId('anthropic'))) {
    const legacy = secrets.get(LEGACY_AI_KEY_VAULT)
    if (legacy) secrets.set(aiKeyVaultId('anthropic'), legacy)
    secrets.delete(LEGACY_AI_KEY_VAULT)
  }
  // F16: 키는 기존 vault(secrets.vault)에, 모델·프로바이더는 기존 ui prefs 에 얹는다 — 새 저장소를
  // 만들지 않는다. 값은 렌더러가 ui:setPrefs 로 보낸 것이라 신뢰 경계 밖이다: aiProviderOf/aiModelsOf 로
  // 목록 안으로 클램프한다(모델명 자체는 자유 입력이라 목록 클램프 대상이 아니다 — sanitizeModelName 만 거친다).
  // #126: 이 클로저를 아라 대화(B 엔진 폴백)도 쓴다 — 두 벌로 갈리면 설정 한 곳을 고쳐도
  // 한쪽만 바뀐다.
  const aiPrefs = (): AiPrefs => {
    const ui = store.get().ui
    const provider = aiProviderOf(ui.aiProvider)
    const model = aiModelsOf(ui.aiModels)[provider]
    return { provider, model, ...(ui.aiCompatibleBaseUrl ? { baseUrl: ui.aiCompatibleBaseUrl } : {}) }
  }
  /**
   * B 엔진(API 키)도 **같은 말투 글**을 쓴다(2026-08-26). 도구가 없다는 것만 다르다 —
   * 그전에는 F16 시절 글을 따로 써서 호칭도 서버 표도 안 갔다(제보: API 가 kvt 를 몰랐다).
   */
  setApiPersona(() =>
    buildPersona(
      callNameOf(store.get().ui.araCallName),
      profiles.list().filter((p) => p.type === 'ssh').map((p) => ({ id: p.id, name: p.name })),
      // 도구를 쥐고 있으면 CLI 와 같은 말투 글을 쓴다(2026-08-26 — API 도 도구가 생겼다).
      mcp?.gate !== undefined
    )
  )
  ara = registerAiIpc(secrets, aiPrefs, getWebContents)
  // 2026-08-27 음성 모드 — 받아쓰기·읽어 주기. 같은 vault 를 쓰지만 **키는 여기서도 안 나간다**.
  registerVoiceIpc({ vault: secrets, getCompatibleBaseUrl: () => aiPrefs().baseUrl ?? '' })
  // 마이크 권한 — Electron 은 기본으로 **거절**한다(브라우저와 달리 물어보지도 않는다).
  // 우리가 여는 것은 음성 모드 하나뿐이라 media 만 열고 나머지는 그대로 막는다.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  // F23: MCP 조종 모드. 다운로드/업로드는 고정 디렉토리 안으로만(AI가 저장 경로를 정할 수 없다 —
  // 설계 §7 오케 확정 7). 감사 로그 보존은 F12 와 같은 설정값을 공유한다(별도 정책 없음, 설계 §4.1).
  mcp = registerMcpIpc(
    {
      sessions,
      profiles,
      ws: store,
      forwards,
      sftp: sftpService,
      // 아라 브라우저. 화면의 [포트]→[열기]가 쓰는 그 서비스를 그대로 넘긴다(같은 창·같은 탭 줄).
      browser: fwdIpc.browser,
      // F26 서버 콘솔·기록·히스토리 — 화면만 쓰던 것을 아라에게도 연다(2026-08-26 전수 감사).
      remote: remoteSvc,
      sessionLog: () => sessionLog,
      history,
      // 아라가 "이거 보세요" 하고 화면 아래 패널을 연다. 유효한 이름일 때만 보낸다 —
      // 아무 문자열이나 렌더러로 흘리면 화면이 없는 탭을 열려다 조용히 아무 일도 안 한다.
      showPanel: (panel: string) => {
        if (!isBottomId(panel as never)) return false
        pushSend(mainWc(), 'ui:panel', { panel })
        return true
      },
      downloadsDir: join(userData, 'mcp-downloads'),
      uploadsDir: join(userData, 'mcp-uploads')
    },
    secrets,
    logDir,
    () => store.get().ui.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    getWebContents,
    // e2e 는 앱을 여러 개 동시에 띄운다 — 기본 켜짐이 된 뒤로 고정 포트를 두고 싸운다.
    process.env['ARA_E2E'] === '1' ? 0 : undefined
  )
  /**
   * MCP 는 **기본으로 켠다**(2026-08-26 준영님 지시). 아라가 우리 도구를 쓰는 길이 이것뿐이라,
   * 꺼진 채로 시작하면 사용자가 아무것도 안 건드렸는데 아라가 반쪽이 된다.
   *
   * 명시적으로 끈 것(false)만 존중한다 — 실패해도 앱은 그대로 뜬다(포트를 못 잡는 상황에서
   * 부팅을 막을 이유가 없다. 화면의 [MCP] 섹션이 꺼짐으로 보이고 다시 켤 수 있다).
   */
  // AUDIT-R1 배선(2026-08-28): 지난 실행이 남긴 아라 MCP 토큰을 무효로 만든다. 정상 종료 때는 이미
  // 지워지지만 **크래시 뒤에는 원문 토큰이 든 임시 파일이 남는다.** 이번 실행의 토큰은 대화를 열 때
  // 새로 발급되므로 여기서 지워도 잃는 기능이 없다 — araChat 이 열리기 전이기만 하면 된다.
  clearStaleSelfToken(secrets)
  if (store.get().ui.mcpEnabled !== false) {
    void mcp.server.setEnabled(true).catch((e: unknown) => logMainError('mcp autostart', e))
  }
  // #125 아라 대화 — 엔진(로컬 Claude Code 상주)·MCP 물리기·되묻기의 화면 쪽 통로.
  // 작업 폴더는 **지금 보고 있는 세션**을 따라간다(설계 §3.3): 로컬 셸이면 그 폴더, 원격만
  // 보고 있으면 마지막 로컬 폴더, 그것도 없으면 화면이 사용자에게 묻는다.
  araChat = registerAraIpc(
    {
      server: mcp.server,
      vault: secrets,
      // 활성 세션은 화면이 open() 에 실어 보낸다(main 원장에는 "어느 탭을 보고 있나"가 없다).
      activeSession: () => null,
      lastLocalCwd: () => sessions.snapshot().find((x) => x.type === 'local' && x.cwd)?.cwd ?? null,
      // 아무것도 못 고를 때 가는 자리 — **묻지 않기 위해** 있다(2026-08-25 준영님 결정).
      // 홈 디렉터리를 쓰지 않는다: 그 폴더를 프로젝트로 여긴 검색 도구가 집 전체를 훑는다.
      araCwd: () => {
        const dir = join(userData, 'ara-home')
        mkdirSync(dir, { recursive: true })
        return dir
      },
      // claude 가 없는 PC 의 폴백(설계 §5). F16 과 **같은 키·같은 설정**을 쓴다.
      api: { vault: secrets, getPrefs: aiPrefs },
      // API 엔진 대화 기록. CLI 는 Claude Code 가 ~/.claude/projects 에 남기지만 이쪽은 우리 몫이다.
      /**
       * B 엔진 도구(2026-08-26). MCP 서버가 꺼져 있어도 **게이트는 산다** — 게이트는 우리 안의
       * 표이지 HTTP 리스너가 아니다. 사용자가 MCP 를 끈 것은 "밖에서 붙지 마라" 지
       * "아라가 아무것도 하지 마라" 가 아니다.
       */
      apiTools: () => {
        const gate = mcp?.gate
        if (!gate) return null
        return { specs: gate.doors, run: async (name, argsJson) => runGate(gate, name, argsJson) }
      },
      apiChatDir: () => {
        const dir = join(userData, 'ara-chats')
        mkdirSync(dir, { recursive: true })
        return dir
      },
      // #138 호칭. 저장값은 신뢰 경계 밖이라 callNameOf 로 자른다(줄바꿈·지시문 흉내 금지).
      callName: () => callNameOf(store.get().ui.araCallName),
      // 2026-08-26: 등록된 SSH 서버를 **id 와 이름만** 넘긴다. 호스트·사용자·비밀은 안 나간다 —
      // 접속은 id 로 하므로 그 둘이면 충분하고, 모르면 아라가 설정 파일을 뒤진다(실제로 그랬다).
      servers: () => profiles.list().filter((p) => p.type === 'ssh').map((p) => ({ id: p.id, name: p.name }))
    },
    getWebContents,
    store
  )
  registerWindowIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 종료 훅 이중화: 마지막 스냅샷 동기 flush (계획서 §B.3 저장 분리) + 전체 pty 정리(좀비 금지).
// pty 를 죽인 직후 프로세스를 끝내면 node-pty 의 네이티브 exit 스레드가 사라지는 V8 환경을 만져
// 즉사한다(PtyBackend.drainKilledPtys 주석의 실측). 그래서 종료를 딱 한 번 미루고, 배수한 뒤 다시
// 요청한다 — 두 번째 진입에서는 정리를 반복하지 않고 그대로 통과시킨다.
let ptyExitsDrained = false

// #64 종료 추적. `ARA_EXIT_TRACE=<파일>` 이 있을 때만 단계를 남긴다 — 평소에는 아무 일도 안 한다.
// 앱이 안 내려가는 일이 e2e 에서 간헐로 나는데(7회 중 3회), **어디까지 갔다가 멈추는지**를 알아야
// 고칠 수 있다. appendFileSync 라 죽기 직전까지 쓴 것은 반드시 남는다(비동기 로거는 그걸 못 한다).
const exitTrace = (stage: string): void => {
  const file = process.env['ARA_EXIT_TRACE']
  if (!file) return
  try {
    appendFileSync(file, `${Date.now()} ${stage}
`)
  } catch {
    /* 추적을 못 남겨도 종료는 계속한다 */
  }
}

/**
 * 정리 한 걸음. **던져도 다음 걸음으로 넘어간다** (AUDIT-R2 ①, 2026-08-28).
 *
 * 예전에는 스무 줄이 맨몸으로 늘어서 있었다. 그 첫 줄 `store.flush()` 는 `writeFileSync` +
 * `renameSync` ×2(util/atomicJson.ts)라 **try/catch 가 하나도 없다** — 준영님 PC 의 오피스키퍼가
 * 갓 쓴 파일을 잡으면 `EBUSY` 로 던진다(scripts/stage-release.mjs 가 같은 현상을 이미 적어 뒀다).
 * 디스크 가득·userData 쓰기 불가도 같은 결과다. 한 번 던지면 아래 정리가 **통째로** 건너뛰어져
 * conpty·ssh·claude 가 고아로 남고 39217 이 물린 채 창만 사라졌다(`uncaughtException` 이 조용히
 * 삼켜서 아무도 못 봤다).
 *
 * 걸음마다 감싸는 이유: 한 덩어리로 감싸면 중간에서 던졌을 때 그 **뒤쪽**(MCP 리스너·RDP 릴레이)이
 * 여전히 통째로 날아간다. 정리 항목들은 서로 의존하지 않으므로 하나가 실패해도 나머지는 해야 한다.
 */
const quitStep = (name: string, fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    logMainError(`before-quit ${name}`, err)
  }
}

app.on('before-quit', (e) => {
  exitTrace(ptyExitsDrained ? 'before-quit(2nd)' : 'before-quit(1st)')
  if (ptyExitsDrained) return
  // **정리보다 먼저 종료를 미룬다.** 예전엔 이 줄이 맨 끝이었다 — 그래서 정리 도중 무엇이든 던지면
  // 여기 닿지 못하고 앱이 그 자리에서 죽었다(위 quitStep 주석). 미루기를 앞세우고 정리를 전부
  // 감쌌으므로, 무슨 일이 나도 아래 finish() 예약까지는 반드시 내려온다.
  e.preventDefault()
  // 플러시 둘은 서로 남남이다 — workspace 저장이 실패해도 명령 기록은 저장돼야 한다.
  quitStep('workspace flush', () => store?.flush())
  quitStep('history flush', () => history?.flush())
  quitStep('telemetry', () => telemetry?.stopAll())
  quitStep('portWindow', () => closePortWindow())
  quitStep('remoteConsole', () => remoteConsole?.stopAll())
  quitStep('forwards', () => forwards?.stopAll())
  exitTrace('flushed')
  quitStep('sessionLog', () => sessionLog?.closeAll())
  quitStep('sessions', () => sessions?.destroyAll())
  exitTrace('sessions-destroyed')
  // F16: 진행 중 스트림 abort — 종료 후에도 살아 있는 좀비 HTTP 요청을 남기지 않는다.
  quitStep('ara', () => ara?.cancel())
  // #123 규율: claude 상주 프로세스를 반드시 내린다(고아 금지 — #64 와 같은 선).
  quitStep('araChat', () => araChat?.chat.close())
  // F23: MCP 리스너·연결 정리(설계 §5 — 외부 클라이언트가 붙은 채 앱 종료). 포트가 즉시 재사용
  // 가능해야 한다(좀비 리스너 없음).
  quitStep('mcp', () => void mcp?.server.stop())
  // F25: 내장 RDP 릴레이(loopback 리스너)도 함께 닫는다 — 좀비 리스너 금지.
  // 다중 모니터 창이 떠 있으면 먼저 없앤다: 그 창의 렌더러가 아직 살아 있으면 방금 닫은 릴레이로
  // 다시 붙으려 든다(창이 앱 창과 수명이 묶여 있지 않다 — RdpWindows.ts 주석 참고).
  quitStep('rdpSpanWindows', () => closeAllRdpSpanWindows())
  quitStep('sessionWindows', () => closeAllSessionWindows())
  quitStep('rdpRelays', () => stopAllRdpRelays())
  exitTrace('services-stopped')
  // 정리는 여기까지 전부 끝났다. 남은 건 죽인 pty 의 exit 콜백이 메인 루프에 도착하기를 기다리는 것뿐
  // (실측 14~16ms, 상한 500ms). 그 뒤 다시 quit 하면 위 early return 으로 곧장 종료된다.
  const finish = (): void => {
    exitTrace('drained')
    ptyExitsDrained = true
    app.quit()
  }
  // 성공/실패 어느 쪽이든 반드시 다시 quit 한다 — 배수가 삐끗해서 "앱이 안 꺼진다"가 되면 안 된다.
  void drainKilledPtys().then(finish, finish)
})

app.on('will-quit', () => exitTrace('will-quit'))
app.on('quit', () => exitTrace('quit'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 안전망: 종료 레이스 등 잔여 uncaught 예외가 Electron 에러 창으로 표출되지 않도록.
// 이 핸들러는 근본 수정(util/windowPush.ts 단일 가드)을 대체하지 않는다 — 그 수정이 1차 방어이고
// 이 핸들러는 예측 못 한 레이스를 위한 2차 방어. 스택은 stderr에 유지해 개발 중 버그를 숨기지 않는다.
// FIX-destroyed 실측: AraSession.run() 처럼 `void fn()`(await/catch 없는 fire-and-forget)에서 던진
// 예외는 UnhandledPromiseRejection 이 되어 이 uncaughtException 핸들러를 타지 않는다 — 그래서
// "삼키는 방식"에 의존하지 않고 push 경로 자체(windowPush.ts)를 안전하게 만드는 쪽으로 고쳤다.
// FIX-shutdown §4: stderr 로만 쓰면 실행 중인 앱에서는 아무도 못 본다 — 같은 스택을
// userData/logs/main-error.log 에도 남긴다(logMainError 가 stderr 쓰기까지 겸한다).
process.on('unhandledRejection', (err) => {
  logMainError('unhandledRejection', err)
})
// ponytail: global handler, not per-caller — upgrade to per-module if new error sources appear.
process.on('uncaughtException', (err) => {
  logMainError('uncaughtException', err)
})
