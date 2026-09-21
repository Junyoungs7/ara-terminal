// preload — 좁은 도메인 API를 contextBridge로 노출 (계획서 §B.1/§B.2).
// 채널명은 이 파일 안에만 존재; renderer는 window.ev만 본다. ipcRenderer 직접 노출 금지.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AskRequest } from '../main/mcp/askUser'
import type { AraChatEvent } from '../main/ai/AraChat'
import type {
  EvApi,
  SessionExit,
  SessionCwd,
  SftpProgress,
  TelemetryData,
  LogTailData,
  LogTailExit,
  AiDelta,
  RemoteData,
  UpdateState
} from '@shared/ipc'
import type { AgentStatus } from '@shared/agentStatus'
import type { AiCommand, LaunchShell } from '@shared/aiCli'
import type { BrowserTabView } from '@shared/browserWin'
import type { PastLog } from '@shared/ipc'
import type { CmdId } from '@shared/remoteCatalog'
import type { HostStats } from '@shared/types'
import type {
  Session,
  ProfileInput,
  UiPrefs,
  AiEnd,
  McpSessionMode,
  McpApprovalDecision,
  McpApprovalRequest,
  McpActivity,
  McpState
} from '@shared/types'
import type { SessionSpec } from '../main/sessions/ISessionManager'

const api: EvApi = {
  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (state) => ipcRenderer.invoke('workspace:save', state)
  },
  ui: {
    setPrefs: (prefs: UiPrefs) => ipcRenderer.invoke('ui:setPrefs', prefs),
    setGroups: (groups: string[], order?: string[], parents?: Record<string, string>) =>
      ipcRenderer.invoke('ui:setGroups', { groups, order, parents }),
    setWorkProfiles: (list) => ipcRenderer.invoke('ui:setWorkProfiles', { list }),
    setAiCliRecent: (list) => ipcRenderer.invoke('ui:setAiCliRecent', { list }),
    setFont: (font) => ipcRenderer.invoke('ui:setFont', font),
    setSidebar: (sidebar) => ipcRenderer.invoke('ui:setSidebar', sidebar)
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', { url }),
    // #90: 내 PC 에서 AI CLI 를 시작할 때 필요한 두 가지(셸 문법 · CLI 존재).
    launchShell: () => ipcRenderer.invoke('app:launchShell').then((r: { shell: LaunchShell }) => r.shell),
    hasCli: (bin: string) => ipcRenderer.invoke('app:hasCli', { bin }).then((r: { found: boolean }) => r.found),
    logPaths: () => ipcRenderer.invoke('app:logPaths'),
    // #190 터미널 렌더러 진단. gpuInfo 는 main 이 아는 GPU 상태고, webglOptOut 은 **값**이다 —
    // 프로브는 xterm 을 만드는 그 순간 동기로 판정해야 해서 IPC 로는 늦는다(TerminalPane 주석).
    // sandbox 프리로드에도 process.env 는 있지만, 없더라도 **부팅이 멈추지 않게** typeof 로 본다:
    // 이 파일이 던지면 창이 빈 화면으로 뜬다(사용자에게는 "앱이 안 켜진다"다).
    gpuInfo: () => ipcRenderer.invoke('app:gpuInfo'),
    webglOptOut: typeof process === 'undefined' ? undefined : process.env['ARA_NO_WEBGL'],
    // #98 자동 업데이트. 상태는 열릴 때 한 번 묻고(updateState) 그 뒤로는 push 로 받는다.
    updateState: () => ipcRenderer.invoke('update:get'),
    updateCheck: () => ipcRenderer.invoke('update:check'),
    updateDownload: () => ipcRenderer.invoke('update:download'),
    updateInstall: () => ipcRenderer.invoke('update:install'),
    onUpdateState: (cb: (s: UpdateState) => void) => {
      const listener = (_e: IpcRendererEvent, s: UpdateState): void => cb(s)
      ipcRenderer.on('update:state', listener)
      return () => ipcRenderer.removeListener('update:state', listener)
    }
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    // F32: 세션을 **별도 창으로 떼어낸다**. 세션은 main 에 살아 있으므로 죽지 않고 소유 창만 바뀐다.
    detachSession: (sessionId: string, at?: { x: number; y: number }) => ipcRenderer.invoke('win:detach', { sessionId, at }),
    /** 세션을 그 창으로 옮긴다(winId 없으면 본창) — 크롬식 탭 병합. */
    moveSession: (sessionId: string, winId?: string) => ipcRenderer.invoke('win:moveTo', { sessionId, winId }),
    /** 세션 소유 창이 바뀌었다 — 양쪽 창이 탭바를 다시 그린다. */
    restoreWindows: (assign: { sessionId: string; winId: string }[], windows: unknown[]) =>
      ipcRenderer.invoke('win:restore', { assign, windows }),
    onSessionMoved: (cb: (e: { sessionId: string; winId?: string }) => void) => {
      const listener = (_: unknown, e: { sessionId: string; winId?: string }) => cb(e)
      ipcRenderer.on('session:moved', listener)
      return () => ipcRenderer.removeListener('session:moved', listener)
    },
    /** 닫기 확인 — main 이 close 를 막고 물어 온다(떼어낸 창 · 2026-09-05 부터 본창도). */
    onCloseAsk: (cb: () => void) => {
      const listener = () => cb()
      ipcRenderer.on('win:closeAsk', listener)
      return () => ipcRenderer.removeListener('win:closeAsk', listener)
    },
    confirmClose: (winId: string, kill: boolean) => ipcRenderer.invoke('win:closeConfirm', { winId, kill })
  },
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    save: (input: ProfileInput) => ipcRenderer.invoke('profile:save', input),
    delete: (id: string) => ipcRenderer.invoke('profile:delete', { id })
  },
  ssh: {
    // aiCommand: D(#168) 셸 대신 그 AI CLI 를 프로세스로 여는 세션. 안 주면 지금까지와 같다.
    // winId: 부른 창(떼어낸 창의 재접속·복제). 안 주면 본창 — 지금까지와 같다.
    connect: (
      profileId: string,
      acceptHostKey?: boolean,
      password?: string,
      size?: { cols: number; rows: number },
      aiCommand?: { argv: AiCommand; cwd: string },
      winId?: string
    ) => ipcRenderer.invoke('ssh:connect', { profileId, acceptHostKey, password, size, aiCommand, winId }),
    forgetHostKey: (profileId: string) => ipcRenderer.invoke('ssh:forgetHostKey', { profileId }),
    test: (input: ProfileInput) => ipcRenderer.invoke('conn:test', { input })
  },
  rdp: {
    relay: (profileId: string) => ipcRenderer.invoke('rdp:relay', { profileId }),
    relayStop: (relayId: string) => ipcRenderer.invoke('rdp:relayStop', { relayId }),
    displays: () => ipcRenderer.invoke('rdp:displays', {}),
    openSpan: (profileId: string, name: string, displayIds: number[]) =>
      ipcRenderer.invoke('rdp:openSpan', { profileId, name, displayIds }),
    closeSpan: (profileId: string) => ipcRenderer.invoke('rdp:closeSpan', { profileId }),
    spanPlan: (profileId: string) => ipcRenderer.invoke('rdp:spanPlan', { profileId }),
    onSpanClosed: (cb: (e: { profileId: string }) => void) => {
      const listener = (_: unknown, e: { profileId: string }) => cb(e)
      ipcRenderer.on('rdp:spanClosed', listener)
      return () => ipcRenderer.removeListener('rdp:spanClosed', listener)
    },
    onRelayClosed: (cb: (e: { relayId: string; reason: string }) => void) => {
      const listener = (_: unknown, e: { relayId: string; reason: string }) => cb(e)
      ipcRenderer.on('rdp:relayClosed', listener)
      return () => ipcRenderer.removeListener('rdp:relayClosed', listener)
    }
  },
  fs: {
    list: (path: string) => ipcRenderer.invoke('fs:list', { path }),
    rename: (path: string, name: string) => ipcRenderer.invoke('fs:rename', { path, name }),
    mkdir: (dir: string, name: string) => ipcRenderer.invoke('fs:mkdir', { dir, name }),
    newFile: (dir: string, name: string) => ipcRenderer.invoke('fs:newFile', { dir, name }),
    move: (paths: string[], destDir: string) => ipcRenderer.invoke('fs:move', { paths, destDir }),
    drives: () =>
      ipcRenderer.invoke('fs:drives').then((r: { drives: { path: string; label: string }[] }) => r.drives),
    pickDir: () => ipcRenderer.invoke('fs:pickDir').then((r: { dir: string | null }) => r.dir),
    // #89: 로컬 삭제는 휴지통이다(원격 sftp.remove 는 영구). 이름이 그 차이를 말한다.
    trash: (paths: string[]) => ipcRenderer.invoke('fs:trash', { paths }),
    openPath: (path: string) => ipcRenderer.invoke('fs:openPath', { path }),
    reveal: (path: string) => ipcRenderer.invoke('fs:reveal', { path }),
    mkdirp: (path: string) => ipcRenderer.invoke('fs:mkdirp', { path }),
    copy: (paths: string[], destDir: string) => ipcRenderer.invoke('fs:copy', { paths, destDir }),
    downloadsDir: () => ipcRenderer.invoke('fs:downloadsDir').then((r: { dir: string }) => r.dir),
    freeName: (dir: string, name: string) =>
      ipcRenderer.invoke('fs:freeName', { dir, name }).then((r: { name: string }) => r.name),
    saveBytes: (req: { dir: string; sub?: string; name: string; bytes: Uint8Array }) =>
      ipcRenderer.invoke('fs:saveBytes', req)
  },
  editor: {
    open: (sessionId: string | null, path: string) => ipcRenderer.invoke('editor:open', { sessionId, path }),
    read: (sessionId: string | null, path: string) => ipcRenderer.invoke('editor:read', { sessionId, path }),
    write: (sessionId: string | null, path: string, text: string, eol: 'lf' | 'crlf') =>
      ipcRenderer.invoke('editor:write', { sessionId, path, text, eol })
  },
  sftp: {
    list: (sessionId: string, path: string) => ipcRenderer.invoke('sftp:list', { sessionId, path }),
    rename: (sessionId: string, path: string, name: string) =>
      ipcRenderer.invoke('sftp:rename', { sessionId, path, name }),
    mkdir: (sessionId: string, dir: string, name: string) => ipcRenderer.invoke('sftp:mkdir', { sessionId, dir, name }),
    remove: (sessionId: string, opId: string, paths: string[]) =>
      ipcRenderer.invoke('sftp:remove', { sessionId, opId, paths }),
    copyRemote: (sessionId: string, paths: string[], destDir: string) =>
      ipcRenderer.invoke('sftp:copyRemote', { sessionId, paths, destDir }),
    download: (req) => ipcRenderer.invoke('sftp:download', req),
    upload: (req) => ipcRenderer.invoke('sftp:upload', req),
    copyBetween: (req) => ipcRenderer.invoke('sftp:copyBetween', req),
    cancel: (transferId: string) => ipcRenderer.invoke('sftp:cancel', { transferId }),
    pickSavePath: (defaultName: string) =>
      ipcRenderer.invoke('sftp:pickSavePath', { defaultName }).then((r: { path: string | null }) => r.path),
    pickSaveDir: () => ipcRenderer.invoke('sftp:pickSaveDir').then((r: { path: string | null }) => r.path),
    pickUploadPaths: () =>
      ipcRenderer.invoke('sftp:pickUploadPaths').then((r: { paths: string[] }) => r.paths),
    onProgress: (transferId: string, cb: (p: SftpProgress) => void) => {
      const ch = `sftp:progress:${transferId}`
      const listener = (_e: IpcRendererEvent, p: SftpProgress) => cb(p)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    }
  },
  // 포트 모니터 독립 창 — 열기 하나뿐이다(닫기·복원은 OS 와 main 이 쥔다).
  portwin: { open: () => ipcRenderer.invoke('portwin:open', {}) },
  // 내장 브라우저 탭 줄 전용. 이 API 는 **#browserwin 창의 최상위 프레임**만 본다 —
  // 페이지 본문은 preload 없는 WebContentsView 라 여기 닿을 수 없다.
  browserTabs: {
    select: (id: string) => ipcRenderer.invoke('browser:select', { id }),
    closeTab: (id: string) => ipcRenderer.invoke('browser:closeTab', { id }),
    closeOrigin: (origin: string) => ipcRenderer.invoke('browser:closeOrigin', { origin }),
    reload: () => ipcRenderer.invoke('browser:reload', {}),
    back: () => ipcRenderer.invoke('browser:back', {}),
    onTabs: (cb: (e: { tabs: BrowserTabView[]; activeId: string | null }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { tabs: BrowserTabView[]; activeId: string | null }) => cb(d)
      ipcRenderer.on('browser:tabs', listener)
      return () => ipcRenderer.removeListener('browser:tabs', listener)
    }
  },
  telemetry: {
    start: (sessionId: string) => ipcRenderer.invoke('telemetry:start', { sessionId }),
    stop: (sessionId: string) => ipcRenderer.invoke('telemetry:stop', { sessionId }),
    refresh: (sessionId: string) => ipcRenderer.invoke('telemetry:refresh', { sessionId }),
    onData: (sessionId: string, cb: (d: TelemetryData) => void) => {
      const ch = `telemetry:data:${sessionId}`
      const listener = (_e: IpcRendererEvent, d: TelemetryData) => cb(d)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    }
  },
  // F29 시스템 모니터 [로컬] 탭 — 세션 인자가 없다(내 PC 는 세션에 매이지 않는다).
  sys: {
    start: () => ipcRenderer.invoke('sys:start'),
    stop: () => ipcRenderer.invoke('sys:stop'),
    onData: (cb: (s: HostStats) => void) => {
      const listener = (_e: IpcRendererEvent, s: HostStats) => cb(s)
      ipcRenderer.on('sys:data', listener)
      return () => ipcRenderer.removeListener('sys:data', listener)
    }
  },
  logtail: {
    start: (sessionId: string, path: string) => ipcRenderer.invoke('logtail:start', { sessionId, path }),
    stop: (id: string) => ipcRenderer.invoke('logtail:stop', { id }),
    history: (sessionId: string, path: string, before?: number) =>
      ipcRenderer.invoke('logtail:history', { sessionId, path, before }),
    onData: (id: string, cb: (d: LogTailData) => void) => {
      const ch = `logtail:data:${id}`
      const listener = (_e: IpcRendererEvent, d: LogTailData) => cb(d)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    onExit: (id: string, cb: (d: LogTailExit) => void) => {
      const ch = `logtail:exit:${id}`
      const listener = (_e: IpcRendererEvent, d: LogTailExit) => cb(d)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    }
  },
  // FB-monitor: 트리 우클릭 tmux 서브메뉴 — 1회 조회.
  tmux: {
    list: (sessionId: string) => ipcRenderer.invoke('tmux:listSessions', { sessionId })
  },
  // F26 서버 콘솔. 여기에 "명령을 실행한다"가 **없다** — cmdId 와 인자를 건네는 창구뿐이고,
  // 문자열 조립은 main 의 카탈로그가 한다. 채널명이 이 파일 안에만 있으므로 렌더러가
  // ipcRenderer 로 'remote:*' 를 직접 부를 수도 없다.
  remote: {
    run: (sessionId: string, cmdId: CmdId, args?: unknown) =>
      ipcRenderer.invoke('remote:run', { sessionId, cmdId, args }),
    watch: (sessionId: string, cmdId: CmdId, args?: unknown) =>
      ipcRenderer.invoke('remote:watch', { sessionId, cmdId, args }),
    unwatch: (sessionId: string, cmdId: CmdId) => ipcRenderer.invoke('remote:unwatch', { sessionId, cmdId }),
    onData: (cb: (d: RemoteData) => void) => {
      const listener = (_e: IpcRendererEvent, d: RemoteData) => cb(d)
      ipcRenderer.on('remote:data', listener)
      return () => ipcRenderer.removeListener('remote:data', listener)
    }
  },
  session: {
    create: (spec: SessionSpec) => ipcRenderer.invoke('session:create', spec),
    input: (id: string, data: string) => ipcRenderer.send('session:input', { id, data }),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('session:resize', { id, cols, rows }),
    destroy: (id: string) => ipcRenderer.invoke('session:destroy', { id }),
    list: (): Promise<Session[]> => ipcRenderer.invoke('session:list'),
    rename: (id: string, title: string) => ipcRenderer.invoke('session:rename', { id, title }),
    autoTitle: (id: string, title: string) => ipcRenderer.invoke('session:autoTitle', { id, title }),
    attach: (id: string) => ipcRenderer.invoke('session:attach', { id }),
    pause: (id: string) => ipcRenderer.send('session:pause', { id }),
    resume: (id: string) => ipcRenderer.send('session:resume', { id }),
    onData: (id: string, cb: (chunk: Uint8Array) => void) => {
      // postMessage(channel, msg) → (event, message)로 도착. message가 Uint8Array.
      const ch = `session:data:${id}`
      const listener = (_e: IpcRendererEvent, chunk: Uint8Array) => cb(chunk)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    onExit: (id: string, cb: (info: SessionExit) => void) => {
      const ch = `session:exit:${id}`
      const listener = (_e: IpcRendererEvent, info: SessionExit) => cb(info)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    onCwd: (id: string, cb: (info: SessionCwd) => void) => {
      const ch = `session:cwd:${id}`
      const listener = (_e: IpcRendererEvent, info: SessionCwd) => cb(info)
      ipcRenderer.on(ch, listener)
      return () => ipcRenderer.removeListener(ch, listener)
    },
    // 세션 생성 알림 — id 별 채널이 아니다(아직 id 를 모르는 쪽이 듣는 이벤트라 그럴 수가 없다).
    onOpened: (cb: (meta: Session) => void) => {
      const listener = (_e: IpcRendererEvent, meta: Session) => cb(meta)
      ipcRenderer.on('session:opened', listener)
      return () => ipcRenderer.removeListener('session:opened', listener)
    },
    // 그 짝 — 세션 소멸 알림. 같은 모양이어야 한다(만들기만 알리면 한쪽만 온전한 길이 된다).
    onClosed: (cb: (meta: Session) => void) => {
      const listener = (_e: IpcRendererEvent, meta: Session) => cb(meta)
      ipcRenderer.on('session:closed', listener)
      return () => ipcRenderer.removeListener('session:closed', listener)
    }
  },
  // 아라가 "이거 보세요" 하고 화면 아래 패널을 여는 길(2026-08-26).
  panel: {
    onShow: (cb: (e: { panel: string }) => void) => {
      const listener = (_e: IpcRendererEvent, e: { panel: string }) => cb(e)
      ipcRenderer.on('ui:panel', listener)
      return () => ipcRenderer.removeListener('ui:panel', listener)
    }
  },
  // F14: 클립보드 파일 경로(Ctrl+V 로 파일을 붙여넣었는지 판별).
  clipboard: {
    readFiles: () => ipcRenderer.invoke('clipboard:readFiles'),
    // 쓰기는 main 을 거친다 — navigator.clipboard 는 포커스가 없으면 거부한다(registerWindowIpc 주석).
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
    // 읽기도 main 을 거친다 — 권한 핸들러가 clipboard-read 를 거절한다(같은 주석).
    readText: () => ipcRenderer.invoke('clipboard:readText')
  },
  // F11: 명령어 히스토리. load 는 배열만 돌려주도록 풀어 준다(렌더러가 res.entries 를 벗기지 않게).
  history: {
    load: (scope: string) =>
      ipcRenderer.invoke('history:load', { scope }).then((r: { entries: string[] }) => r.entries),
    append: (scope: string, command: string) => ipcRenderer.invoke('history:append', { scope, command }),
    scopes: () => ipcRenderer.invoke('history:scopes'),
    clear: (scope?: string) => ipcRenderer.invoke('history:clear', { scope })
  },
  // W2 F8: 포트 포워딩. 인자가 포트 번호뿐이라 렌더러가 임의 호스트를 지목할 방법이 없다.
  forward: {
    create: (sessionId: string, remotePort: number, exactPort?: boolean) =>
      ipcRenderer.invoke('forward:create', { sessionId, remotePort, exactPort }),
    stop: (id: string) => ipcRenderer.invoke('forward:stop', { id }),
    list: () => ipcRenderer.invoke('forward:list')
  },
  // W2 F8: 내장 브라우저 창(preload 미주입 · 전용 파티션). 스킴 검증은 main 이 다시 한다.
  browser: {
    open: (url: string) => ipcRenderer.invoke('browser:open', { url })
  },
  // W2 F12: 세션 로그 폴더 열기.
  sessionLog: {
    list: () => ipcRenderer.invoke('sessionlog:list').then((r: { list: PastLog[] }) => r.list),
    readFile: (file: string, before?: number) => ipcRenderer.invoke('sessionlog:readFile', { file, before }),
    reveal: () => ipcRenderer.invoke('sessionlog:reveal'),
    read: (sessionId: string, before?: number) => ipcRenderer.invoke('sessionlog:read', { sessionId, before }),
    save: (sessionId: string) => ipcRenderer.invoke('sessionlog:save', { sessionId })
  },
  // W3 F16: 아라. 여기에 getKey 가 **없다** — 저장한 API 키를 렌더러로 되돌리는 창구를 만들지 않는다.
  // 채널명이 이 파일 안에만 있으므로 렌더러는 ipcRenderer 로 'ai:*' 를 직접 부를 수도 없다.
  ai: {
    getState: () => ipcRenderer.invoke('ai:getState'),
    setKey: (key: string) => ipcRenderer.invoke('ai:setKey', { key }),
    send: (req) => ipcRenderer.invoke('ai:send', req),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    clear: () => ipcRenderer.invoke('ai:clear'),
    onDelta: (cb: (d: AiDelta) => void) => {
      const listener = (_e: IpcRendererEvent, d: AiDelta) => cb(d)
      ipcRenderer.on('ai:delta', listener)
      return () => ipcRenderer.removeListener('ai:delta', listener)
    },
    onEnd: (cb: (e: AiEnd) => void) => {
      const listener = (_e: IpcRendererEvent, d: AiEnd) => cb(d)
      ipcRenderer.on('ai:end', listener)
      return () => ipcRenderer.removeListener('ai:end', listener)
    }
  },
  // W4 F23 MCP 조종 모드. getToken 이 없다 — 발급 응답에만 원문이 존재한다.
  // #125 아라 대화 — 채널 이름은 이 파일 안에만 있다(렌더러는 window.ev.ara 만 본다).
  ara: {
    open: (
      o: {
        cwd?: string
        resumeId?: string
        active?: { type: 'local' | 'ssh' | 'rdp'; cwd: string | null } | null
        engine?: 'cli' | 'api'
      } = {}
    ) =>
      ipcRenderer.invoke('ara:open', o),
    send: (text: string) => ipcRenderer.invoke('ara:send', { text }),
    planMode: (on: boolean) => ipcRenderer.invoke('ara:planMode', { on }),
    chats: () => ipcRenderer.invoke('ara:chats'),
    renameChat: (id: string, name: string) => ipcRenderer.invoke('ara:renameChat', { id, name }),
    chatLog: (id: string) => ipcRenderer.invoke('ara:chatLog', { id }),
    saveSessions: (list: unknown) => ipcRenderer.invoke('aisession:save', { list }),
    worktreeAdd: (path: string, name: string) => ipcRenderer.invoke('git:worktreeAdd', { path, name }),
    worktreeRemove: (path: string, dest: string) => ipcRenderer.invoke('git:worktreeRemove', { path, dest }),
    isRepo: (path: string) => ipcRenderer.invoke('git:isRepo', { path }),
    approvePlan: () => ipcRenderer.invoke('ara:approvePlan'),
    model: (model: string) => ipcRenderer.invoke('ara:model', { model }),
    interrupt: () => ipcRenderer.invoke('ara:interrupt'),
    close: () => ipcRenderer.invoke('ara:close'),
    state: () => ipcRenderer.invoke('ara:state'),
    onEvent: (cb: (e: AraChatEvent) => void) => {
      const listener = (_e: IpcRendererEvent, ev: AraChatEvent) => cb(ev)
      ipcRenderer.on('ara:event', listener)
      return () => ipcRenderer.removeListener('ara:event', listener)
    }
  },
  // F1a 에이전트 상태 — 훅이 말해 준 것을 받아만 본다(쓰는 함수가 없다는 것이 계약이다).
  agent: {
    state: () => ipcRenderer.invoke('agent:state'),
    onStatus: (cb: (s: AgentStatus) => void) => {
      const listener = (_e: IpcRendererEvent, s: AgentStatus) => cb(s)
      ipcRenderer.on('agent:status', listener)
      return () => ipcRenderer.removeListener('agent:status', listener)
    },
    onExit: (cb: (sessionId: string) => void) => {
      const listener = (_e: IpcRendererEvent, p: { sessionId: string }) => cb(p.sessionId)
      ipcRenderer.on('agent:exit', listener)
      return () => ipcRenderer.removeListener('agent:exit', listener)
    }
  },
  mcp: {
    getState: () => ipcRenderer.invoke('mcp:getState'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', { enabled }),
    issueToken: () => ipcRenderer.invoke('mcp:issueToken'),
    disconnectClient: () => ipcRenderer.invoke('mcp:disconnectClient'),
    setSessionMode: (sessionId: string, mode: McpSessionMode, minutes?: number) =>
      ipcRenderer.invoke('mcp:setSessionMode', { sessionId, mode, minutes }),
    handback: (kill: boolean) => ipcRenderer.invoke('mcp:handback', { kill }),
    resumeControl: () => ipcRenderer.invoke('mcp:resumeControl'),
    respondApproval: (d: McpApprovalDecision) => ipcRenderer.invoke('mcp:approvalRespond', d),
    // #125 되묻기 — AI 가 사람에게 물은 것에 답한다(헤드리스에는 되묻는 도구가 없어 우리가 만든다).
    answerAsk: (askId: string, text: string) => ipcRenderer.invoke('mcp:askAnswer', { askId, text }),
    askPending: () => ipcRenderer.invoke('mcp:askPending'),
    onAsk: (cb: (r: AskRequest) => void) => {
      const listener = (_e: IpcRendererEvent, r: AskRequest) => cb(r)
      ipcRenderer.on('mcp:ask', listener)
      return () => ipcRenderer.removeListener('mcp:ask', listener)
    },
    onAskDone: (cb: (d: { askId: string }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { askId: string }) => cb(d)
      ipcRenderer.on('mcp:askDone', listener)
      return () => ipcRenderer.removeListener('mcp:askDone', listener)
    },
    onApprovalRequest: (cb: (r: McpApprovalRequest) => void) => {
      const listener = (_e: IpcRendererEvent, r: McpApprovalRequest) => cb(r)
      ipcRenderer.on('mcp:approvalRequest', listener)
      return () => ipcRenderer.removeListener('mcp:approvalRequest', listener)
    },
    onActivity: (cb: (a: McpActivity) => void) => {
      const listener = (_e: IpcRendererEvent, a: McpActivity) => cb(a)
      ipcRenderer.on('mcp:activity', listener)
      return () => ipcRenderer.removeListener('mcp:activity', listener)
    },
    onStateChanged: (cb: (s: McpState) => void) => {
      const listener = (_e: IpcRendererEvent, s: McpState) => cb(s)
      ipcRenderer.on('mcp:stateChanged', listener)
      return () => ipcRenderer.removeListener('mcp:stateChanged', listener)
    }
  },
}

contextBridge.exposeInMainWorld('ev', api)
