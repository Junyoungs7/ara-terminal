// F1/F2 부트 스모크 — 실제 Electron으로 셸을 띄우고 보안 불변식 + window.ev + 세션 라운드트립을 검증.
// Playwright 없이 Electron main 프로세스에서 직접 어서션. 통과 시 exit 0, 실패 시 exit 1.
//
// ⚠️ **UI 개수를 단언하는 검사다. 화면 구성을 바꾸면 여기도 같이 고친다.**
// (AUDIT-R6) 이 파일이 제품보다 낡아 5건이 실패한 채로 몇 달을 지나왔다 — 레일 아이콘이 둘에서
// 셋으로, 서버 메뉴가 일곱에서 여덟로 늘었는데 기대값은 그대로였다. 회귀가 아니라 **드리프트**다.
// 원인은 단순하다: 스모크를 **배포 직전에만** 돌린다. 화면을 바꾼 그 라운드에서 같이 안 돌리면
// 몇 달 뒤 배포 게이트에서 한꺼번에 터지고, 그때는 "이게 회귀인가 낡은 기대값인가"부터 가려야 한다.
// 화면 구성(탭·메뉴 항목·섹션 개수)을 건드린 라운드는 그 라운드에서 이 파일을 함께 고친다.
// 세션 IPC는 실제 preload(out/preload/index.js)와 계약이 동일한 최소 핸들러로 배선한다(F2 에코 라운드트립).
const { app, BrowserWindow, ipcMain, safeStorage, clipboard } = require('electron')
const { join } = require('node:path')
const { mkdtempSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const pty = require('node-pty')
const { killPtysAndExit } = require('./_ptyDrain.cjs')

// M-6: userData 를 임시 경로로 격리한다(다른 하네스와 같은 패턴 — f6-restore.cjs·w2-browser.cjs 참고).
// 이 하네스는 자체 IPC 스텁만 쓰고 userData 파일을 직접 읽거나 쓰지 않지만, 격리하지 않으면 Electron
// 이 기본 %APPDATA%\Electron(디스크 캐시·GPU 캐시·세션 잠금 등)을 쓴다 — 다른 worktree 에서 스모크가
// 동시에 돌면 그 공유 경로에서 얽혀 어서션은 전부 PASS 인데 프로세스가 반환되지 않고 매달린다
// (BUG-BACKLOG.md M-6, wmic 으로 두 프로세스가 동일 --user-data-dir 을 공유함을 확인한 바 있다).
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ev-smoke-userdata-')))

// 세션 IPC 최소 배선(shared/ipc.ts 계약과 동일 채널). renderer의 window.ev.session이 이 핸들러를 호출한다.
const ptys = new Map()
// R3 회귀 진단①: renderer→pty 로 흘러간 입력 전체(터미널 응답 누출 검증용).
const INPUTS = []
// 실 main 처럼 세션 메타를 보관한다(R2.1 rename·R2.3 순서가 session:list 를 통해 스냅샷에 저장되므로,
// []를 돌려주면 저장 라운드트립을 검증할 수 없다).
const SESSIONS = []

// 실 main(MainSessionManager)과 같은 attach 계약을 흉내낸다: attach 전 출력은 백로그에 쌓아 두었다가
// renderer 가 xterm 을 만들고 attach 하면 한 번에 넘긴다(초기 출력 유실 방지 + 세션 전환 후 재생).
const BACKLOG = new Map()
const backlogOf = (id) => {
  let st = BACKLOG.get(id)
  if (!st) BACKLOG.set(id, (st = { chunks: [], attached: false }))
  return st
}
function pushData(id, d) {
  const b = Buffer.from(d, 'utf8')
  const u = new Uint8Array(b.length)
  u.set(b)
  const st = backlogOf(id)
  st.chunks.push(u)
  if (!st.attached) return
  const wc = registerSessionIpc.getWc && registerSessionIpc.getWc()
  if (!wc || wc.isDestroyed()) return
  wc.postMessage('session:data:' + id, u)
}
function attachBacklog(id) {
  const st = backlogOf(id)
  st.attached = true
  const total = st.chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of st.chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function registerSessionIpc(getWc) {
  registerSessionIpc.getWc = getWc
  ipcMain.handle('session:attach', (_e, { id }) => ({ backlog: attachBacklog(id) }))
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'sm-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const file = win ? 'cmd.exe' : '/bin/sh'
    // 앱(PtyBackend)과 동일한 안전 종료 옵션: conpty.dll 경로로 kill 시 fork/AttachConsole 회피(창·지연 제거).
    const opts = { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(file, [], opts)
    ptys.set(id, p)
    SESSIONS.push({ id, type: 'local', profileId: null, cwd: spec.cwd, title: spec.title, serverKey: spec.serverKey })
    p.onData((d) => pushData(id, d))
    p.onExit(({ exitCode }) => {
      const wc = getWc()
      if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode })
      ptys.delete(id)
    })
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => {
    try { ptys.get(id)?.resize(cols, rows) } catch {}
    return { ok: true }
  })
  ipcMain.handle('session:destroy', (_e, { id }) => {
    try { ptys.get(id)?.kill() } catch {}
    ptys.delete(id)
    return { ok: true }
  })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  // R2.1: 탭 이름 변경 — main meta 가 스냅샷 저장의 진실이므로 여기서 갱신한다.
  // R3.6: 사용자가 정한 이름은 manualTitle 로 표시해 셸 OSC 제목이 덮어쓰지 못하게 한다(실 main 과 동일 규칙).
  ipcMain.handle('session:rename', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    if (s && title) {
      s.title = title
      s.manualTitle = true
    }
    return { ok: true }
  })
  ipcMain.handle('session:autoTitle', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    // 실 main(MainSessionManager.isShellPathTitle)과 같은 규칙 — conpty 가 보내는 셸 경로 제목은 무시.
    if (!s || !title || s.manualTitle || /(?:^|[\\/])[^\\/\s]+\.exe$/i.test(title.trim())) return { applied: false }
    s.title = title
    return { applied: true }
  })
  // R3 회귀 진단①: renderer 가 pty 로 보낸 것을 전부 기록한다. xterm 이 DA(Device Attributes) 질의에
  // 답한 `\x1b[?1;2c` 가 여기 섞이면 셸 프롬프트에 `[?1;2c` 로 찍힌다.
  ipcMain.on('session:input', (_e, { id, data }) => {
    INPUTS.push({ id, data })
    ptys.get(id)?.write(data)
  })
  ipcMain.on('session:pause', (_e, { id }) => ptys.get(id)?.pause())
  ipcMain.on('session:resume', (_e, { id }) => ptys.get(id)?.resume())
}

// F3 profile/ssh IPC 최소 배선(계약 동일). 실제 safeStorage로 vault 암호화 → 평문 미노출을 실증.
// 실접속(TOFU/한글출력)은 tests/ssh-connect.test.ts에서 별도 검증. 여기선 renderer 배선 + 평문 부재만.
const SMOKE = { plaintext: 'SMOKE_PLAINTEXT_SECRET', profiles: [], vault: {} }
function registerF3Ipc() {
  ipcMain.handle('profile:list', () => SMOKE.profiles)
  ipcMain.handle('profile:save', (_e, input) => {
    // 실제 ProfileStore 처럼 신규는 새 id 를 발급한다(고정 id 재사용은 프로필끼리 서로 덮어써
    // "저장된 프로필 조회"류 검증을 무력화한다).
    const id = input.id || 'smoke-p' + (SMOKE.profiles.length + 1)
    // 비밀은 safeStorage로 암호화해 vault에(평문 저장 금지).
    if (input.secret && safeStorage.isEncryptionAvailable()) {
      SMOKE.vault[id] = safeStorage.encryptString(input.secret).toString('base64')
    }
    const profile = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      auth:
        input.authType === 'password'
          ? { type: 'password', secretRef: { store: 'vault', key: id } }
          : { type: 'key', keyPath: input.keyPath || '', secretRef: { store: 'vault', key: id } },
      group: input.group
    }
    SMOKE.profiles = [...SMOKE.profiles.filter((p) => p.id !== id), profile]
    return { profile }
  })
  ipcMain.handle('profile:delete', (_e, { id }) => {
    SMOKE.profiles = SMOKE.profiles.filter((p) => p.id !== id)
    delete SMOKE.vault[id]
    return { ok: true }
  })
  // ssh:connect: 첫 프로필은 성공(F4b 서버 그룹·트리 세션 행 검증용 — 로컬 pty를 SSH 세션으로 태움),
  // 나머지는 network 실패 반환(크래시 없음 확인). 실제 원격 접속은 tests/ssh-connect.test.ts.
  // 호스트키 재설정(UX 라운드1): knownHosts 항목 삭제. 여기선 호출 여부만 기록한다.
  ipcMain.handle('ssh:forgetHostKey', (_e, { profileId }) => {
    SMOKE.forgotHostKey = profileId
    return { ok: true, removed: true }
  })
  ipcMain.handle('ssh:connect', (_e, { profileId, acceptHostKey }) => {
    // UX 라운드1: 커스텀 호스트키 모달·실패 다이얼로그를 검증하려면 구조화 실패를 유도해야 한다.
    // 프로필 이름 접두사로 시나리오를 고른다(실접속은 ssh-connect.test.ts 담당).
    const target = SMOKE.profiles.find((p) => p.id === profileId)
    if (target && /^hostkey-/.test(target.name) && !acceptHostKey) {
      return {
        ok: false,
        reason: 'hostKeyNew',
        hostId: target.host + ':' + target.port,
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:SMOKEFINGERPRINTabcdefghijklmnop'
      }
    }
    if (target && /^authfail-/.test(target.name)) {
      return { ok: false, reason: 'auth', message: 'All configured authentication methods failed' }
    }
    if (SMOKE.profiles.some((p) => p.id === profileId)) {
      const id = 'sm-ssh-' + Math.random().toString(36).slice(2)
      const win = process.platform === 'win32'
      const file = win ? 'cmd.exe' : '/bin/sh'
      const opts = { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }
      if (win) { opts.useConpty = true; opts.useConptyDll = true }
      const p = pty.spawn(file, [], opts)
      ptys.set(id, p)
      // 실 main 처럼 같은 서버 다중 세션은 ·2, ·3 으로 구분한 title 을 돌려준다(R2.1).
      const base = target.name
      const used = new Set(SESSIONS.filter((s) => ptys.has(s.id)).map((s) => s.title))
      let title = base
      for (let n = 2; used.has(title); n++) title = base + '·' + n
      SESSIONS.push({ id, type: 'ssh', profileId, cwd: undefined, title, serverKey: base })
      const getWc = registerSessionIpc.getWc
      p.onData((d) => pushData(id, d))
      p.onExit(({ exitCode }) => { const wc = getWc && getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
      return { ok: true, id, title }
    }
    return { ok: false, reason: 'network', message: 'smoke: 실접속 미수행' }
  })
}

// F4c workspace/ui IPC 최소 배선 — 렌더러가 mount 시 workspace.load 로 ui 를 읽고, 설정 창에서
// 바꾸면 ui:setPrefs / ui:setGroups / ui:setFont / ui:setSidebar 로 좁은 갱신을 보낸다.
// 여기선 전부 in-memory 로 받아 두었다가 workspace:load 로 돌려준다(재시작 지속 흉내).
const UI = {
  font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 },
  sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
  // R5 터미널 동작 / R6 그룹 목록.
  scrollback: 10000,
  copyOnSelect: true,
  cursorStyle: 'block',
  cursorBlink: true,
  bell: 'off',
  groups: []
}
// R2.6 창 컨트롤 호출 기록.
const WINDOW_CALLS = []
// R3.3 openExternal 로 넘어온 URL 기록(실제 브라우저는 띄우지 않는다).
const OPENED = []
// F6: 스냅샷을 stateful 로 보관 — save 가 갱신하고 load 가 반환(재시작 지속 흉내). SNAP.seed 로 복원 시나리오 주입.
const SNAP = {
  seed: null, // 설정되면 workspace:load 가 이 스냅샷을 반환(F6 복원 유도)
  saved: null, // 마지막 workspace:save 페이로드(R2 이름·순서 저장 라운드트립 검증용)
  wideSave: new Set(), // 저장 페이로드에 섞여 온 main 소유 필드(있으면 BLOCKER-1 회귀)
  base: () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { ...UI, sidebar: { ...UI.sidebar }, locale: 'ko' }
  })
}
function registerWorkspaceStub() {
  ipcMain.handle('workspace:load', () => SNAP.seed ?? SNAP.base())
  ipcMain.handle('workspace:save', (_e, state) => {
    SNAP.saved = state // F6 persist 경로 수신 + R2 저장 내용 검증
    // 계약(WorkspaceSaveInput)은 렌더러 소유 필드만 받는다. main 소유 필드가 한 번이라도 섞여 오면
    // 그 자체가 회귀다 — 통째 저장이 삭제한 프로필·호스트키·ui 를 되살렸다(T1 BLOCKER-1).
    for (const k of ['profiles', 'knownHosts', 'ui']) if (state && k in state) SNAP.wideSave.add(k)
    return { ok: true }
  })
  // R2.6: 창 컨트롤 — 스모크에서 실제로 창을 내리거나 닫으면 뒤 검증이 끊긴다. 호출만 기록한다.
  ipcMain.handle('window:minimize', () => { WINDOW_CALLS.push('minimize'); return { ok: true } })
  ipcMain.handle('window:toggleMaximize', () => { WINDOW_CALLS.push('toggleMaximize'); return { maximized: true } })
  ipcMain.handle('window:close', () => { WINDOW_CALLS.push('close'); return { ok: true } })
  // R5: 설정 창이 우클릭 스타일·스크롤백·선택복사·커서·벨을 한 번에 보낸다(옛 ui:setCtxMenuStyle 대체).
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  // R6: 빈 그룹 목록.
  ipcMain.handle('ui:setGroups', (_e, { groups }) => { UI.groups = groups; return { ok: true } })
  // AUDIT-R2 ④: 화면이 버전을 **여기서** 받아 온다. 예전에는 렌더러가 '0.1.0' 을 박아 두고 있어서
  // 이 스텁이 없어도 [정보]·상태바 검사가 통과했다 — 그 박아 둔 값이 바로 결함이었다(IPC 가 실패해도
  // 영영 0.1.0 을 보여 준다). 렌더러가 빈 값으로 시작하도록 고쳤으므로 하네스도 진짜로 답해야 한다.
  ipcMain.handle('app:getVersion', () => require('../package.json').version)
  // R3.3: 실제 브라우저를 띄우면 스모크가 멈추므로 호출만 기록하고 스킴 검증 결과를 흉내낸다.
  ipcMain.handle('app:openExternal', (_e, { url }) => {
    const safe = /^https?:\/\//.test(url)
    if (safe) OPENED.push(url)
    return { ok: safe }
  })
  // F5: 폰트 설정 영속(in-memory) — setFont 후 workspace:load 가 새 폰트를 반환하면 재시작 지속 실증.
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
  // R4.3: 사이드바 폭·접힘·활성 탭도 같은 방식으로 영속.
  ipcMain.handle('ui:setSidebar', (_e, sidebar) => { UI.sidebar = sidebar; return { ok: true } })
}

// F7: SFTP IPC 스텁(계약 동일) — 실 SFTP 프로토콜 없이 [파일] 탭 트리 렌더 + API 존재만 검증.
// 실 전송/취소/부분정리/커넥션재사용은 tests/sftp.test.ts + tests/f7-screenshot.cjs 가 실증한다.
function registerF7Stub() {
  ipcMain.handle('sftp:list', (_e, { path }) => ({
    ok: true, path: path === '.' ? '/home/deploy/서비스' : path,
    parent: '/home/deploy',
    entries: [
      { name: '배포스크립트', type: 'dir', size: 0, mtime: Date.now() - 3 * 86400 * 1000 },
      { name: '로그', type: 'dir', size: 0, mtime: Date.now() - 2 * 3600 * 1000 },
      { name: 'README_한글.md', type: 'file', size: 3200, mtime: Date.now() - 20 * 60 * 1000 }
    ]
  }))
  ipcMain.handle('sftp:download', () => ({ ok: true }))
  ipcMain.handle('sftp:upload', () => ({ ok: true }))
  ipcMain.handle('sftp:cancel', () => ({ ok: true }))
  ipcMain.handle('sftp:pickSavePath', () => ({ path: null }))
  ipcMain.handle('sftp:pickSaveDir', () => ({ path: null }))
  ipcMain.handle('sftp:pickUploadPaths', () => ({ paths: [] }))
  // R7 원격 파일 조작(계약 동일 스텁 — 실동작은 tests/sftp.test.ts 가 실 SFTP 로 실증).
  ipcMain.handle('sftp:rename', () => ({ ok: true }))
  ipcMain.handle('sftp:mkdir', () => ({ ok: true }))
  ipcMain.handle('sftp:remove', () => ({ ok: true }))
  // R7 로컬 파일시스템 스텁 — [파일] 탭이 로컬 세션에서도 트리를 그리는지 검증한다
  // (실 파일 조작은 tests/localfs.test.ts 가 임시 디렉토리로 실증).
  ipcMain.handle('fs:list', (_e, { path }) => ({
    ok: true,
    path: path === '.' ? 'C:\\Users\\deploy\\작업' : path,
    parent: 'C:\\Users\\deploy',
    entries: [
      { name: '문서', type: 'dir', size: 0, mtime: Date.now() - 3600 * 1000 },
      { name: '메모_한글.txt', type: 'file', size: 512, mtime: Date.now() - 120 * 1000 }
    ]
  }))
  ipcMain.handle('fs:rename', () => ({ ok: true }))
  ipcMain.handle('fs:mkdir', () => ({ ok: true }))
  // #89: 채널이 fs:trash 로 바뀌었다(실제로 shell.trashItem 을 탄다). 스텁을 안 갈면 스모크가
  // 사용자 휴지통에 잔여물을 남긴다 — 하네스는 사용자 PC 를 건드리지 않는다.
  ipcMain.handle('fs:trash', () => ({ ok: true }))
  // #88 R2: 새 쓰기 채널 둘도 막는다 — fs:move 는 **실제로 파일을 옮긴다**(휴지통도 안 거친다).
  // 하네스가 사용자 PC 를 건드리지 않는다는 규칙은 채널이 늘 때마다 다시 지켜야 한다.
  ipcMain.handle('fs:move', () => ({ ok: true }))
  ipcMain.handle('fs:newFile', () => ({ ok: true }))
  // #92: 받는 곳도 막는다. 안 막으면 다운로드가 실제 다운로드 폴더로 떨어진다.
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
}

// GPU/샌드박스가 CI/헤드리스에서 막히는 것 방지 (검증 목적 한정)
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')

let suiteTimeout = null
// 종료 구간에 들어가면 스위트 상한을 해제한다 — 상한은 매달린 스위트를 잡는 것이지 종료를 감시하는
// 게 아니다. 종료·실패 양쪽 경로가 모두 여기를 거친다.
function endSuite(code) {
  clearTimeout(suiteTimeout)
  return killPtysAndExit(ptys.values(), code)
}

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg)
  // 실패 경로도 같은 배수를 거친다 — 안 그러면 실패 원인이 종료 크래시에 덮여 보이지 않는다
  // (실측: 타임아웃 fail 의 app.exit(1) 이 프로세스를 끝내지 못하고 매달렸다).
  void endSuite(1)
}

// 하네스는 절대 사람의 클릭을 기다리면 안 된다.
// 리스너가 없으면 Electron 기본 동작이 살아나 **모달** 에러 창("A JavaScript error occurred in the
// main process")을 띄우는데, 그 모달이 프로세스를 붙잡아 app.exit() 조차 통과하지 못한다 — 266개
// 전부 PASS 하고도 종료를 못 하던 정체가 이것이었다(2026-08-11 실측: 창 본문이 smoke-boot.cjs:307
// 의 "Object has been destroyed" 였고, 회차마다 준영님 실제 업무 화면에 떴다).
// 그래서 삼키지 않고 **스택을 찍고 즉시 실패**시킨다 — 창 대신 빨간 로그로.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    const stack = err instanceof Error ? err.stack ?? err.message : String(err)
    console.error(`SMOKE ${ev}:\n${stack}`)
    fail(`${ev} — ${err instanceof Error ? err.message : String(err)}`)
  })
}

app.whenReady().then(async () => {
  let win
  // 앱의 src/main/index.ts:101 과 같은 가드. `win` 의 null 검사만으로는 부족하다 — 파괴된
  // BrowserWindow 는 `.webContents` **게터 접근 자체가** "Object has been destroyed" 를 던진다
  // (커밋 c014eea 가 앱에서 고친 패턴인데 이 하네스만 안 고쳐져 있었다). 종료 시 창이 먼저
  // 파괴되고 pty 출력이 뒤늦게 도착하면 매번 여기서 터졌다.
  registerSessionIpc(() => {
    try {
      return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null
    } catch {
      return null
    }
  })
  registerF3Ipc()
  registerWorkspaceStub()
  registerF7Stub()

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(OUT, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.webContents.on('render-process-gone', (_e, d) => fail('renderer gone: ' + JSON.stringify(d)))

  await win.loadFile(join(OUT, 'renderer', 'index.html'))

  // 보안 옵션 (계획서 완료조건)
  const wp = win.webContents.getLastWebPreferences()
  /**
 * 숨긴 기능(src/shared/features.ts)의 검사는 건너뛴다. 값을 여기 또 적으면 둘이 어긋나므로
 * **정의부를 그대로 읽는다** — 상수를 되돌리면 이 검사들도 저절로 살아난다.
 */
const FEATURES_SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'shared', 'features.ts'),
  'utf8'
)
const AI_CHAT = /AI_CHAT\s*=\s*true/.test(FEATURES_SRC)
/**
 * **메뉴에 [아라에게 묻기]가 뜨는가**는 AI_CHAT 이 아니라 `AI_ENTRY = AI_CHAT || ARA_CHAT` 이
 * 정한다(features.ts:47 · actions.tsx:120). #126 에서 ARA_CHAT 이 켜지면서 항목이 돌아왔는데
 * 여기는 AI_CHAT 만 보고 있어 **7항목을 기대한 채 8항목이 뜨는** 실패가 됐다 — AUDIT-R6.
 */
const ARA_CHAT = /ARA_CHAT\s*=\s*true/.test(FEATURES_SRC)
const AI_ENTRY = AI_CHAT || ARA_CHAT

const checks = []
  checks.push(['contextIsolation', wp.contextIsolation === true])
  checks.push(['nodeIntegration', wp.nodeIntegration === false || wp.nodeIntegration === undefined])
  checks.push(['sandbox', wp.sandbox === true])

  // renderer 측 검증: window.ev 존재, window.require 부재, 셸 3행 렌더
  const r = await win.webContents.executeJavaScript(`(() => ({
    hasEv: typeof window.ev === 'object' && window.ev !== null,
    hasWorkspace: typeof window.ev?.workspace?.load === 'function',
    hasSessionCreate: typeof window.ev?.session?.create === 'function',
    requireType: typeof window.require,
    hasApp: !!document.querySelector('.app'),
    hasTitlebar: !!document.querySelector('.titlebar'),
    hasSidebar: !!document.querySelector('.sidebar'),
    hasTabbar: !!document.querySelector('.term-tabbar'),
    hasStatusbar: !!document.querySelector('.statusbar'),
    sbTabs: document.querySelectorAll('.lrail-item').length,
    brandName: document.querySelector('.tb-name')?.textContent || '',
    gridRows: getComputedStyle(document.querySelector('.app')).gridTemplateRows
  }))()`)

  checks.push(['window.ev 존재', r.hasEv])
  checks.push(['window.ev.workspace.load', r.hasWorkspace])
  checks.push(['window.require 부재', r.requireType === 'undefined'])
  checks.push(['.app 렌더', r.hasApp])
  checks.push(['.titlebar 렌더', r.hasTitlebar])
  checks.push(['.sidebar 렌더', r.hasSidebar])
  checks.push(['.term-tabbar 렌더', r.hasTabbar])
  checks.push(['.statusbar 렌더', r.hasStatusbar])
  // FB-ui2: [모니터] 탭이 우측 액티비티 바로 이관되며 사이드바는 2개(연결·파일)가 됐고,
  // #129 가 [작업대](ai)를 넣어 다시 3개가 됐다 — 정의부는 Sidebar.tsx 의 `['conn','file','ai']`.
  checks.push(['좌측 레일 아이콘 3개(연결·파일·작업대)', r.sbTabs === 3])
  checks.push(['브랜드=A.R.A', r.brandName.includes('A.R.A')])
  checks.push(['3행 그리드', /px .+ px/.test(r.gridRows) || r.gridRows.split(' ').length === 3])

  // F2: window.ev.session API 존재 + 세션 생성→에코 라운드트립(한글 무결).
  checks.push(['window.ev.session.create', r.hasSessionCreate])

  const sessionResult = await win.webContents.executeJavaScript(`(async () => {
    const dec = new TextDecoder('utf-8')
    let out = ''
    const { id } = await window.ev.session.create({ type: 'local', title: 't', serverKey: 'localhost', profileId: null })
    const off = window.ev.session.onData(id, (chunk) => { out += dec.decode(chunk, { stream: true }) })
    // 구독 → attach: attach 전 출력은 main 재생 버퍼에 있으므로 백로그도 함께 받는다(R1.1 계약).
    const { backlog } = await window.ev.session.attach(id)
    out += dec.decode(backlog, { stream: true })
    await new Promise((res) => {
      window.ev.session.onExit(id, () => res())
      const cmd = navigator.platform.match(/Win/) ? 'echo 한글에코스모크\\r\\nexit\\r\\n' : 'echo 한글에코스모크\\n exit\\n'
      window.ev.session.input(id, cmd)
      setTimeout(res, 4000)
    })
    off()
    return { got: out.includes('한글에코스모크'), gotLocalId: typeof id === 'string' }
  })()`)

  checks.push(['세션 생성 id 반환', sessionResult.gotLocalId])
  checks.push(['세션 에코 라운드트립(한글)', sessionResult.got])

  // ── F3 어서션 ── window.ev.profile/ssh 존재 + 프로필 저장 + vault 평문 부재.
  const f3a = await win.webContents.executeJavaScript(`(async () => {
    const hasProfile = typeof window.ev?.profile?.save === 'function' && typeof window.ev?.profile?.list === 'function'
    const hasSsh = typeof window.ev?.ssh?.connect === 'function'
    const { profile } = await window.ev.profile.save({
      name: 'smoke-dev', host: '10.9.9.9', port: 22, username: 'deploy',
      authType: 'password', secret: 'SMOKE_PLAINTEXT_SECRET', group: '개발'
    })
    const list = await window.ev.profile.list()
    const saved = list.some(p => p.id === profile.id && p.name === 'smoke-dev')
    const noPlainInProfile = JSON.stringify(list).indexOf('SMOKE_PLAINTEXT_SECRET') === -1
    const conn = await window.ev.ssh.connect(profile.id)
    // 구조화된(예외 없는) 결과: 성공={ok:true,id}, 실패={ok:false,reason}. 둘 다 크래시 없음.
    const structuredFail =
      conn && (conn.ok === true ? typeof conn.id === 'string' : typeof conn.reason === 'string')
    window.__smokeProfileId = profile.id
    return { hasProfile, hasSsh, saved, noPlainInProfile, structuredFail }
  })()`)

  // 프로필이 SMOKE.profiles에 저장된 상태에서 렌더러를 재로드 → useProfiles가 새 목록을 로드(재시작 지속성 유사).
  await win.webContents.reload()
  await new Promise((r) => setTimeout(r, 800))

  const f3b = await win.webContents.executeJavaScript(`(async () => {
    // 연결 관리자 열기 → 모달 + 폼 + 프로필 리스트 행 렌더.
    // R4.1 이후 Session 은 드롭다운이라 첫 항목(연결 관리자)까지 골라야 한다.
    const sessionMenu = [...document.querySelectorAll('.tb-menu span')].find(s => s.textContent === '세션')
    if (sessionMenu) sessionMenu.click()
    await new Promise(r => setTimeout(r, 200))
    document.querySelector('.ctx-menu .ctx-item[data-action="connection.manager"]')?.click()
    await new Promise(r => setTimeout(r, 250))
    const modalOpen = !!document.querySelector('.overlay.open .modal')
    const hasForm = !!document.querySelector('.prof-form .seg-ctl')
    const profRowInModal = !!document.querySelector('.prof-list .prof')
    // 모달 닫고(ESC) 사이드바 연결 트리 서버 노드 렌더 확인.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await new Promise(r => setTimeout(r, 150))
    // .srv-node 는 "＋ 새 로컬 셸" 행도 쓰므로 서버 노드만(호스트 메타가 있는 행) 센다.
    const treeNode = !!document.querySelector('.tree .srv-node:not(.new-local) .sname')
    return { modalOpen, hasForm, profRowInModal, treeNode }
  })()`)
  const f3 = { ...f3a, ...f3b }

  checks.push(['window.ev.profile.save/list', f3.hasProfile])
  checks.push(['window.ev.ssh.connect', f3.hasSsh])
  checks.push(['프로필 저장→리스트 반영', f3.saved])
  checks.push(['프로필 JSON에 평문 비밀 없음', f3.noPlainInProfile])
  checks.push(['연결 관리자 모달 열림', f3.modalOpen])
  checks.push(['모달 폼(인증 세그먼트) 렌더', f3.hasForm])
  checks.push(['모달 프로필 리스트 행 렌더', f3.profRowInModal])
  checks.push(['사이드바 연결 트리 서버 노드 렌더', f3.treeNode])
  checks.push(['ssh:connect 구조화 결과 반환(크래시 없음)', f3.structuredFail])

  // vault 파일 평문 미노출(safeStorage 사용 가능한 경우에만 실증). base64 암호문만.
  if (safeStorage.isEncryptionAvailable()) {
    const dir = mkdtempSync(join(tmpdir(), 'ev-smoke-vault-'))
    const vpath = join(dir, 'secrets.vault')
    require('node:fs').writeFileSync(vpath, JSON.stringify(SMOKE.vault))
    const raw = readFileSync(vpath, 'utf8')
    checks.push(['vault 파일에 평문 비밀 없음', existsSync(vpath) && raw.indexOf(SMOKE.plaintext) === -1])
  } else {
    console.log('SKIP vault 평문 검사 (safeStorage 미가용 환경)')
  }

  // ── F4a 어서션 ── 분할 생성 / 4분할 상한 차단 / 포커스 링.
  // 새 세션(+) → Ctrl+- 3회로 4패널 → 5번째 시도 차단(패널 수 유지 + 토스트).
  const f4 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const paneCount = () => document.querySelectorAll('.pane-grid .pane').length
    const splitKey = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true }))
    // 첫 세션 생성. ＋ 는 이제 메뉴를 열므로(로컬 셸 발견성, UX 라운드1) "로컬 셸"까지 골라야 한다.
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click()
      await wait(200)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click()
    }
    await newLocal()
    await wait(500)
    const afterOpen = paneCount()
    // 2→3→4 분할.
    splitKey(); await wait(350)
    splitKey(); await wait(350)
    splitKey(); await wait(350)
    const atFour = paneCount()
    // 5번째 분할 시도 → 차단(패널 수 유지) + 토스트 노출.
    splitKey(); await wait(350)
    const afterFifth = paneCount()
    const toast = !!document.querySelector('.pane-toast')
    // 포커스 링: 정확히 하나의 .pane.focused.
    const focused = document.querySelectorAll('.pane-grid .pane.focused').length
    // 두 번째 패널 클릭 → 포커스 이동.
    const panes = document.querySelectorAll('.pane-grid .pane')
    if (panes[0]) panes[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(150)
    const firstFocused = document.querySelectorAll('.pane-grid .pane')[0]?.classList.contains('focused')
    return { afterOpen, atFour, afterFifth, toast, focused, firstFocused }
  })()`)

  checks.push(['첫 세션 → 단일 패널', f4.afterOpen === 1])
  checks.push(['Ctrl+- 3회 → 4분할', f4.atFour === 4])
  checks.push(['5번째 분할 차단(패널 4 유지)', f4.afterFifth === 4])
  checks.push(['상한 초과 토스트 노출', f4.toast === true])
  checks.push(['포커스 링 정확히 1개', f4.focused === 1])
  checks.push(['패널 클릭 시 포커스 이동', f4.firstFocused === true])

  // ── F4b 어서션 ── FB-tabs: 그룹 래퍼(.tg) 제거 확인 + 탭 dot 색 단서 / 트리 세션 자식 행 /
  // 3방향 동기 / 칸 닫기·탭 닫기 = 둘 다 세션 종료(R9a).
  const f4b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    // 로컬 세션은 그룹 래퍼 없이 평평한 개별 탭이다.
    const localTabsBefore = document.querySelectorAll('.term-tabbar .ttab').length
    // SSH 프로필(F3에서 저장) 더블클릭 접속 → 평평한 탭 + 트리 세션 자식 행 생성(R1.3: 원클릭=선택).
    const dbl = (el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    }
    const srvNode = document.querySelector('.tree .srv-node')
    if (srvNode) dbl(srvNode)
    await wait(900)
    // FB-tabs: 그룹 래퍼(.tg)는 완전히 없어야 한다 — 있으면 회귀.
    const tabGroups = document.querySelectorAll('.term-tabbar .tg').length
    const sshTabs = document.querySelectorAll('.term-tabbar .ttab').length
    // 구분 단서: SSH 탭의 dot 색이 비어 있지 않다(groupColor 인라인 style).
    const sshTabDot = document.querySelectorAll('.term-tabbar .ttab .tdot')[localTabsBefore]
    const sshDotColor = sshTabDot ? sshTabDot.style.background : ''
    // 트리(S1): 서버 행 아래 세션 행(.sess-list .sess-node) 렌더.
    // 타입은 **서버 행의 배지**가 말한다 — 세션 행에서 계정@호스트·타입을 걷어냈다(2026-08-08 재설계).
    // 로컬 세션이 먼저 올 수 있어 SSH 배지를 단 서버 그룹 안에서 집는다.
    const sshGroup = () =>
      [...document.querySelectorAll('.tree .srv-group[data-server]')].find(
        (g) => g.querySelector('.srv-node .tbadge')?.textContent === 'SSH'
      )
    const sshCard = () => sshGroup()?.querySelector('.sess-list .sess-node')
    const treeSessRow = !!document.querySelector('.tree .sess-list .sess-node')
    const treeSessType = sshGroup()?.querySelector('.srv-node .tbadge')?.textContent || ''
    // 3방향 동기: 트리 세션 행 클릭 → 해당 세션 탭 active + 패널 표시.
    const sessRow = sshCard()
    if (sessRow) sessRow.click()
    await wait(300)
    const treeRowActive = !!document.querySelector('.tree .sess-list .sess-node.active')
    const sshTabActive = !!document.querySelector('.term-tabbar .ttab.active')
    // R9a: 칸 닫기 = 그 칸의 세션 종료(탭도 함께 사라진다). 예전엔 detach(탭만 남김)였고 그게
    // "좀비 탭"으로 읽혀 바꿨다 — 지금 활성 세션은 SSH 라 확인 다이얼로그가 먼저 뜬다.
    const tabsBeforeClose = document.querySelectorAll('.term-tabbar .ttab').length
    const panesBeforeClose = document.querySelectorAll('.pane-grid .pane').length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(300)
    // SSH 종료 확인(위험 톤) — 이게 안 뜨면 원격 작업이 경고 없이 끊긴다는 뜻이라 그 자체가 어서션이다.
    // ⚠️ 여기서는 okDialog() 를 쓰지 않는다: 이 검사는 **다이얼로그가 떠 있다는 사실 자체**를 보므로
    //    먼저 눌러 버리면 볼 게 없어진다(2026-08-11 실제로 그렇게 깨뜨렸다). 아래에서 직접 누른다.
    const sshCloseAsks = !!document.querySelector('.dlg-overlay .modal.sm.danger')
    document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')?.click()
    await wait(400)
    const panesAfterClose = document.querySelectorAll('.pane-grid .pane').length
    const tabsAfterPaneClose = document.querySelectorAll('.term-tabbar .ttab').length
    // 탭 닫기 = 세션 종료: 임의 탭의 × 클릭 → 탭 수 감소(로컬 탭이라 확인 없음).
    const anyTab = document.querySelector('.term-tabbar .ttab')
    let tabsAfterClose = tabsAfterPaneClose
    if (anyTab) {
      anyTab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      const tx = anyTab.querySelector('.tx')
      if (tx) tx.click()
      await wait(200)
      await okDialog()
      await wait(300)
      tabsAfterClose = document.querySelectorAll('.term-tabbar .ttab').length
    }
    return {
      localTabsBefore, tabGroups, sshTabs, sshDotColor,
      treeSessRow, treeSessType, treeRowActive, sshTabActive,
      tabsBeforeClose, panesBeforeClose, panesAfterClose, tabsAfterPaneClose, sshCloseAsks, tabsAfterClose
    }
  })()`)

  checks.push(['로컬 세션은 평평한 개별 탭', f4b.localTabsBefore >= 1])
  checks.push(['트리 서버 노드 더블클릭 → 접속(원클릭은 선택)', f4b.sshTabs > f4b.localTabsBefore])
  checks.push(['그룹 래퍼(.tg) 완전 제거(FB-tabs)', f4b.tabGroups === 0])
  checks.push(['탭 dot 색으로 서버 구분 단서(groupColor)', f4b.sshDotColor.length > 0])
  checks.push(['트리 서버 노드 하위 세션 행 렌더', f4b.treeSessRow === true])
  checks.push(['트리 서버 행 타입 배지=SSH', f4b.treeSessType === 'SSH'])
  checks.push(['트리 세션 클릭 → 트리 행 active', f4b.treeRowActive === true])
  checks.push(['트리 세션 클릭 → 탭 active(동기)', f4b.sshTabActive === true])
  checks.push(['SSH 칸 닫기 전 확인 다이얼로그(위험 톤)', f4b.sshCloseAsks === true])
  checks.push([
    'R9a: 칸 닫기 = 세션 종료(칸↓ 탭도↓)',
    f4b.panesAfterClose < f4b.panesBeforeClose && f4b.tabsAfterPaneClose < f4b.tabsBeforeClose
  ])
  checks.push(['탭 닫기 = 세션 종료(탭↓)', f4b.tabsAfterClose < f4b.tabsAfterPaneClose])

  // ── F7 + R7 어서션 ── fs/SFTP API 존재 / [파일] 탭: 로컬 세션은 로컬 트리, SSH 세션은 SFTP 트리 /
  // 다중 선택 · 우클릭 파일 메뉴 · 브레드크럼 · mtime 열 / cwd 이벤트 seam.
  const f7 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    // window.ev.sftp / fs / session.onCwd API 존재(preload 계약).
    const hasSftp = typeof window.ev?.sftp?.list === 'function' && typeof window.ev?.sftp?.download === 'function'
      && typeof window.ev?.sftp?.upload === 'function' && typeof window.ev?.sftp?.cancel === 'function'
      && typeof window.ev?.sftp?.rename === 'function' && typeof window.ev?.sftp?.mkdir === 'function'
      && typeof window.ev?.sftp?.remove === 'function'
    // #89·#92: remove -> trash(휴지통)로 이름이 바뀌었고 openPath/reveal/downloadsDir/freeName 이 붙었다.
    const hasFs = typeof window.ev?.fs?.list === 'function' && typeof window.ev?.fs?.rename === 'function'
      && typeof window.ev?.fs?.mkdir === 'function' && typeof window.ev?.fs?.trash === 'function'
      && typeof window.ev?.fs?.openPath === 'function' && typeof window.ev?.fs?.reveal === 'function'
      && typeof window.ev?.fs?.downloadsDir === 'function' && typeof window.ev?.fs?.freeName === 'function'
      && typeof window.ev?.fs?.newFile === 'function' && typeof window.ev?.fs?.move === 'function'
      && typeof window.ev?.fs?.drives === 'function'
      && window.ev?.fs?.remove === undefined
    const hasOnCwd = typeof window.ev?.session?.onCwd === 'function'
    // 로컬 세션을 활성화(＋ → 로컬 셸) → R7: [파일] 탭이 로컬 파일시스템(fs:list)을 그린다.
    document.querySelector('.tterm-add')?.click()
    await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click()
    await wait(500)
    const fileTab = document.querySelector('.lrail-item[data-tab="file"]')
    if (fileTab) fileTab.click()
    await wait(400)
    const localRows = [...document.querySelectorAll('.ftree .frow')]
    const localNames = localRows.map(r => r.querySelector('.fn')?.textContent || '')
    // Windows 경로도 브레드크럼으로 쪼개진다(첫 조각 = 드라이브).
    const localCrumbs = [...document.querySelectorAll('.fcrumb .seg')].map(s => s.textContent)
    // 다중 선택: 첫 행 클릭 + 둘째 행 Ctrl 클릭.
    localRows[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(80)
    localRows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await wait(150)
    const multiSel = document.querySelectorAll('.ftree .frow.sel').length
    // 우클릭 → 파일 메뉴(다중 선택이므로 새 폴더 + 삭제).
    localRows[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }))
    await wait(250)
    const fileMenu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)
    // SSH 세션 확보: 연결 트리 서버 노드 더블클릭 접속 → 활성 세션이 SSH → FileTree 가 sftp:list 로 트리 렌더.
    const srvNode = document.querySelector('.tree .srv-node')
    if (srvNode) {
      srvNode.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      srvNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    }
    await wait(900)
    // 다시 [파일] 탭(접속으로 conn 탭이 활성일 수 있음).
    if (fileTab) fileTab.click()
    await wait(400)
    const rows = [...document.querySelectorAll('.ftree .frow')]
    const names = rows.map(r => r.querySelector('.fn')?.textContent || '')
    const crumbs = [...document.querySelectorAll('.fcrumb .seg')].map(s => s.textContent)
    const hasUp = [...document.querySelectorAll('.sftp-path-bar .sb-act')].length >= 2
    return {
      hasSftp, hasFs, hasOnCwd,
      localRowCount: localRows.length,
      localKorean: localNames.some(n => /문서|메모_한글/.test(n)),
      localCrumbFirst: localCrumbs[0] || '',
      multiSel, fileMenu,
      // #88 R2: 상태 표시줄은 목록이 왜 줄었는지를 말하는 자리다 — 있어야 하고, 개수를 세야 한다.
      fstat: document.querySelector('.sftp-wrap .fstat')?.textContent || '',
      rowCount: rows.length, korean: names.some(n => /배포스크립트|로그|README_한글/.test(n)),
      dirFirst: rows[0]?.classList.contains('dir') === true,
      crumbCount: crumbs.length,
      // 아이콘은 전부 인라인 SVG(R7.4 — 이모지/글리프 없음), mtime 열이 채워진다.
      svgIcons: document.querySelectorAll('.ftree .frow .fi svg').length,
      mtimes: [...document.querySelectorAll('.ftree .frow .fmt')].filter(s => s.textContent).length,
      hasUp
    }
  })()`)

  checks.push(['window.ev.sftp API 존재(list/download/upload/cancel/rename/mkdir/remove)', f7.hasSftp === true])
  checks.push(['R7·#88 R2: window.ev.fs API 존재(list/rename/mkdir/**trash**/openPath/reveal/downloadsDir/freeName/newFile/move/drives · remove 는 사라졌다)', f7.hasFs === true])
  checks.push(['window.ev.session.onCwd 존재(cwd 이벤트)', f7.hasOnCwd === true])
  checks.push(['R7: [파일] 탭이 로컬 세션에서 로컬 트리 렌더', f7.localRowCount >= 1 && f7.localKorean === true])
  checks.push(['R7: Windows 경로 브레드크럼(드라이브가 첫 조각)', /^[A-Za-z]:$/.test(f7.localCrumbFirst)])
  checks.push(['R7: Ctrl 클릭 다중 선택', f7.multiSel === 2])
  // file.saveWork = 이 위치를 작업 프로필로 저장(선택 여부와 무관 — 대상은 "이 폴더"다).
  // #88 R1(2026-08-16): 빈 영역 우클릭에 **아라 연결점**이 붙었다 — 여기서 터미널·AI CLI 시작.
  // 준영님: "차이점은 우리 아라와 연결된다는 점이지." 순서도 뜻이 있다: 탐색기를 흉내 내는 칸
  // (새 폴더) 다음에 우리 것이 온다.
  checks.push([
    'R7: 파일 우클릭 메뉴(새 폴더 · 아라 연결점 · 작업 프로필 · 삭제)',
    // 순서를 통째로 박지 않고 **있어야 할 것**만 본다 — 아라 연결점이 더 붙어도 이 검사가
    // 깨지지 않되, 빠지면 잡힌다(그게 이 화면이 탐색기와 갈리는 자리다).
    ['file.mkdir', 'file.aicli', 'file.terminal', 'file.saveWork', 'file.delete'].every((x) => f7.fileMenu.includes(x))
  ])
  // #88 R2: 탐색기 따라잡기 칸들. 로컬 세션에서 우클릭한 메뉴라 **로컬 전용 항목까지** 다 있어야 한다.
  checks.push([
    '#88 R2: 파일 우클릭에 잘라내기·복사·붙여넣기·새 파일·보기·[윈도우 탐색기에서 보기]',
    ['file.cut', 'file.copy', 'file.paste', 'file.newFile', 'file.view', 'file.reveal'].every((x) => f7.fileMenu.includes(x))
  ])
  checks.push(['#88 R2: 상태 표시줄이 항목 수를 센다', /\d+개 항목/.test(f7.fstat)])
  checks.push(['[파일] 탭: SSH 세션 시 SFTP 트리 렌더', f7.rowCount >= 1])
  checks.push(['SFTP 트리 한글 파일/폴더명', f7.korean === true])
  checks.push(['SFTP 트리 폴더 우선 정렬', f7.dirFirst === true])
  checks.push(['SFTP 브레드크럼(세그먼트) + 상위 이동 버튼', f7.crumbCount > 0 && f7.hasUp === true])
  checks.push(['R7: 파일 행 아이콘이 인라인 SVG + mtime 열', f7.svgIcons === f7.rowCount && f7.mtimes === f7.rowCount])

  // ── F4c 어서션 ── 터미널 우클릭 리스트 메뉴(8항목) / ? →치트시트 / ESC 닫기 / Ctrl+K 통과(#67).
  // 라디얼·팔레트는 R1.4 에서 전환 UI 가 사라져 도달 경로가 없었다 — R5 설정 창 [일반]에서 다시 노출했고
  // 아래 R5 블록이 "라디얼 선택 → 우클릭이 라디얼로 뜬다"까지 실증한다.
  const f4c = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    // 패널 하나 확보(＋ → 로컬 셸).
    document.querySelector('.tterm-add')?.click(); await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(600)
    const grid = document.querySelector('.pane-grid')
    // 우클릭 → 리스트 메뉴 전개(기본 스타일 list — 라디얼은 커서가 라벨을 가린다는 피드백).
    grid?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 400 }))
    await wait(400)
    const listOpen = !!document.querySelector('.ctx-menu')
    const listItems = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    const listIcons = document.querySelectorAll('.ctx-menu .ctx-item .ci-ic svg').length
    const listHints = [...document.querySelectorAll('.ctx-menu .ctx-item .ci-kbd')].map(k => k.textContent)
    const listDim = document.querySelectorAll('.ctx-menu .ctx-item.dim').length
    const listDanger = document.querySelectorAll('.ctx-menu .ctx-item.danger').length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(300)
    const listClosed = !document.querySelector('.ctx-menu')
    // R1.4: 탭바 순환 토글 제거 — 스타일은 설정 창에서만 고른다(우클릭이 순환하지 않는다).
    const toggleGone = !document.querySelector('.menu-toggle')
    // R5: 탭바 우측 도구 버튼(설정·치트시트)도 제거 — 설정은 우측 액티비티 바·Ctrl+,·File>설정으로 간다.
    const tabbarToolsGone = !document.querySelector('.term-tabbar .tterm-tools') && !document.querySelector('.cs-open-btn')
    // FB-ui2: 타이틀바 기어(.tb-gear)는 제거됐다 — 대신 우측 액티비티 바에 설정 아이콘이 있다.
    const gearGoneFromTitlebar = !document.querySelector('.titlebar .tb-gear')
    const settingsInActivityBar = !!document.querySelector('.act-item[data-activity="settings"]')
    grid?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 400 }))
    await wait(400)
    const stillList = !!document.querySelector('.ctx-menu') && !document.querySelector('.radial-menu, .smart-palette')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(300)
    // #67: Ctrl+K 가 앱 키에서 빠졌다 — 아무 오버레이도 열리지 않아야 셸(리드라인 라인킬)이 받는다.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await wait(300)
    const ctrlKFree = !document.querySelector('.smart-palette, .radial-menu, .cp-drop, .cheatsheet.open')
    // 치트시트: 터미널에 포커스가 있으면 ? 는 셸 입력이므로 열리면 안 된다(xterm textarea = 입력 요소).
    document.querySelector('.pane.focused .term-pane .xterm-helper-textarea')?.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); await wait(250)
    const csBlockedWhileTyping = !document.querySelector('.cheatsheet.open')
    // 터미널 밖(포커스 해제)에서는 ? 로 열린다.
    document.activeElement?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); await wait(300)
    const csOpen = !!document.querySelector('.cheatsheet.open')
    const csRows = document.querySelectorAll('.cheatsheet.open .cs-row').length
    const csCols = document.querySelectorAll('.cheatsheet.open .cs-grid > div').length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(300)
    const csClosed = !document.querySelector('.cheatsheet.open')
    return { listOpen, listItems, listIcons, listHints, listDim, listDanger, listClosed, toggleGone, tabbarToolsGone, gearGoneFromTitlebar, settingsInActivityBar, stillList, ctrlKFree, csBlockedWhileTyping, csOpen, csRows, csCols, csClosed }
  })()`)

  checks.push(['터미널 우클릭 기본 = 리스트 메뉴', f4c.listOpen === true])
  // 2026-08-18: 평면 여덟 줄에서 **묶음 둘**(분할 ▸ 가로/세로 · AI 실행 ▸ CLI 셋)로 바뀌었다.
  // 첫 단계는 여전히 여덟 줄인데 그중 둘이 서브메뉴 부모다(자식은 호버해야 그려진다).
  // (tmux 항목은 SSH 세션일 때만 붙는다 — 여기는 로컬 셸이라 없다.)
  const ctxWanted = AI_ENTRY
    ? 'copy,paste,split,aicli.run,session.duplicate,log.save,ai.ask,pane.close'
    : 'copy,paste,split,aicli.run,session.duplicate,log.save,pane.close'
  checks.push([`리스트 첫 단계 = 실동작 ${AI_ENTRY ? 6 : 5} + 묶음 2`, f4c.listItems.join(',') === ctxWanted])
  checks.push(['리스트 항목마다 아이콘', f4c.listIcons === (AI_ENTRY ? 8 : 7)])
  // R3.8 재배치 반영 — 힌트도 keymap 단일 소스에서 나오므로 자동으로 Ctrl+Shift 계열이 된다.
  // 분할 단축키(Ctrl+Shift+-/\)는 이제 서브메뉴 안이라 첫 단계엔 없다 — 첫 단계의 것으로 본다.
  checks.push([
    '리스트에 단축키 힌트 표시(R3.8 재배치 반영)',
    f4c.listHints.includes('Ctrl+Shift+W') && f4c.listHints.includes('Ctrl+Shift+D')
  ])
  // 2026-08-18(준영님 지적): 터미널에서 사람이 실제로 누르는 건 Ctrl+C/V 다. 메뉴가 **안 쓰는
  // 조합을 가르치고 있었다** — KEYMAP 의 Ctrl+Shift 계열은 그대로 살아 있고 표기만 바꿨다.
  checks.push([
    'R3.1: 우클릭 복사/붙여넣기에 Ctrl+C/V 힌트',
    f4c.listHints.includes('Ctrl+C') && f4c.listHints.includes('Ctrl+V')
  ])
  // 2026-08-14: 마지막 흐린 항목(로그 저장)이 실배선돼 이제 흐린 항목이 하나도 없다.
  checks.push(['흐린(추후) 항목 0 + 패널 닫기 위험 톤', f4c.listDim === 0 && f4c.listDanger === 1])
  checks.push(['ESC → 리스트 닫힘', f4c.listClosed === true])
  checks.push(['R1.4: 탭바 우클릭 스타일 토글 버튼 제거', f4c.toggleGone === true])
  checks.push(['R5: 탭바 폰트·단축키 버튼 제거(설정으로 통합)', f4c.tabbarToolsGone === true])
  checks.push(['FB-ui2: 타이틀바 기어 제거', f4c.gearGoneFromTitlebar === true])
  checks.push(['FB-ui2: 우측 액티비티 바에 설정 아이콘', f4c.settingsInActivityBar === true])
  checks.push(['#67: 우클릭은 리스트 하나뿐(라디얼·팔레트 DOM 자체가 없다)', f4c.stillList === true])
  checks.push(['#67: Ctrl+K 는 앱 키가 아니다(셸로 통과)', f4c.ctrlKFree === true])
  checks.push(['터미널 입력 중 ? 는 셸로(치트시트 안 열림)', f4c.csBlockedWhileTyping === true])
  checks.push(['? → 치트시트 열림', f4c.csOpen === true])
  checks.push(['치트시트 4열', f4c.csCols === 4])
  checks.push(['치트시트 keymap 행 렌더(>=15)', f4c.csRows >= 15])
  checks.push(['ESC → 치트시트 닫힘', f4c.csClosed === true])

  // ── F5 어서션 ── 번들 @font-face 로드 / 드로어 열림 / 폰트·크기 전환 반영 / 영속.
  const f5 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    // 번들 폰트가 CDN 없이 로컬 로드되었는지: document.fonts 로 실제 로드 확인(오프라인 실증).
    // UI-font(2026-08-04): 기본 --mono/--term이 이제 나눔고딕코딩 1순위라 JetBrains Mono는
    // 기본 화면에서 더는 쓰이지 않는다(전에는 --mono 1순위였던 게 버그 — 이번에 고쳤다).
    // "오프라인에서도 로드 가능"을 검증하는 게 이 체크의 취지라, 사용 여부와 무관하게
    // document.fonts.load로 명시 로드를 요청해 확인한다(라틴 폰트 선택 시에도 그대로 유효).
    await document.fonts.ready
    await document.fonts.load('13px "JetBrains Mono"')
    const nanumLoaded = document.fonts.check('13px "Nanum Gothic Coding"')
    const d2Loaded = document.fonts.check('13px "D2Coding"')
    const jbLoaded = document.fonts.check('13px "JetBrains Mono"')
    const pretendardLoaded = document.fonts.check('13px "Pretendard"')
    // @font-face src 가 로컬 assets(번들)인지 — CDN(http) 참조가 없어야 함.
    const faces = [...document.fonts].map(f => f.family)
    // R5→FB-ui2: 설정 창 열기 — 탭바 버튼도, 타이틀바 기어도 사라졌으므로 우측 액티비티 바(진입점 ①)를 쓴다.
    document.querySelector('.act-item[data-activity="settings"]')?.click()
    await wait(350)
    const drawerOpen = !!document.querySelector('.drawer.open')
    // 좌측 nav 8섹션(W2 [로그] · W3 [AI] · F23 [MCP] 추가) → [폰트] 로 전환해야 아래 폰트 UI 가 보인다.
    const navSections = [...document.querySelectorAll('.drawer.open .set-nav span')].map(s => s.dataset.section)
    // W3 F16: [AI] 섹션에 반출 고지 문구가 실제로 그려지는지(설계 §4.7 — 사내 배포 필수 문구).
    document.querySelector('.drawer.open .set-nav span[data-section="ai"]')?.click()
    await wait(200)
    const aiNote = document.querySelector('.drawer.open [data-note="ai.export"]')?.textContent || ''
    const aiKeyField = document.querySelector('.drawer.open input[data-field="ai.key"]')
    // 저장된 키를 되읽어 채우지 않는다 — 필드는 언제 열어도 비어 있어야 한다.
    const aiKeyEmpty = aiKeyField?.value === '' && aiKeyField?.type === 'password'
    // W5: 모델 추천 칩은 .ai-model-ctl 안에만 있다(스코프로 provider Seg 와 구분).
    // provider 는 **자기 이름으로** 집는다(#150): 전에는 "그 밖의 .seg-ctl" 이었는데 [AI] 섹션에
    // AI CLI 고르기 세그먼트(claude/codex/gemini)가 생기면서 그것까지 프로바이더로 셌다.
    const aiModels = [...document.querySelectorAll('.drawer.open .ai-model-ctl .seg-ctl button')].map(b => b.dataset.value)
    const aiProviders = [...document.querySelectorAll('.drawer.open .seg-ctl[data-field="ai.provider"] button')]
      .map(b => b.dataset.value)
    document.querySelector('.drawer.open .set-nav span[data-section="font"]')?.click()
    await wait(200)
    const compareRows = document.querySelectorAll('.drawer.open .fc-strip .fc-row').length
    const fontItems = document.querySelectorAll('.drawer.open .font-list .font-item').length
    const previewLines = document.querySelectorAll('.drawer.open .preview-box .pv-ln').length
    // 라이선스 고지는 R5 에서 [정보] 섹션으로 옮겼다 — 세어 본 뒤 다시 [폰트] 로 돌아온다.
    document.querySelector('.drawer.open .set-nav span[data-section="about"]')?.click()
    await wait(200)
    const licenseRows = document.querySelectorAll('.drawer.open .license-list .license-row').length
    const aboutVersion = /v\\d/.test(document.querySelector('.drawer.open .set-pane .sr-ctl .v')?.textContent || '')
    document.querySelector('.drawer.open .set-nav span[data-section="font"]')?.click()
    await wait(200)
    // 미리보기가 실사용 한글(알파벳 예시 아님) 포함.
    const previewText = document.querySelector('.drawer.open .preview-box .pb-body')?.textContent || ''
    const koreanPreview = /백업|데이터베이스|결제|승인/.test(previewText)
    // 크기 슬라이더 범위 = 10–20.
    const sizeSlider = document.querySelector('.drawer.open .fp-controls input[type=range]')
    const sizeMin = sizeSlider?.min, sizeMax = sizeSlider?.max
    // 폰트 전환: D2Coding 선택 → --term CSS 변수에 D2Coding 반영 + workspace 영속.
    const d2Item = [...document.querySelectorAll('.drawer.open .font-list .font-item')].find(f => /D2Coding/.test(f.textContent))
    if (d2Item) d2Item.click()
    await wait(300)
    const termVarAfterPick = getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
    // 크기 변경: 슬라이더 → 18px → --tt 바인딩(sizePx↔--tt).
    if (sizeSlider) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(sizeSlider, '18'); sizeSlider.dispatchEvent(new Event('change', { bubbles: true }))
      sizeSlider.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(300)
    const ttVarAfterSize = getComputedStyle(document.documentElement).getPropertyValue('--tt').trim()
    // 영속: main 에 저장된 폰트를 재로드(재시작 지속성 유사).
    const persisted = (await window.ev.workspace.load()).ui.font
    return {
      nanumLoaded, d2Loaded, jbLoaded, pretendardLoaded, faces,
      drawerOpen, navSections, aboutVersion, compareRows, fontItems, previewLines, licenseRows, koreanPreview,
      sizeMin, sizeMax, termVarAfterPick, ttVarAfterSize, persisted,
      aiNote, aiKeyEmpty, aiModels, aiProviders,
      // ★ AI-11: preload 표면에 키를 읽어 갈 창구가 없다. 계약(EvApi.ai)에 getKey 가 없다는 것을
      // 타입이 아니라 **런타임 객체**로 확인한다 — 빌드된 preload 가 실제로 그렇게 노출하는지가 관건이다.
      aiSurface: Object.keys(window.ev?.ai ?? {}).sort()
    }
  })()`)

  checks.push(['번들 나눔고딕코딩 로드(오프라인)', f5.nanumLoaded === true])
  checks.push(['번들 D2Coding 로드(오프라인)', f5.d2Loaded === true])
  checks.push(['번들 JetBrains Mono 로드(오프라인)', f5.jbLoaded === true])
  checks.push(['번들 Pretendard(UI) 로드(오프라인)', f5.pretendardLoaded === true])
  checks.push(['설정 창 열림(우측 액티비티 바)', f5.drawerOpen === true])
  checks.push([
    // F23 이 [MCP] 섹션을 추가하면서 여기 어서션 갱신을 빠뜨려 8섹션인데 7섹션을 기대하고 있었다 — 정리.
    'R5+W2+W3+F23: 좌측 nav 8섹션(일반/터미널/폰트/로그/AI/MCP/단축키/정보)',
    f5.navSections.join(',') === 'general,terminal,font,log,ai,mcp,keys,about'
  ])
  // ── W3 F16 아라 어서션 (W5 멀티 프로바이더로 갱신) ──
  // 반출 고지가 선택된 프로바이더 이름·호스트를 담는다(고정 "Anthropic API로 전송" 문구는 이제 거짓일 수 있다).
  //
  // #150: 아래 넷은 `AI_CHAT` 으로 막혀 **한 번도 돈 적이 없다.** 그런데 이 섹션을 그리는 문은
  // SettingsDrawer 의 `AI_ENTRY`(= AI_CHAT || ARA_CHAT)다 — 검사할 것이 화면에 멀쩡히 있는데
  // 검사만 건너뛰고 있었다(실패가 아니라 침묵이라 실패 목록에도 안 잡혔다).
  // **제품이 무엇으로 문을 잠그는지를 그대로 쓴다.**
  if (AI_ENTRY)
  checks.push(['F16→W5: 설정 [AI] 데이터 반출 고지에 현재 프로바이더·호스트가 들어간다', /Anthropic Claude API\(api\.anthropic\.com\)\s*로 전송/.test(f5.aiNote)])
  if (AI_ENTRY)
  checks.push(['F16: API 키 입력이 password 이고 저장된 키를 되읽지 않음', f5.aiKeyEmpty === true])
  if (AI_ENTRY)
  checks.push(['W5: 프로바이더 세그먼트 4종(anthropic/openai/google/compatible)', f5.aiProviders.join(',') === 'anthropic,openai,google,compatible'])
  if (AI_ENTRY)
    checks.push([
      'W5: 기본 프로바이더(anthropic) 모델 추천 칩 3종(sonnet-5/opus-5/haiku-4.5) — 자유 입력도 항상 허용',
      f5.aiModels.join(',') === 'claude-sonnet-5,claude-opus-5,claude-haiku-4-5'
    ])
  checks.push([
    'F16 ★: window.ev.ai 표면에 getKey 부재 (키를 읽어 갈 창구 없음)',
    f5.aiSurface.join(',') === 'cancel,clear,getState,onDelta,onEnd,send,setKey'
  ])
  checks.push(['R5: [정보] 섹션에 앱 버전 표기', f5.aboutVersion === true])
  checks.push(['비교 스트립 후보 4행 렌더', f5.compareRows === 4])
  checks.push(['폰트 리스트 3종 렌더', f5.fontItems === 3])
  checks.push(['실사용 한글 미리보기(알파벳 아님)', f5.koreanPreview === true])
  checks.push(['미리보기 라인 6줄', f5.previewLines === 6])
  // FINISH-M6(2026-08-30): 4 → 5. FINISH-M4 가 심볼 폰트를 번들에 실었는데 고지 표는 넷에 멈춰
  // 있었다(그 폰트만 고지 없이 나갈 뻔했다). **이 숫자는 이제 부차적이다** — 표와 실제 배포물
  // (resources/fonts/OFL-*.txt)이 어긋나면 tests/fontLicenses.test.ts 가 먼저 잡는다.
  checks.push(['OFL 라이선스 고지 5종', f5.licenseRows === 5])
  checks.push(['크기 슬라이더 10–20px', f5.sizeMin === '10' && f5.sizeMax === '20'])
  checks.push(['폰트 전환 → --term 반영(D2Coding)', /D2Coding/.test(f5.termVarAfterPick)])
  checks.push(['크기 변경 → --tt 바인딩(18px)', f5.ttVarAfterSize === '18px'])
  checks.push(['폰트 설정 영속(D2Coding 18px)', f5.persisted && f5.persisted.term === 'D2Coding' && f5.persisted.sizePx === 18])

  // ── 실사용 UX 라운드1 어서션 (2026-08-03) ──
  // 네이티브 컨트롤(<select>/confirm/alert) 전면 제거 + 트리 우클릭 메뉴 + 로컬 셸 발견성.
  const ux = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    // 네이티브 다이얼로그가 한 번이라도 불리면 기록(앱 코드가 호출하면 안 된다).
    window.__nativeDlg = []
    window.confirm = (m) => { window.__nativeDlg.push(['confirm', m]); return false }
    window.alert = (m) => { window.__nativeDlg.push(['alert', m]) }
    window.prompt = (m) => { window.__nativeDlg.push(['prompt', m]); return null }
    // 설정 드로어 닫기(F5 에서 열어둠).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(200)

    const ctx = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
    const menuItems = () => [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    const closeMenu = async () => { document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await wait(150) }

    // 1) 서버 노드 우클릭 → 6항목 컨텍스트 메뉴(삭제는 danger).
    const srv = document.querySelector('.tree .srv-node:not(.new-local)')
    if (srv) ctx(srv, 200, 200)
    await wait(200)
    const serverMenu = menuItems()
    const dangerCount = document.querySelectorAll('.ctx-menu .ctx-item.danger').length
    // 키보드 접근: ↓ 로 하이라이트 이동.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wait(120)
    const kbdCursor = document.querySelectorAll('.ctx-menu .ctx-item.cur').length
    await closeMenu()
    const menuClosedByBackdrop = document.querySelectorAll('.ctx-menu').length === 0

    // 2) 세션 행 / 그룹 헤더 우클릭.
    // 세션 메뉴는 SSH 세션에서만 tmux 항목이 붙는다 — 로컬 카드가 먼저 와도 SSH 카드를 집는다.
    const sessRow =
      [...document.querySelectorAll('.tree .sess-list .sess-node')].find(
        (n) => n.querySelector('.sess-type')?.textContent === 'SSH'
      ) || document.querySelector('.tree .sess-list .sess-node')
    if (sessRow) ctx(sessRow, 200, 240)
    await wait(200)
    const sessionMenu = menuItems()
    await closeMenu()
    const grpHd = document.querySelector('.tree .srv-hd')
    if (grpHd) ctx(grpHd, 200, 160)
    await wait(200)
    const groupMenu = menuItems()
    await closeMenu()

    // 3) 로컬 터미널 발견성: 트리 "＋ 새 로컬 셸" 행 + 탭바 ＋ 좌클릭(원클릭 로컬 셸, UI-tabbar) + 우클릭 보조 메뉴(SSH).
    const newLocalRow = !!document.querySelector('.tree .srv-node.new-local')
    const localGroupAlways = [...document.querySelectorAll('.tree .srv-hd')].some(h => /로컬/.test(h.textContent))
    const addBtn = document.querySelector('.tterm-add')
    const tabsBeforeAdd = document.querySelectorAll('.term-tabbar .ttab').length
    if (addBtn) addBtn.click()
    await wait(600)
    const tabsAfterAddClick = document.querySelectorAll('.term-tabbar .ttab').length
    const addClickNoMenu = document.querySelectorAll('.ctx-menu').length === 0
    if (addBtn) ctx(addBtn, 0, 0)
    await wait(200)
    const addMenu = menuItems()
    const addMenuLabels = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.textContent).join('|')
    await closeMenu()

    // 4) 네이티브 <select> 전멸 + 커스텀 콤보 동작(연결 관리자 그룹 필드 — R6 부터 타이핑 가능).
    // R4.1: Session 드롭다운 → 연결 관리자 항목.
    const sessionMenuBtn = [...document.querySelectorAll('.tb-menu span')].find(s => s.textContent === '세션')
    if (sessionMenuBtn) sessionMenuBtn.click()
    await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="connection.manager"]')?.click()
    await wait(300)
    const nativeSelects = document.querySelectorAll('select').length
    // R6: 그룹 필드는 콤보 입력이다(값 표시부가 input). 선택지는 프로필들의 group 에서 파생 —
    // 앱이 정해 주던 ['개발','운영'] 하드코딩이 사라졌다.
    const ddInput = document.querySelector('.prof-form .dd.editable .dd-input')
    const ddEditable = !!ddInput
    const ddBefore = ddInput?.value || ''
    document.querySelector('.prof-form .dd .dd-caret')?.click()
    await wait(180)
    const ddOptions = [...document.querySelectorAll('.prof-form .dd .dd-list .dd-opt')].map(o => o.textContent)
    const other = [...document.querySelectorAll('.prof-form .dd .dd-list .dd-opt')].find(o => o.textContent !== ddBefore)
    if (other) other.click()
    await wait(180)
    const ddAfter = document.querySelector('.prof-form .dd .dd-input')?.value || ''
    // 새 그룹 타이핑: 목록에 없는 이름도 그대로 값이 된다(입력 = 새 그룹 생성 경로).
    const setInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const ddTypeTarget = document.querySelector('.prof-form .dd .dd-input')
    if (ddTypeTarget) {
      setInput.call(ddTypeTarget, '새그룹타이핑')
      ddTypeTarget.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(180)
    const ddTyped = document.querySelector('.prof-form .dd .dd-input')?.value || ''
    // 신규 프로필(＋): 폼이 비워져야 한다. 예전에는 열림 effect 가 곧바로 첫 프로필로 되돌려
    // 두 번째 프로필을 만들 수 없었다(2026-08-03 회귀 방지).
    const nameInput = () => document.querySelector('.prof-form .fld input')
    const nameBeforeNew = nameInput()?.value || ''
    document.querySelector('.prof-list .pl-add')?.click()
    await wait(300)
    const nameAfterNew = nameInput()?.value || ''
    const noProfileSelected = document.querySelectorAll('.prof-list .prof.sel').length === 0
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(200)

    // 트리 "정보 수정" → 그 프로필이 선택된 채로 연결 관리자가 열린다.
    const srv2 = document.querySelector('.tree .srv-node:not(.new-local)')
    if (srv2) ctx(srv2, 200, 200)
    await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="server.edit"]')?.click()
    await wait(400)
    const editOpened = !!document.querySelector('.overlay.open .modal')
    const editName = nameInput()?.value || ''
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(200)

    // 5) 호스트키 최초 접속 → 커스텀 모달(네이티브 confirm 아님) + 지문 표시 + "신뢰하고 연결".
    const { profile: hkProfile } = await window.ev.profile.save({
      name: 'hostkey-smoke', host: '10.9.9.10', port: 22, username: 'deploy',
      authType: 'password', secret: 'SMOKE_PLAINTEXT_SECRET', group: '개발'
    })
    const hkConnect = window.__evConnect(hkProfile.id)
    await wait(400)
    const hkModal = !!document.querySelector('.overlay .modal.sm')
    const hkText = document.querySelector('.overlay .modal.sm')?.textContent || ''
    const hkFingerprint = /SHA256:SMOKEFINGERPRINT/.test(hkText)
    const hkTrustBtn = [...document.querySelectorAll('.overlay .modal.sm .btn')].find(b => /신뢰하고 연결/.test(b.textContent))
    if (hkTrustBtn) hkTrustBtn.click()
    const hkConnected = await hkConnect
    await wait(300)

    // 6) 인증 실패 → 사유가 구분된 커스텀 다이얼로그 + "비밀번호 다시 입력" 경로.
    const { profile: afProfile } = await window.ev.profile.save({
      name: 'authfail-smoke', host: '10.9.9.11', port: 22, username: 'deploy',
      authType: 'password', secret: 'SMOKE_PLAINTEXT_SECRET', group: '개발'
    })
    const afConnect = window.__evConnect(afProfile.id)
    await wait(400)
    const afText = document.querySelector('.overlay .modal.sm')?.textContent || ''
    const afHasReason = /인증 실패/.test(afText)
    const afHasServerDetail = /deploy@10\\.9\\.9\\.11:22/.test(afText)
    const afHasRawDetail = /authentication methods failed/.test(afText)
    const afReauthBtn = [...document.querySelectorAll('.overlay .modal.sm .btn')].some(b => /비밀번호 다시 입력/.test(b.textContent))
    const afOk = [...document.querySelectorAll('.overlay .modal.sm .btn')].find(b => b.textContent.trim() === '확인')
    if (afOk) afOk.click()
    const afConnected = await afConnect
    await wait(250)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(200)

    return {
      serverMenu, dangerCount, kbdCursor, menuClosedByBackdrop, sessionMenu, groupMenu,
      newLocalRow, localGroupAlways, tabsBeforeAdd, tabsAfterAddClick, addClickNoMenu, addMenu, addMenuLabels,
      nativeSelects, ddEditable, ddBefore, ddOptions, ddAfter, ddTyped,
      nameBeforeNew, nameAfterNew, noProfileSelected, editOpened, editName,
      hkModal, hkFingerprint, hkConnected,
      afHasReason, afHasServerDetail, afHasRawDetail, afReauthBtn, afConnected,
      nativeDlg: window.__nativeDlg
    }
  })()`)

  // FB-monitor(F19 tmux 후속): 이 서버 밑에 연결된 SSH 세션이 있어(첫 프로필은 ssh:connect 가 성공시킨다)
  // 서버·세션 메뉴 둘 다 끝에 tmux 서브메뉴 항목(session.tmux)이 하나씩 더 붙는다(6→7 / 3→4).
  // 2026-08-18: 'aicli.start' 를 **뺐다**(창을 없애면서 — 서버 행에는 폴더도 세션도 없어
  // 물어볼 곳이 사라졌다. 붙은 뒤 터미널 우클릭이 그 자리다) → 8 → 7항목.
  // #131 에서 **되돌아왔다**: 서버 행에서 바로 작업대를 연다(그 자리가 이미 아는 것은 묻지 않고,
  // 폴더는 그 서버에 붙었을 때의 홈으로 잡는다 — actions.tsx:290). newSession 다음 자리다 → 8항목.
  checks.push(['트리 서버 노드 우클릭 → 컨텍스트 메뉴 8항목(작업대·tmux 포함)', ux.serverMenu.length === 8])
  checks.push(['서버 메뉴 항목 구성(연결/새세션/작업대/수정/복제/호스트키/삭제/tmux)', ux.serverMenu.join(',') === 'server.connect,server.newSession,aicli.start,server.edit,server.duplicate,server.forgetHostKey,server.delete,session.tmux'])
  checks.push(['삭제 항목만 위험 톤', ux.dangerCount === 1])
  checks.push(['컨텍스트 메뉴 키보드 이동(↑↓)', ux.kbdCursor === 1])
  checks.push(['바깥 클릭으로 메뉴 닫힘', ux.menuClosedByBackdrop === true])
  // R2.1: 트리 세션 메뉴에 "이름 변경"이 추가됐다(탭 더블클릭과 같은 인라인 편집을 연다).
  // 2026-08-17 제보 ①: 셋뿐이라 "여기서 할 게 없다"였다 — **그 세션이 서 있는 폴더**를 쓰는
  // 셋을 더했다(복제·AI CLI 시작·즐겨찾기 저장). 서버 행에서 열면 폴더를 다시 골라야 한다.
  checks.push([
    '세션 행 우클릭 → 전환/복제/AI CLI/즐겨찾기/이름 변경/종료/tmux 7항목',
    ux.sessionMenu.join(',') ===
      'session.focus,session.duplicate,aicli.start,work.save,session.rename,session.close,session.tmux'
  ])
  // R6: 그룹 헤더 메뉴에 이름 변경·삭제가 붙었다(smoke 프로필은 전부 '개발' 그룹이라 실그룹 메뉴가 뜬다).
  checks.push([
    'R6: 그룹 헤더 우클릭 → 새 연결 / 이름 변경 / 삭제',
    ux.groupMenu.join(',') === 'group.newConn,group.rename,group.delete'
  ])
  checks.push(['R1.3: 트리 "＋ 새 로컬 셸" 행 제거(빈 영역 우클릭으로 이동)', ux.newLocalRow === false])
  checks.push(['로컬 그룹 상시 표시(세션 없어도)', ux.localGroupAlways === true])
  checks.push(['탭바 ＋ 좌클릭 → 메뉴 없이 로컬 셸 1개 생성', ux.addClickNoMenu && ux.tabsAfterAddClick === ux.tabsBeforeAdd + 1])
  // ＋ 는 세션을 **만드는** 자리다. AI CLI 는 이미 붙어 있는 세션의 폴더에서 띄우는 것이라
  // 여기 있을 이유가 없었다(2026-08-18 창 제거와 함께 뺐다).
  checks.push(['탭바 ＋ 우클릭 → 로컬 셸/SSH 연결 보조 메뉴', ux.addMenu.join(',') === 'local.new,ssh.open'])
  checks.push(['＋ 보조 메뉴에 로컬 셸 진입점 문구', /로컬 셸/.test(ux.addMenuLabels) && /SSH/.test(ux.addMenuLabels)])
  checks.push(['앱 전체에 네이티브 <select> 없음', ux.nativeSelects === 0])
  checks.push(['R6: 그룹 필드가 콤보 입력(타이핑 가능)', ux.ddEditable === true])
  checks.push([
    'R6: 그룹 선택지는 프로필에서 파생(하드코딩 개발/운영 제거)',
    ux.ddOptions.length > 0 && ux.ddOptions.every((o) => o === '개발')
  ])
  checks.push(['커스텀 드롭다운 선택 반영', ux.ddAfter.length > 0])
  checks.push(['R6: 목록에 없는 새 그룹 이름을 직접 입력할 수 있다', ux.ddTyped === '새그룹타이핑'])
  checks.push(['＋ 신규 프로필 → 폼 비움(첫 프로필로 되돌아가지 않음)', ux.nameBeforeNew.length > 0 && ux.nameAfterNew === ''])
  checks.push(['＋ 신규 프로필 → 리스트 선택 해제', ux.noProfileSelected === true])
  checks.push(['트리 "정보 수정" → 연결 관리자 열림', ux.editOpened === true])
  checks.push(['"정보 수정" → 해당 프로필이 폼에 로드', ux.editName.length > 0])
  checks.push(['호스트키 최초 접속 → 커스텀 모달(.modal.sm)', ux.hkModal === true])
  checks.push(['호스트키 모달에 SHA256 지문 표시', ux.hkFingerprint === true])
  checks.push(['"신뢰하고 연결" → 접속 성공', ux.hkConnected === true])
  checks.push(['인증 실패 → 사유 구분 표시("인증 실패")', ux.afHasReason === true])
  checks.push(['실패 다이얼로그에 서버 정보 표시', ux.afHasServerDetail === true])
  checks.push(['실패 다이얼로그에 서버 원문 사유 표시', ux.afHasRawDetail === true])
  checks.push(['인증 실패 → "비밀번호 다시 입력" 경로 제공', ux.afReauthBtn === true])
  checks.push(['인증 실패 시 접속 false 반환(크래시 없음)', ux.afConnected === false])
  checks.push(['네이티브 confirm/alert/prompt 미사용', Array.isArray(ux.nativeDlg) && ux.nativeDlg.length === 0])

  // ── R1 재현 어서션 (고도화 라운드 1) ──
  // ① 세션 전환 후 스크롤백 보존 ② 단일 패널 × → 빈 상태 ③ 서버 노드 더블클릭 = 세션 1개 ④ 사이드바 빈 영역 우클릭 메뉴.
  // 깨끗한 상태에서 재현하려고 렌더러를 재로드한다(SNAP.seed 미설정 = 빈 시작).
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1200))

  const r1 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const isWin = navigator.userAgent.includes('Windows')
    const echo = (id, text) => window.ev.session.input(id, 'echo ' + text + (isWin ? '\\r\\n' : '\\n'))
    // 화면에 보이는 패널들의 텍스트(숨김 패널 제외) — xterm 스크롤백이 살아 있는지 판정.
    // R3.4 WebGL 렌더러가 붙으면 내용이 canvas 로 가서 DOM textContent 가 비므로 버퍼에서 직접 읽는다.
    const shown = () => [...document.querySelectorAll('.pane-grid .pane')]
      .filter((p) => getComputedStyle(p).display !== 'none')
      .map((p) => {
        const id = p.dataset.sessionId
        return (id && window.__evTerm(id)?.text()) || p.textContent || ''
      }).join('\\n')
    const paneCount = () => document.querySelectorAll('.pane-grid .pane').length
    // 세션을 만들고 렌더러 스토어에 편입(=포커스 패널에 표시). id 를 알아야 입력을 넣을 수 있어 seam 사용.
    const openSession = async (title) => {
      const { id } = await window.ev.session.create({ type: 'local', title, serverKey: 'localhost', profileId: null })
      window.__evAdopt(id, title, 'localhost', 'local')
      await wait(800)
      return id
    }
    // 탭은 세션 id 로 고른다 — R3.6 이후 셸이 보낸 OSC 제목으로 라벨이 바뀔 수 있어 이름 검색은 깨진다.
    const clickTab = async (id) => {
      document.querySelector('.term-tabbar .ttab[data-session-id="' + id + '"]')?.click()
      await wait(500)
    }

    // ① 세션 A 출력 → 같은 패널에서 B 로 전환 → A 복귀 → A 버퍼 보존.
    const idA = await openSession('R1-A')
    echo(idA, 'R1버퍼A')
    await wait(1200)
    const aVisible = /R1버퍼A/.test(shown())
    const idB = await openSession('R1-B')
    echo(idB, 'R1버퍼B')
    await wait(1200)
    const bVisible = /R1버퍼B/.test(shown())
    await clickTab(idA)
    const aKept = /R1버퍼A/.test(shown())
    const aBuf = /R1버퍼A/.test(window.__evTerm(idA)?.text() || '')
    const aPaneVisible = [...document.querySelectorAll('.pane-grid .pane')]
      .some((p) => p.dataset.sessionId === idA && getComputedStyle(p).display !== 'none')
    // R3.6 회귀 방지: conpty 가 보내는 셸 경로 제목(C:\\WINDOWS\\SYSTEM32\\cmd.exe)이 탭 이름을
    // 덮어써 모든 로컬 탭이 같은 이름이 되면 안 된다.
    const tabLabels = [...document.querySelectorAll('.term-tabbar .ttab .tlabel')].map((x) => x.textContent)
    await clickTab(idB)
    const bKept = /R1버퍼B/.test(shown())

    // ①-2 분할 상태 교차 전환: 새 패널을 만든 뒤 그 패널을 A 로 교체 → 두 패널(B·A) 버퍼가 모두 남아야 한다.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(1400)
    const panesAfterSplit = paneCount()
    await clickTab(idA)
    const splitKept = /R1버퍼A/.test(shown()) && /R1버퍼B/.test(shown())

    // ② 칸 닫기(R9a: 그 칸의 세션 종료) — 마지막 하나까지 닫으면 패널이 0 이 되고 빈 화면 안내가 뜬다.
    // 이력(두 번 뒤집힌 자리): UI-tabbar(2026-08-04)가 여기 있던 [로컬 셸]/[SSH 연결] 버튼을
    // "탭바 ＋ 와 같은 경로라 중복"으로 없애면서 **안내 자체가 통째로** 사라졌고, 이 검사도
    // "안내가 없어야 한다"를 지키고 있었다. 2026-08-13 감사가 다시 지적했다 — 화면의 70% 가
    // 한 글자도 없이 비어 있다(#66-8). 지금 지키는 것은 **안내는 있고 버튼은 없다** 이다:
    // 중복 진입점을 만들지 않는다는 UI-tabbar 의 판단은 그대로 살린다.
    // 여기 세션은 전부 로컬이라 확인 다이얼로그는 안 뜬다.
    const closeFocused = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(200)
    await okDialog()
      await wait(500)
    }
    await closeFocused()
    const panesBeforeLast = paneCount()
    await closeFocused()
    const panesAfterLast = paneCount()
    const emptyGuide = document.querySelector('.pane-grid .pane-empty')
    const emptyState =
      document.querySelectorAll('.pane-grid .pane').length === 0 &&
      !!emptyGuide &&
      emptyGuide.textContent.includes('＋') &&
      emptyGuide.querySelectorAll('button').length === 0

    // ③ 서버 노드 더블클릭 → 새 세션 정확히 1개(원클릭은 선택/포커스만).
    // 카드형 트리 개편 후 세션 카드는 서버 노드 아래가 아니라 위쪽 [열린 세션] 섹션에 산다 —
    // 그 서버의 묶음은 data-server 로 찾는다(예전엔 서버 노드의 형제 .sess-list 였다).
    // 세션 카드는 서버 카드 아래에 붙는다 — 그 서버의 묶음은 data-server 로 찾는다.
    const srvSessRows = (name) =>
      document.querySelectorAll('.tree .srv-group[data-server="' + name + '"] .sess-node').length
    const srv = [...document.querySelectorAll('.tree .srv-node')].find((n) => n.textContent.includes('smoke-dev'))
    const dblBefore = srvSessRows('smoke-dev')
    if (srv) {
      srv.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      srv.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      srv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    }
    await wait(1600)
    const dblAfter = srvSessRows('smoke-dev')

    // ④ 사이드바 빈 영역 우클릭 → 새 로컬 셸 / 새 연결 / 새 그룹.
    const tree = document.querySelector('.sb-panel.active .tree') || document.querySelector('.tree')
    if (tree) tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 620 }))
    await wait(350)
    const sidebarMenu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map((i) => i.dataset.action)
    const tabsBeforeMenuLocal = document.querySelectorAll('.term-tabbar .ttab').length
    const localItem = document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')
    if (localItem) localItem.click()
    await wait(1000)
    const tabsAfterMenuLocal = document.querySelectorAll('.term-tabbar .ttab').length
    const panesAfterMenuLocal = paneCount()

    return {
      aVisible, bVisible, aKept, aBuf, aPaneVisible, tabLabels, bKept, panesAfterSplit, splitKept,
      panesBeforeLast, panesAfterLast, emptyState,
      dblBefore, dblAfter, sidebarMenu, tabsBeforeMenuLocal, tabsAfterMenuLocal, panesAfterMenuLocal
    }
  })()`)

  checks.push(['R1①: 세션 A 출력이 패널에 보인다', r1.aVisible === true])
  checks.push(['R1①: 같은 패널에서 세션 B 로 전환', r1.bVisible === true])
  checks.push(['R1①: A 로 복귀 시 A 버퍼 보존', r1.aKept === true && r1.aBuf === true])
  checks.push(['R1①: 탭 클릭이 그 세션 패널을 실제로 표시', r1.aPaneVisible === true])
  checks.push([
    'R3.6: conpty 셸 경로 제목이 탭 이름을 덮어쓰지 않는다',
    r1.tabLabels.length === 2 && r1.tabLabels.every((l) => !/\.exe$/i.test(l)) && new Set(r1.tabLabels).size === 2
  ])
  checks.push(['R1①: B 로 재전환 시 B 버퍼 보존', r1.bKept === true])
  checks.push(['R1①: 분할 상태 교차 전환에도 양쪽 버퍼 보존', r1.panesAfterSplit === 2 && r1.splitKept === true])
  checks.push(['R1②: 단일 패널 × → 패널 0', r1.panesBeforeLast === 1 && r1.panesAfterLast === 0])
  checks.push(['#66-8: 패널 0 이면 안내가 뜨고 버튼은 없다(진입점은 탭바 ＋ 하나)', r1.emptyState === true])
  checks.push(['R1③: 서버 노드 더블클릭 → 세션 정확히 1개', r1.dblAfter - r1.dblBefore === 1])
  checks.push([
    'R1④: 사이드바 빈 영역 우클릭 → 로컬 셸/새 연결/새 그룹/작업 프로필',
    r1.sidebarMenu.join(',') === 'local.new,ssh.open,group.new,work.open'
  ])
  checks.push([
    'R1④: 메뉴 "로컬 셸" → 세션·패널 생성',
    r1.tabsAfterMenuLocal === r1.tabsBeforeMenuLocal + 1 && r1.panesAfterMenuLocal === 1
  ])

  // ── R2 어서션 (고도화 라운드 2) ──
  // 분할이 배경 세션을 올리는지 / 방향 / 탭 이름 변경·저장 / 우클릭 메뉴 / 드래그 재정렬 / 죽은 단축키 / 창 컨트롤.
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1200))

  const r2 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const panes = () => document.querySelectorAll('.pane-grid .pane').length
    const visiblePanes = () => [...document.querySelectorAll('.pane-grid .pane')]
      .filter(p => getComputedStyle(p).display !== 'none').length
    const tabs = () => [...document.querySelectorAll('.term-tabbar .ttab')]
    const tabTexts = () => tabs().map(t => (t.querySelector('.tlabel') || t).textContent)
    const tracks = (v) => v.split(' ').filter(Boolean).length
    const key = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    const sessionCount = async () => (await window.ev.session.list()).length
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(200)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(900)
    }

    // ── R2.0 분할은 배경 탭을 올린다(새 셸 생성 0) ──
    await newLocal()          // 셸 1 → 패널 1
    await newLocal()          // 셸 2 → 같은 패널로 교체(셸 1 은 배경 탭)
    const beforeSplit = await sessionCount()
    const panesBeforeSplit = panes()
    key({ key: '-', ctrlKey: true, shiftKey: true })   // 가로 분할(R3.8 재배치)
    await wait(900)
    const afterSplitSessions = await sessionCount()
    const panesAfterSplit = panes()
    // 두 세션이 동시에 보인다 = 기존 창들이 나란히 배치됐다.
    const bothShown = visiblePanes() === 2
    // 가로 분할 = 상·하: 열 트랙 1개, 행 트랙 3개(위 / divider / 아래).
    const grid = document.querySelector('.pane-grid')
    const gs = getComputedStyle(grid)
    const hCols = tracks(gs.gridTemplateColumns), hRows = tracks(gs.gridTemplateRows)

    // 칸 하나 닫고(R9a: 그 세션도 함께 종료 — 로컬이라 확인 없음) 세로 분할 → 좌·우.
    key({ key: 'w', ctrlKey: true, shiftKey: true })
    await wait(200); await okDialog()
    await wait(500)
    const afterCloseSessions = await sessionCount()
    key({ key: '\\\\', ctrlKey: true, shiftKey: true })
    await wait(900)
    const gs2 = getComputedStyle(document.querySelector('.pane-grid'))
    const vCols = tracks(gs2.gridTemplateColumns), vRows = tracks(gs2.gridTemplateRows)
    // 분할은 배경 세션이 있으면 그걸 올린다(새 셸 안 만듦) — 첫 분할로 그걸 본다.
    // 두 번째 분할은 그 사이 칸 닫기로 여분 세션이 없어졌을 수 있어(R9a) 새 셸이 생기는 게 정상이다
    // — 배치할 게 없으면 만드는 것이 설계다(pickBackgroundSession null → 새 로컬 셸).
    const splitNoNewShell = afterSplitSessions === beforeSplit
    const secondSplitSessions = await sessionCount()
    const secondSplitAddedAtMostOne = secondSplitSessions <= afterCloseSessions + 1

    // 배경 탭이 하나도 없으면(모두 배치됨) 새 로컬 셸을 만든다 — 폴백 경로.
    const beforeFallback = await sessionCount()
    key({ key: '-', ctrlKey: true, shiftKey: true })
    await wait(1200)
    const fallbackMadeShell = (await sessionCount()) === beforeFallback + 1

    // ── R2.5 죽은 단축키 ──
    // Ctrl+Up 최대화: 패널은 그대로지만 보이는 건 하나.
    const panesNow = panes()
    key({ key: 'ArrowUp', ctrlKey: true })
    await wait(400)
    const maximized = visiblePanes() === 1 && panes() === panesNow
    key({ key: 'ArrowUp', ctrlKey: true })
    await wait(400)
    const restored = visiblePanes() === panesNow
    // 칸 헤더는 dot + 제목 + ×(세션 종료) 뿐이다 — R3.9 에서 걷어낸 타입 칩·분할·최대화 도구는
    // 돌아오면 안 되고, ×는 준영님 요청으로 되살렸다(탭 ×와 같은 경로).
    const headerBare =
      document.querySelectorAll('.pane-grid .pane .pane-hd .ptools, .pane-grid .pane .pane-hd .chip').length === 0 &&
      document.querySelectorAll('.pane-grid .pane .pane-hd .pdot').length > 0 &&
      document.querySelectorAll('.pane-grid .pane .pane-hd .ptitle').length > 0 &&
      document.querySelectorAll('.pane-grid .pane .pane-hd .px').length ===
        document.querySelectorAll('.pane-grid .pane').length

    // Ctrl+Tab / Ctrl+Shift+Tab 탭 순환(R3.8 재배치 — Ctrl+]/[ 는 셸에 돌려줬다).
    const activeText = () => document.querySelector('.term-tabbar .ttab.active .tlabel')?.textContent || ''
    const t0 = activeText()
    key({ key: 'Tab', ctrlKey: true }); await wait(400)
    const t1 = activeText()
    key({ key: 'Tab', ctrlKey: true, shiftKey: true }); await wait(400)
    const t2 = activeText()
    const tabCycle = t1 !== t0 && t2 === t0
    // Ctrl+1 → 첫 탭.
    key({ key: '1', ctrlKey: true }); await wait(400)
    const byNumber = activeText() === tabTexts()[0]
    // Ctrl+Shift+D 세션 복제(로컬 → 새 로컬 셸).
    const beforeDup = await sessionCount()
    key({ key: 'd', ctrlKey: true, shiftKey: true }); await wait(1200)
    const duplicated = (await sessionCount()) === beforeDup + 1
    // Ctrl+\` 터미널 토글(로컬 세션 사이 순환 — 이미 여러 개라 활성 탭이 바뀐다).
    const beforeToggle = activeText()
    key({ key: '\`', ctrlKey: true }); await wait(500)
    const terminalToggle = activeText() !== beforeToggle

    // ── R2.1 탭 이름 변경 ──
    const target = tabs()[0]
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(300)
    const editorOpen = !!document.querySelector('.term-tabbar .ttab .tt-edit')
    const input = document.querySelector('.term-tabbar .ttab .tt-edit')
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    if (input) {
      setValue(input, '결제 배포')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    await wait(400)
    const renamed = tabTexts()[0] === '결제 배포'
    // ESC 는 취소 — 이름이 유지된다.
    tabs()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(300)
    const input2 = document.querySelector('.term-tabbar .ttab .tt-edit')
    if (input2) {
      setValue(input2, '버려질 이름')
      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    await wait(400)
    const escKept = tabTexts()[0] === '결제 배포'
    // 저장: 스냅샷 sessions 에 바뀐 이름이 들어간다(재시작 후 유지의 근거).
    await window.__evPersist()
    await wait(300)

    // ── R2.2 탭 우클릭 메뉴 ──
    tabs()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 60 }))
    await wait(300)
    const tabMenu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    const tabMenuDanger = document.querySelectorAll('.ctx-menu .ctx-item.danger').length
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)

    // ── R2.3 탭 드래그 재정렬 ──
    const orderBefore = tabTexts()
    const dt = new DataTransfer()
    const drag = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    drag(tabs()[1], 'dragstart')
    await wait(120)
    drag(tabs()[0], 'dragover')
    drag(tabs()[0], 'drop')
    await wait(400)
    const orderAfter = tabTexts()
    const reordered = orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0]
    await window.__evPersist()
    await wait(300)

    // ── R2.5 치트시트에 미구현 항목 0 ──
    document.activeElement?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))
    await wait(350)
    const csLabels = [...document.querySelectorAll('.cheatsheet.open .cs-row .cs-desc')].map(d => d.textContent)
    const csRows = csLabels.length
    // 2026-08-14 로그 저장까지 실배선돼 미구현 목록이 비었다. 배열을 비워 두는 이유는 다음에
    // 미구현 항목이 생기면 여기 이름만 넣으면 되게 하려는 것이다(검사 구조는 그대로 쓴다).
    const csDead = csLabels.filter(l => [].includes(l)).length
    // 반대 방향도 확인한다: 배선된 AI 키가 치트시트에 실제로 올라왔는지(implemented 파생이 도는지).
    const csHasAi = ['AI에게 질문', 'AI 창 토글'].every(l => csLabels.includes(l))
    const csHasR3 = ['터미널 내 검색', '복사', '붙여넣기', '파일 트리 토글'].every(l => csLabels.includes(l))
    const csHasRevived = ['패널 최대화', '다음 탭', '탭 번호 이동', '세션 복제', '터미널 토글'].every(l => csLabels.includes(l))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(250)

    // ── R2.6 타이틀바 창 컨트롤 ──
    const ctlGlyphs = document.querySelectorAll('.tb-controls .tb-ctl svg').length
    const hasWindowApi = typeof window.ev?.window?.minimize === 'function'
      && typeof window.ev?.window?.toggleMaximize === 'function'
      && typeof window.ev?.window?.close === 'function'
    document.querySelector('.tb-ctl.min')?.click()
    document.querySelector('.tb-ctl.max')?.click()
    document.querySelector('.tb-ctl.close')?.click()
    await wait(400)

    return {
      panesBeforeSplit, panesAfterSplit, bothShown, splitNoNewShell, secondSplitAddedAtMostOne, fallbackMadeShell,
      hCols, hRows, vCols, vRows,
      maximized, restored, headerBare, tabCycle, byNumber, duplicated, terminalToggle,
      editorOpen, renamed, escKept, tabMenu, tabMenuDanger, orderBefore, orderAfter, reordered,
      csRows, csDead, csHasAi, csHasR3, csHasRevived, ctlGlyphs, hasWindowApi
    }
  })()`)

  checks.push(['R2.0: 분할 전 패널 1개(두 번째 세션은 배경 탭)', r2.panesBeforeSplit === 1])
  checks.push(['R2.0: 분할 → 패널 2개', r2.panesAfterSplit === 2])
  checks.push(['R2.0: 기존 세션 2개가 동시에 보인다', r2.bothShown === true])
  checks.push(['R2.0: 분할이 새 셸을 만들지 않는다(배경 세션 배치)', r2.splitNoNewShell === true])
  checks.push(['R2.0: 여분 세션이 없어진 뒤 분할은 셸을 한 개까지만 만든다', r2.secondSplitAddedAtMostOne === true])
  checks.push(['R2.0: 배경 세션이 없으면 새 로컬 셸(폴백)', r2.fallbackMadeShell === true])
  checks.push(['R2.0: 가로 분할 = 상·하 배치(1열 2행)', r2.hCols === 1 && r2.hRows === 3])
  checks.push(['R2.0: 세로 분할 = 좌·우 배치(2열 1행)', r2.vCols === 3 && r2.vRows === 1])
  checks.push(['R2.5: Ctrl+↑ 최대화(보이는 패널 1개)', r2.maximized === true])
  checks.push(['R2.5: Ctrl+↑ 재입력 → 원복', r2.restored === true])
  checks.push(['칸 헤더 = dot + 제목 + ×(칩·분할·최대화 도구는 없음)', r2.headerBare === true])
  checks.push(['R2.5: Ctrl+Tab / Ctrl+Shift+Tab 탭 순환', r2.tabCycle === true])
  checks.push(['R2.5: Ctrl+1 탭 번호 이동', r2.byNumber === true])
  checks.push(['R2.5: Ctrl+Shift+D 세션 복제', r2.duplicated === true])
  checks.push(['R2.5: Ctrl+` 터미널 토글', r2.terminalToggle === true])
  checks.push(['R2.1: 탭 더블클릭 → 인라인 편집', r2.editorOpen === true])
  checks.push(['R2.1: Enter 로 이름 확정', r2.renamed === true])
  checks.push(['R2.1: ESC 는 취소(기존 이름 유지)', r2.escKept === true])
  checks.push([
    'R2.1: 바뀐 이름이 스냅샷에 저장된다(재시작 유지)',
    !!SNAP.saved && SNAP.saved.sessions.some((s) => s.title === '결제 배포')
  ])
  // F32(2026-08-17): [새 창으로 떼어내기]가 붙었다 — 탭을 별도 OS 창으로 빼서 다른 모니터에 놓는다.
  checks.push([
    'R2.2: 탭 우클릭 → 이름 변경/복제/새 창으로/닫기/다른 탭 모두 닫기',
    r2.tabMenu.join(',') ===
      'session.rename,session.duplicate,session.detach,session.close,session.closeOthers'
  ])
  checks.push(['R2.2: "다른 탭 모두 닫기"만 위험 톤', r2.tabMenuDanger === 1])
  checks.push(['R2.3: 드래그로 탭 순서 교체', r2.reordered === true])
  checks.push([
    'R2.3: 바뀐 탭 순서가 스냅샷에 저장된다',
    !!SNAP.saved && SNAP.saved.sessions.map((s) => s.title).join(',').startsWith(r2.orderAfter.slice(0, 2).join(','))
  ])
  checks.push([
    'BLOCKER-1: workspace:save 가 main 소유 필드(profiles·knownHosts·ui)를 되돌려 보내지 않는다',
    SNAP.wideSave.size === 0
  ])
  checks.push(['R2.5: 치트시트에 미구현 항목 0', r2.csDead === 0])
  // #150 과 같은 침묵이 여기에도 하나 더 있었다. 치트시트에 이 두 줄이 뜨는 문은 keymap.ts:135 의
  // `AI_ENTRY` 다 — 줄은 뜨는데 검사만 안 돌고 있었다.
  if (AI_ENTRY)
  checks.push(['F16: 배선된 AI 단축키 2종이 치트시트에 올라온다', r2.csHasAi === true])
  checks.push(['R3.8: 치트시트가 새로 배선된 검색·클립보드·파일 트리를 싣는다', r2.csHasR3 === true])
  checks.push(['R2.5: 치트시트가 되살린 단축키를 싣는다', r2.csHasRevived === true])
  checks.push(['R2.5: 치트시트 행 15개 이상 유지', r2.csRows >= 15])
  checks.push(['R2.6: 신호등 3개에 글리프 아이콘', r2.ctlGlyphs === 3])
  checks.push(['R2.6: window.ev.window API 존재', r2.hasWindowApi === true])
  checks.push([
    'R2.6: 신호등 클릭이 창 IPC 를 호출한다(무반응 해소)',
    WINDOW_CALLS.join(',') === 'minimize,toggleMaximize,close'
  ])

  // ── R3 어서션 (터미널 표준 기능 + 단축키 충돌 정책) ──
  // 셸 표준 키 통과 / 재배치 키 실동작 / 클립보드 / 검색 / URL / 스크롤백·유니코드·ANSI / OSC 제목 / Ctrl+휠.
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1200))

  const r3a = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const key = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    const panes = () => document.querySelectorAll('.pane-grid .pane').length
    const sessionCount = async () => (await window.ev.session.list()).length
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(250)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1000)
      const list = await window.ev.session.list()
      return list[list.length - 1].id
    }
    let sid = await newLocal()

    // ── R3.8 셸 표준 키가 앱에 먹히지 않는다 ──
    // Ctrl+T(새 세션)·Ctrl+D(복제)·Ctrl+W(패널 닫기)·Ctrl+\\(분할) 는 전부 Shift 계열로 옮겼다.
    const beforeShellKeys = await sessionCount()
    const panesBeforeShellKeys = panes()
    key({ key: 't', ctrlKey: true }); await wait(300)
    key({ key: 'd', ctrlKey: true }); await wait(300)
    key({ key: 'w', ctrlKey: true }); await wait(300)
    key({ key: '\\\\', ctrlKey: true }); await wait(300)
    key({ key: '-', ctrlKey: true }); await wait(300)
    const shellKeysIgnored = (await sessionCount()) === beforeShellKeys && panes() === panesBeforeShellKeys

    // ── R3.8 재배치 키는 실제로 동작한다 ──
    key({ key: 't', ctrlKey: true, shiftKey: true }); await wait(1000)
    const newSessionWorks = (await sessionCount()) === beforeShellKeys + 1
    key({ key: '-', ctrlKey: true, shiftKey: true }); await wait(800)
    const splitWorks = panes() === panesBeforeShellKeys + 1
    key({ key: 'w', ctrlKey: true, shiftKey: true }); await wait(200); await okDialog(); await wait(600)
    const closePaneWorks = panes() === panesBeforeShellKeys
    // R9a: 칸 닫기는 그 칸의 세션까지 끝낸다 — 방금 닫힌 게 sid 였을 수 있다.
    // 아래 블록들(클립보드·검색·URL·제목)은 살아 있는 검증용 세션이 있어야 하므로 필요하면 새로 만든다.
    if (!(await window.ev.session.list()).some((s) => s.id === sid)) sid = await newLocal()

    // Ctrl+Shift+E → [파일] **열기/닫기** (2026-08-19: 레일과 같은 규칙. 예전엔 [연결] 로 넘겼다).
    // 시작 상태를 가정할 수 없으므로(활성 탭은 스냅샷에 저장된다) 먼저 [파일] 을 확실히 열어 둔다.
    const railTab = () => document.querySelector('.lrail-item.active')?.dataset.tab || ''
    const sbShut = () => document.querySelector('.sidebar').classList.contains('collapsed')
    const railBefore = railTab()
    const shutBefore = sbShut()
    if (railTab() !== 'file') { key({ key: 'e', ctrlKey: true, shiftKey: true }); await wait(300) }
    const fileTabActive = railTab() === 'file'
    key({ key: 'e', ctrlKey: true, shiftKey: true }); await wait(300)
    // 같은 것을 다시 누르면 접힌다 — 눌림도 함께 풀린다(닫혔는데 눌린 채면 거짓말이 된다).
    const fileTabToggledBack = sbShut() && railTab() === ''
    // **들어올 때의 모양으로 돌려놓는다.** 사이드바 상태는 스냅샷에 남아 재로드에도 따라오므로
    // 닫은 채 끝내면 뒤 블록(View 메뉴 토글·폭 드래그·재시작 복원)이 전부 흔들린다.
    if (!shutBefore) {
      document.querySelector('.lrail-item[data-tab="' + (railBefore || 'conn') + '"]')?.click()
      await wait(300)
    }
    // Ctrl+Shift+M → 연결 관리자(Ctrl+Shift+C 는 복사로 넘겼다).
    key({ key: 'm', ctrlKey: true, shiftKey: true }); await wait(400)
    const connManagerOpen = !!document.querySelector('.overlay.open .modal')
    key({ key: 'Escape' }); await wait(300)

    // ── R3.4 스크롤백 10000 · 유니코드 11 · ANSI 16색 테마 ──
    const info = window.__evTerm(sid)
    const theme = info?.theme || {}
    const ansiKeys = ['black','red','green','yellow','blue','magenta','cyan','white',
      'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite']
    const ansiComplete = ansiKeys.every(k => typeof theme[k] === 'string' && theme[k].length > 0)
    // 테마 색이 토큰에서 왔는지(하드코딩 폴백이 아니라) — --t-red 와 red 가 같아야 한다.
    const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
    const themeFromTokens = theme.red === cssVar('--t-red') && theme.brightRed === cssVar('--t-red-b')
    const hasSelectionBg = typeof theme.selectionBackground === 'string' && theme.selectionBackground.length > 0
    const hasCursorAccent = typeof theme.cursorAccent === 'string' && theme.cursorAccent.length > 0
    // WebGL 은 GPU 비활성 스모크에서 실패할 수 있다 — 실패해도 DOM 폴백으로 계속 렌더돼야 한다(크래시 금지).
    const webglCanvas = !!document.querySelector('.pane .term-pane canvas')
    const domRows = document.querySelectorAll('.pane .term-pane .xterm-rows').length > 0

    // 이 앞 단계에서 새 세션·칸 닫기를 거쳤으므로 검증 대상 세션을 다시 포커스 칸에 올린다
    // (복사/검색은 "포커스 칸의 세션"을 대상으로 한다).
    document.querySelector('.term-tabbar .ttab[data-session-id="' + sid + '"]')?.click()
    await wait(600)

    // ── R3.1 클립보드 ── 실 OS 클립보드는 창이 숨김이라 권한이 없다. API 를 가로채 배선을 검증한다.
    const clip = { wrote: [], read: '붙여넣기_한글_테스트' }
    navigator.clipboard.writeText = async (t) => { clip.wrote.push(t) }
    navigator.clipboard.readText = async () => clip.read
    window.__evTerm(sid).selectAll()
    await wait(150)
    key({ key: 'c', ctrlKey: true, shiftKey: true }); await wait(400)
    const copyKeyWrote = clip.wrote.length > 0
    // 선택 즉시 복사(기본 on): 선택이 있는 상태로 터미널에서 mouseup → 한 번 더 복사된다.
    clip.wrote.length = 0
    document.querySelector('.pane.focused .term-pane')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await wait(300)
    const copyOnSelectWrote = clip.wrote.length > 0
    // 붙여넣기: 클립보드 → 세션 입력 → 셸이 되받아 출력.
    key({ key: 'v', ctrlKey: true, shiftKey: true }); await wait(1500)
    const pasteReached = (window.__evTerm(sid)?.text() || '').includes('붙여넣기_한글_테스트')

    return {
      sid, shellKeysIgnored, newSessionWorks, splitWorks, closePaneWorks,
      fileTabActive, fileTabToggledBack, connManagerOpen,
      scrollback: info?.scrollback, unicode: info?.unicode,
      ansiComplete, themeFromTokens, hasSelectionBg, hasCursorAccent, webglCanvas, domRows,
      copyKeyWrote, copyOnSelectWrote, pasteReached
    }
  })()`)

  checks.push(['R3.8: 셸 표준 Ctrl+T/D/W/\\/- 는 앱이 가로채지 않는다', r3a.shellKeysIgnored === true])
  checks.push(['R3.8: Ctrl+Shift+T 새 세션', r3a.newSessionWorks === true])
  checks.push(['R3.8: Ctrl+Shift+- 가로 분할', r3a.splitWorks === true])
  checks.push(['R3.8: Ctrl+Shift+W 패널 닫기', r3a.closePaneWorks === true])
  checks.push(['R3.8: Ctrl+Shift+E 파일 트리 토글(실배선)', r3a.fileTabActive === true && r3a.fileTabToggledBack === true])
  checks.push(['R3.8: Ctrl+Shift+M 연결 관리자(C 는 복사에 양보)', r3a.connManagerOpen === true])
  checks.push(['R3.4: 스크롤백 10000', r3a.scrollback === 10000])
  checks.push(['R3.4: 유니코드 11 폭 계산 활성', r3a.unicode === '11'])
  checks.push(['R3.4: WebGL 활성 또는 DOM 폴백(크래시 없음)', r3a.webglCanvas === true || r3a.domRows === true])
  checks.push(['R3.5: ANSI 16색 전부 정의', r3a.ansiComplete === true])
  checks.push(['R3.5: ANSI 색이 디자인 토큰에서 파생', r3a.themeFromTokens === true])
  checks.push(['R3.5: selectionBackground + cursorAccent 정의', r3a.hasSelectionBg && r3a.hasCursorAccent])
  checks.push(['R3.1: Ctrl+Shift+C 복사', r3a.copyKeyWrote === true])
  checks.push(['R3.1: 선택 시 자동 복사(기본 on)', r3a.copyOnSelectWrote === true])
  checks.push(['R3.1: Ctrl+Shift+V 붙여넣기 → 셸 입력 도달(한글)', r3a.pasteReached === true])

  // R3.6: main 이 보낸 OSC 0/2 시퀀스 → xterm onTitleChange → 탭 이름. 사용자가 rename 한 뒤에는 무시.
  pushData(r3a.sid, '\x1b]0;배포서버-01\x07')
  await new Promise((res) => setTimeout(res, 700))
  const r3title = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const labelOf = (id) => {
      const tabs = [...document.querySelectorAll('.term-tabbar .ttab')]
      const t = tabs.find(x => x.dataset.sessionId === id)
      return (t?.querySelector('.tlabel') || t)?.textContent || ''
    }
    const auto = labelOf('${r3a.sid}')
    // 사용자가 이름을 바꾸면 이후 OSC 제목은 무시돼야 한다.
    await window.ev.session.rename('${r3a.sid}', '결제 배포')
    const applied = await window.ev.session.autoTitle('${r3a.sid}', '덮어쓰기시도')
    await wait(200)
    const list = await window.ev.session.list()
    const kept = list.find(s => s.id === '${r3a.sid}')?.title
    return { auto, applied: applied.applied, kept }
  })()`)

  checks.push(['R3.6: OSC 0/2 제목이 탭 이름에 반영', r3title.auto.includes('배포서버-01')])
  checks.push(['R3.6: rename 한 세션은 OSC 제목을 무시', r3title.applied === false && r3title.kept === '결제 배포'])

  // R3.2 검색 + R3.3 URL + R3.7 Ctrl+휠.
  const r3b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const key = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    const isWin = navigator.userAgent.includes('Windows')
    // 검색 대상 출력(한글) 만들기.
    window.ev.session.input('${r3a.sid}', 'echo 검색대상_결제로그_2026' + (isWin ? '\\r\\n' : '\\n'))
    await wait(1500)
    key({ key: 'f', ctrlKey: true, shiftKey: true }); await wait(400)
    const barOpen = !!document.querySelector('.term-search')
    const input = document.querySelector('.term-search .ts-input')
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(input, '검색대상_결제로그')
    await wait(500)
    const koreanHit = !document.querySelector('.term-search .ts-miss')
    // ▲▼ 이동 버튼 존재 + Enter 로 다음 결과.
    const navBtns = document.querySelectorAll('.term-search .ts-btn').length
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wait(300)
    // 없는 문자열 → 결과 없음 표시.
    setValue(input, '절대없는문자열_zzz')
    await wait(500)
    const missShown = !!document.querySelector('.term-search .ts-miss')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(300)
    const barClosed = !document.querySelector('.term-search')

    // R3.3: web-links 애드온이 링크를 인식하는지 + Ctrl+클릭만 연다.
    window.ev.session.input('${r3a.sid}', 'echo https://verygoodtour.com/deploy' + (isWin ? '\\r\\n' : '\\n'))
    await wait(1500)
    const openedBefore = await window.ev.app.openExternal('https://probe.invalid/seed') // 채널 존재 확인용
    const badScheme = await window.ev.app.openExternal('file:///C:/Windows/System32/calc.exe')

    // R3.7 Ctrl+휠 → 글자 크기 ±1 (10–20 클램프, 설정과 같은 경로).
    const ttOf = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tt'), 10)
    const before = ttOf()
    const pane = document.querySelector('.pane.focused .term-pane') || document.querySelector('.term-pane')
    pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))
    await wait(400)
    const zoomedIn = ttOf() === before + 1
    pane.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true }))
    await wait(400)
    const zoomedOut = ttOf() === before
    // Ctrl 없는 휠은 폰트를 건드리지 않는다(스크롤이어야 한다).
    pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    await wait(300)
    const plainWheelIgnored = ttOf() === before
    const persistedSize = (await window.ev.workspace.load()).ui.font.sizePx

    return { barOpen, koreanHit, navBtns, missShown, barClosed,
      openedOk: openedBefore.ok, badSchemeBlocked: badScheme.ok === false,
      zoomedIn, zoomedOut, plainWheelIgnored, persistedSize, before }
  })()`)

  checks.push(['R3.2: Ctrl+Shift+F 검색 바 열림', r3b.barOpen === true])
  checks.push(['R3.2: 한글 검색어 매치', r3b.koreanHit === true])
  checks.push(['R3.2: ▲▼ 이동 + 닫기 버튼', r3b.navBtns === 3])
  checks.push(['R3.2: 매치 없으면 "결과 없음" 표시', r3b.missShown === true])
  checks.push(['R3.2: ESC 로 검색 바 닫힘', r3b.barClosed === true])
  checks.push(['R3.3: app.openExternal IPC 배선(http 통과)', r3b.openedOk === true && OPENED.length > 0])
  checks.push(['R3.3: http/https 외 스킴 차단(file:)', r3b.badSchemeBlocked === true])
  checks.push(['R3.7: Ctrl+휠 위 → 글자 크기 +1', r3b.zoomedIn === true])
  checks.push(['R3.7: Ctrl+휠 아래 → 원복', r3b.zoomedOut === true])
  checks.push(['R3.7: Ctrl 없는 휠은 크기 불변(스크롤)', r3b.plainWheelIgnored === true])
  checks.push(['R3.7: 휠 확대가 설정 저장 경로를 탄다', r3b.persistedSize === r3b.before])

  // ── R3.1 Ctrl+C / Ctrl+V (Windows Terminal 관례) ──
  // 이 키들은 xterm 의 커스텀 키 핸들러가 가로채므로 window 가 아니라 xterm 입력 요소에 쏴야 한다.
  // 앞 줄이 `await wait(...)` 이라 세미콜론 없이 붙이면 ASI 가 호출로 이어 붙인다 — 반드시 `;` 로 시작.
  // keyCode 를 반드시 실어야 한다: xterm 은 제어문자(Ctrl+C → \x03)를 key 가 아니라 keyCode 로 만든다.
  const termKey = (k) => `;{
    const ta = document.querySelector('.pane.focused .term-pane .xterm-helper-textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: '${k}', keyCode: '${k}'.toUpperCase().charCodeAt(0), which: '${k}'.toUpperCase().charCodeAt(0),
      ctrlKey: true, bubbles: true, cancelable: true
    }))
  }`
  INPUTS.length = 0
  const copyWithSel = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    window.__clip = { wrote: [], read: '한글_붙여넣기_CtrlV' }
    navigator.clipboard.writeText = async (t) => { window.__clip.wrote.push(t) }
    navigator.clipboard.readText = async () => window.__clip.read
    window.__evTerm('${r3a.sid}').selectAll()
    await wait(150)
    ${termKey('c')}
    await wait(400)
    return { wrote: window.__clip.wrote.length, selectionLeft: window.__evTerm('${r3a.sid}').getSelection().length }
  })()`)
  const sigintDuringCopy = INPUTS.some((i) => i.data.includes('\x03'))

  INPUTS.length = 0
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    ${termKey('c')}
    await wait(400)
    return true
  })()`)
  const sigintNoSel = INPUTS.some((i) => i.data.includes('\x03'))

  // Ctrl+V 는 **진짜 붙여넣기**로 확인한다. 합성 KeyboardEvent 로는 브라우저가 클립보드를 건드리지
  // 않는다(신뢰되지 않은 이벤트) — 2026-08-09 에 붙여넣기를 paste 이벤트 기반으로 바꾸면서
  // 이 검사가 합성 키로는 통과할 수 없게 됐다. webContents.paste() 가 실제 사용자 Ctrl+V 와 같은 경로다.
  INPUTS.length = 0
  const PASTE_PROBE = '한글_붙여넣기_CtrlV'
  // 여기서 쓰는 건 **사용자의 진짜 OS 클립보드**다. 빌려 쓰는 것이므로 반드시 원래대로 되돌린다.
  // 되돌릴 값은 로그·파일·보고서 어디에도 남기지 않는다 — 무엇이 들어 있을지 모른다(사내 규칙).
  // ponytail: 텍스트만 보존한다. 이미지·파일 목록이 들어 있었다면 그건 못 살린다
  //   (readImage/readBuffer 까지 백업하는 건 테스트 하나에 과하다). 그 경우 clear() 로
  //   최소한 우리 문자열은 남기지 않는다. 필요해지면 그때 확장해라.
  const savedClipboard = clipboard.readText()
  let pasted = false
  let clipboardBlocked = false
  try {
    clipboard.writeText(PASTE_PROBE)
    // write 직후 read 가 우리 값이 아니면 OS 가 이 프로세스의 클립보드 접근을 거부한 것이다
    // (사내 DLP 등). 그러면 이 검사는 PASS 도 FAIL 도 아니고 **판정 불가**다 — 아래에서 SKIP 처리.
    // ARA_FORCE_CLIPBOARD_BLOCKED=1 로 이 갈래를 강제할 수 있다 — DLP 가 풀린 기계에서도 SKIP 경로가
    // 살아 있는지 확인할 수 있어야 한다(막힌 기계에서만 도는 코드는 조용히 썩는다).
    clipboardBlocked =
      process.env.ARA_FORCE_CLIPBOARD_BLOCKED === '1' || clipboard.readText() !== PASTE_PROBE
    if (!clipboardBlocked) {
      // xterm 의 숨은 textarea 에 포커스가 있어야 붙여넣기가 터미널로 간다.
      await win.webContents.executeJavaScript(
        `(() => { const ta = document.querySelector('.xterm-helper-textarea'); if (ta) ta.focus(); return !!ta })()`
      )
      await new Promise((r) => setTimeout(r, 150))
      win.webContents.focus()
      await new Promise((r) => setTimeout(r, 100))
      win.webContents.paste()
      await new Promise((r) => setTimeout(r, 700))
      pasted = INPUTS.some((i) => i.data.includes(PASTE_PROBE))
    }
  } finally {
    try {
      if (savedClipboard) clipboard.writeText(savedClipboard)
      else clipboard.clear()
    } catch {
      /* 막혀 있으면 애초에 덮어쓰지도 못했다 */
    }
  }

  checks.push(['R3.1: 선택이 있으면 Ctrl+C 는 복사', copyWithSel.wrote > 0])
  checks.push(['R3.1: 복사한 Ctrl+C 는 SIGINT 를 보내지 않는다', sigintDuringCopy === false])
  checks.push(['R3.1: 복사 후 선택 해제(관례)', copyWithSel.selectionLeft === 0])
  checks.push(['R3.1: 선택이 없으면 Ctrl+C 는 SIGINT(셸 전달)', sigintNoSel === true])
  // 환경이 클립보드를 거부하면 문자열(=SKIP 사유)을 넣는다 — 검증 안 한 것을 PASS 로 세지 않고,
  // 환경 탓을 FAIL 로 세서 게이트를 빨간 채로 두지도 않는다.
  checks.push([
    'R3.1: Ctrl+V 는 항상 붙여넣기(한글)',
    clipboardBlocked ? '환경: 클립보드 접근 거부(OS/DLP) — 이 PC 에서는 판정 불가' : pasted === true
  ])

  // ── R3 회귀 진단① DA(Device Attributes) 응답 누출 → 프롬프트에 `[?1;2c` ──
  // 셸/conpty 가 뱉은 DA 질의(ESC[c)는 재생 버퍼에도 남는다. xterm 을 다시 만들어 그 버퍼를 재생하면
  // xterm 이 "지금 물어본 것"으로 알고 다시 답해 `\x1b[?1;2c` 를 pty 로 보낸다 → 셸이 그걸 입력으로
  // 받아 프롬프트에 찍힌다. 라이브 질의에는 계속 답해야 하므로(정상 경로) 재생 중에만 침묵해야 한다.
  // 재마운트는 실제 경로 그대로 재현한다: 렌더러 리로드 → 살아 있는 main 세션을 다시 편입(__evAdopt).
  const daQ = (i) => i.data.includes('\x1b[?')
  INPUTS.length = 0
  pushData(r3a.sid, '\x1b[c') // 라이브 DA 질의
  await new Promise((res) => setTimeout(res, 700))
  const daLive = INPUTS.filter(daQ).length

  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1200))
  INPUTS.length = 0
  await win.webContents.executeJavaScript(
    `window.__evAdopt('${r3a.sid}', '진단1', 'localhost', 'local'), true`
  )
  await new Promise((res) => setTimeout(res, 1800)) // attach → 재생 완료 대기
  const daReplayed = INPUTS.filter(daQ).length

  // 사용자가 본 증상 그대로: 새 로컬 셸의 프롬프트에 `[?1;2c` 같은 이스케이프 잔재가 없어야 한다.
  // (위 세션은 테스트가 프롬프트 한가운데에 DA 질의를 쏴 넣어 셸이 그 답을 입력으로 받아 적은 상태라
  //  화면 잔재 검사 대상이 아니다 — 실사용에서는 질의를 보낸 프로그램이 응답을 가져간다.)
  const freshResidue = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1800)
    const list = await window.ev.session.list()
    const id = list[list.length - 1].id
    const text = window.__evTerm(id)?.text() || ''
    return { hasEscape: /\\[\\?[0-9;]*c/.test(text), len: text.length }
  })()`)
  console.log(`R3 진단①: daLive=${daLive} daReplayed=${daReplayed} 새셸잔재=${freshResidue.hasEscape}`)
  checks.push(['R3 진단①: 라이브 DA 질의에는 응답한다(정상 경로 유지)', daLive > 0])
  checks.push(['R3 진단①: 재생 버퍼의 DA 질의에는 응답하지 않는다', daReplayed === 0])
  checks.push(['R3 진단①: 새 로컬 셸 프롬프트에 `[?…c` 이스케이프 잔재 없음', freshResidue.hasEscape === false])

  // ── R3 회귀 진단② windowsMode 유지 ──
  // conpty 는 줄을 터미널 폭까지 공백으로 채워 보낸다. xterm 리플로우가 켜져 있으면 창을 좁힐 때
  // 그 padding 까지 접혀 줄 사이에 빈 줄이 끼고 줄 간격이 벌어진다. 로컬 세션은 windowsMode 로 꺼 둔다.
  const wmode = await win.webContents.executeJavaScript(
    `({ windowsMode: window.__evTerm('${r3a.sid}')?.windowsMode, isWin: navigator.userAgent.includes('Windows') })`
  )
  checks.push([
    'R3 진단②: 로컬 세션 windowsMode 유지(리플로우 끔 — 좁힐 때 줄간격 깨짐 방지)',
    wmode.isWin ? wmode.windowsMode === true : wmode.windowsMode !== true
  ])

  // ── R4 어서션 (창/셸 크롬) ──
  // 메뉴바 실동작 / 상태바 실데이터 / 사이드바 폭 드래그·영속 / 창 타이틀.
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1200))

  const r4a = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const tops = () => [...document.querySelectorAll('.tb-menu span')]
    const openTop = async (title) => {
      tops().find(s => s.textContent === title)?.click()
      await wait(180)
    }
    const items = () => [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    const pick = async (action) => {
      document.querySelector('.ctx-menu .ctx-item[data-action="' + action + '"]')?.click()
      await wait(350)
    }
    const closeMenu = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(150) }

    // R4.1 ① 최상위 6개가 전부 열리고 항목이 있다(R3 까지 Session 하나만 반응했다).
    const titles = tops().map(s => s.textContent)
    const opened = []
    for (const tt of titles) {
      await openTop(tt)
      opened.push({ title: tt, count: items().length, ids: items() })
      await closeMenu()
    }
    // R4.1 ② 힌트가 keymap 단일 소스에서 온다.
    await openTop('분할')
    const splitHints = [...document.querySelectorAll('.ctx-menu .ctx-item .ci-kbd')].map(k => k.textContent)
    await closeMenu()

    // 세션 하나 확보(＋ → 로컬 셸).
    document.querySelector('.tterm-add')?.click(); await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(900)

    // R4.1 ③ 메뉴 항목이 실제로 동작한다 — Split → 가로 분할로 패널이 늘어난다.
    const panesBefore = document.querySelectorAll('.pane-grid .pane').length
    await openTop('분할'); await pick('split.horizontal')
    const panesAfterMenu = document.querySelectorAll('.pane-grid .pane').length
    // 되돌리기: 칸 닫기(R9a — 그 칸의 세션도 함께 끝난다. 여기선 로컬이라 확인 없음).
    await openTop('분할'); await pick('pane.close')
    await wait(200); await okDialog()
    const panesAfterClose = document.querySelectorAll('.pane-grid .pane').length

    // R4.1 ④ View → 사이드바 접기(단축키가 아니라 메뉴로).
    const collapsedBefore = document.querySelector('.sidebar').classList.contains('collapsed')
    await openTop('보기'); await pick('sidebar.collapse')
    const collapsedAfter = document.querySelector('.sidebar').classList.contains('collapsed')
    await openTop('보기'); await pick('sidebar.collapse')
    const collapsedBack = document.querySelector('.sidebar').classList.contains('collapsed')

    // R4.1 ⑤ File → 설정 / Help → 치트시트 / Help → 정보.
    // R5: 설정에 Ctrl+, 가 생겨 command 가 아니라 action 항목이 됐다(메뉴가 그 키를 눌러 준다).
    await openTop('파일'); await pick('settings.open')
    const drawerOpen = !!document.querySelector('.drawer.open')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(250)
    await closeMenu()
    await openTop('도움말'); await pick('help.cheatsheet')
    const cheatsheetOpen = !!document.querySelector('.cheatsheet.open')
    await closeMenu()
    await openTop('도움말'); await pick('help.about')
    const aboutOpen = (document.querySelector('.dlg-overlay .modal h2')?.textContent || '').includes('A.R.A')
    document.querySelector('.dlg-overlay .modal-ft .btn.pri')?.click(); await wait(250)
    const aboutClosed = !document.querySelector('.dlg-overlay')

    // R4.1 ⑥ View → 글자 크게/작게가 --tt(터미널 글자 크기)를 움직인다.
    const ttBefore = getComputedStyle(document.documentElement).getPropertyValue('--tt').trim()
    await openTop('보기'); await pick('font.zoomIn')
    const ttUp = getComputedStyle(document.documentElement).getPropertyValue('--tt').trim()
    await openTop('보기'); await pick('font.zoomOut')
    const ttBack = getComputedStyle(document.documentElement).getPropertyValue('--tt').trim()

    return {
      titles, opened, splitHints,
      panesBefore, panesAfterMenu, panesAfterClose,
      collapsedBefore, collapsedAfter, collapsedBack,
      drawerOpen, cheatsheetOpen, aboutOpen, aboutClosed, ttBefore, ttUp, ttBack
    }
  })()`)

  checks.push(['R4.1: 메뉴바 최상위 6종(Tools 제거 — 넣을 기능이 없었다)', r4a.titles.join(',') === '파일,편집,세션,분할,보기,도움말'])
  checks.push(['R4.1: 모든 최상위 메뉴가 열리고 항목이 있다(빈 메뉴 없음)', r4a.opened.every((m) => m.count > 0)])
  checks.push(['R4.1: Session 첫 항목은 연결 관리자(기존 손버릇 유지)', r4a.opened.find((m) => m.title === '세션').ids[0] === 'connection.manager'])
  checks.push(['R4.1: 항목에 keymap 단축키 힌트 표기', r4a.splitHints.includes('Ctrl+Shift+-') && r4a.splitHints.includes('Ctrl+Shift+W')])
  checks.push(['R4.1: Split→가로 분할이 실제로 패널을 늘린다', r4a.panesAfterMenu === r4a.panesBefore + 1])
  checks.push(['R4.1: Split→패널 닫기가 실제로 패널을 줄인다', r4a.panesAfterClose === r4a.panesBefore])
  checks.push(['R4.1: View→사이드바 접기 토글 동작', r4a.collapsedBefore === false && r4a.collapsedAfter === true && r4a.collapsedBack === false])
  checks.push(['R4.1/R5: File→설정이 설정 창을 연다', r4a.drawerOpen === true])
  checks.push(['R4.1: Help→치트시트가 열린다', r4a.cheatsheetOpen === true])
  checks.push(['R4.1: Help→정보 다이얼로그(네이티브 alert 아님)', r4a.aboutOpen === true && r4a.aboutClosed === true])
  checks.push(['R4.1: View→글자 크게/작게가 --tt 를 움직였다 원복', r4a.ttUp !== r4a.ttBefore && r4a.ttBack === r4a.ttBefore])

  // ── R4.2 상태바 실데이터 / R4.4 창 타이틀 ──
  // 로컬 세션 → 셸 이름 + cwd(session:cwd 이벤트), SSH 세션 → user@host:port + 연결 dot.
  const localSid = await win.webContents.executeJavaScript(
    `(async () => (await window.ev.session.list()).filter(s => s.type === 'local').pop().id)()`
  )
  win.webContents.send('session:cwd:' + localSid, { id: localSid, cwd: '/srv/서비스/로그' })
  await new Promise((res) => setTimeout(res, 400))

  const r4b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const sb = () => ({
      label: document.querySelector('.statusbar .sb-seg.host .lbl')?.textContent || '',
      val: document.querySelector('.statusbar .sb-seg.host .val')?.textContent || '',
      cwd: document.querySelector('.statusbar .sb-seg.cwd .val')?.textContent || '',
      dot: document.querySelector('.statusbar .sb-seg.host .sb-dot')?.className || '',
      segs: [...document.querySelectorAll('.statusbar .sb-right .sb-seg')].map(s => s.textContent)
    })
    const localBar = sb()
    const localTitle = document.title
    // SSH 세션으로 전환 → user@host:port 로 갱신(세션 전환 시 갱신 확인).
    // 접속에 성공하는 프로필(smoke-dev)을 이름으로 정확히 고른다 — hostkey-/authfail- 프로필은 실패용이다.
    const srv = [...document.querySelectorAll('.tree .srv-node:not(.new-local)')]
      .find(n => (n.querySelector('.sname')?.textContent || '') === 'smoke-dev')
    if (srv) {
      srv.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      srv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    }
    await wait(1200)
    const sshBar = sb()
    const sshTitle = document.title
    return { localBar, localTitle, sshBar, sshTitle }
  })()`)
  const winTitle = win.getTitle()

  checks.push(['R4.2: 하드코딩 localhost 제거(활성 세션 실데이터)', r4b.localBar.val !== 'localhost'])
  checks.push(['R4.2: 로컬 세션은 셸 이름 표시', r4b.localBar.label === '셸' && r4b.localBar.val.length > 0])
  checks.push(['R4.2: 로컬 세션 cwd 표시(OSC7 경로 재사용)', r4b.localBar.cwd === '/srv/서비스/로그'])
  checks.push(['R4.2: SSH 세션은 user@host:port + 연결 dot', /^deploy@10\.9\.9\.9:22/.test(r4b.sshBar.val) && r4b.sshBar.dot.includes('connected')])
  checks.push(['R4.2: 세션 전환 시 상태바 갱신', r4b.localBar.val !== r4b.sshBar.val])
  checks.push(['R4.2: 우측에 세션 수·인코딩·버전', r4b.sshBar.segs.length === 3 && r4b.sshBar.segs.some((s) => s.includes('UTF-8')) && r4b.sshBar.segs.some((s) => /v\d/.test(s))])
  checks.push(['R4.4: 창 타이틀이 활성 세션 반영', /^A\.R\.A — .+/.test(r4b.sshTitle) && r4b.localTitle !== r4b.sshTitle])
  checks.push(['R4.4: OS 창 제목이 문서 제목을 따라간다(작업표시줄·Alt+Tab)', winTitle === r4b.sshTitle])

  // ── R4.3 사이드바 폭 드래그 + 상태 영속 ──
  const r4c = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const widthOf = () => Math.round(parseFloat(getComputedStyle(document.querySelector('.sidebar')).width))
    const before = widthOf()
    const rez = document.querySelector('.sb-resizer')
    const hasHandle = !!rez
    // 실제 드래그처럼 mousedown → mousemove → mouseup 사이에 프레임을 준다. 셋을 한 태스크에서 쏘면
    // React 가 세 상태 갱신을 한 번에 커밋해 "드래그 중"(트랜지션 끄기)이 DOM 에 나타나지 않는다.
    const drag = async (fromX, toX) => {
      rez?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: fromX }))
      await wait(60)
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: toX }))
      await wait(350) // 폭 트랜지션(0.22s)이 안 꺼졌다면 여기서 드러난다
      const during = widthOf()
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await wait(350)
      return { during, after: widthOf() }
    }

    const first = await drag(before, before + 96)
    const midDrag = first.during
    const dragged = first.after
    // 상한 클램프: 아주 멀리 끌어도 480 을 넘지 않는다.
    const clampedMax = (await drag(dragged, 4000)).after
    // 하한 클램프 + 최종 저장값을 400 으로 맞춰 재시작 검증에 쓴다.
    const clampedMin = (await drag(clampedMax, -4000)).after
    await drag(clampedMin, 400)
    // 활성 탭을 [파일] 로, 접힘은 펼침 상태로 두고 저장 상태를 굳힌다.
    // **이미 [파일] 이면 누르지 않는다** — 2026-08-19 부터 같은 아이콘을 다시 누르면 접힌다.
    if (document.querySelector('.lrail-item.active')?.dataset.tab !== 'file') {
      document.querySelector('.lrail-item[data-tab="file"]')?.click()
      await wait(300)
    }
    const persisted = (await window.ev.workspace.load()).ui.sidebar
    return { hasHandle, before, midDrag, dragged, clampedMax, clampedMin, persisted }
  })()`)

  checks.push(['R4.3: 경계 드래그 손잡이 렌더', r4c.hasHandle === true])
  checks.push(['R4.3: 드래그 중 폭이 실시간으로 따라온다', r4c.midDrag === r4c.before + 96])
  checks.push(['R4.3: 놓으면 그 폭이 유지된다', r4c.dragged === r4c.before + 96])
  checks.push(['R4.3: 최대 480 클램프', r4c.clampedMax === 480])
  checks.push(['R4.3: 최소 180 클램프', r4c.clampedMin === 180])
  checks.push(['R4.3: 폭·활성 탭이 스냅샷에 저장된다', r4c.persisted.width === 400 && r4c.persisted.activeTab === 'file'])

  // 재시작(재로드) 후 복원 — 죽은 스키마였던 ui.sidebar 가 실제로 읽힌다.
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 2500))
  const r4d = await win.webContents.executeJavaScript(`(async () => ({
    width: Math.round(parseFloat(getComputedStyle(document.querySelector('.sidebar')).width)),
    activeTab: document.querySelector('.lrail-item.active')?.dataset.tab || '',
    // 세션이 없을 때 [파일] 탭은 누를 수 없어야 한다(눌러도 아무 일이 없으면 "무반응"으로 읽힌다).
    fileTabDisabled: document.querySelector('.lrail-item[data-tab="file"]')?.disabled === true,
    savedTab: (await window.ev.workspace.load()).ui.sidebar.activeTab,
    collapsed: document.querySelector('.sidebar').classList.contains('collapsed'),
    title: document.title
  }))()`)

  checks.push(['R4.3: 재시작 후 사이드바 폭 유지(400)', r4d.width === 400])
  // 세션이 하나도 없는 상태다(바로 아래 R4.4 가 그걸 확인한다) — 파일 트리는 활성 세션의 파일시스템을
  // 읽으므로 보여 줄 게 없다. 표시는 [연결] 로 떨어지되 저장값은 'file' 그대로여야 한다(접속하면 복귀).
  checks.push(['세션이 없으면 표시는 [연결] 로 떨어진다', r4d.activeTab === 'conn'])
  checks.push(['세션이 없으면 [파일] 탭은 비활성', r4d.fileTabDisabled === true])
  checks.push(['R4.3: 저장된 활성 탭은 그대로(file) — 접속하면 돌아온다', r4d.savedTab === 'file'])
  checks.push(['R4.3: 재시작 후 접힘 상태 유지(펼침)', r4d.collapsed === false])
  checks.push(['R4.4: 세션이 없으면 창 타이틀은 앱 이름만', r4d.title === 'A.R.A'])

  // ── R5 어서션 ── 설정 창 5섹션 / 신규 설정 3종 즉시 적용·영속 / 라디얼 복원 / 커서·벨.
  const r5 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const setRange = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const nav = (s) => document.querySelector('.drawer.open .set-nav span[data-section="' + s + '"]')?.click()
    const rowByLabel = (text) => [...document.querySelectorAll('.drawer.open .set-row')]
      .find(r => (r.querySelector('.sr-label')?.textContent || '').includes(text))

    // 세션 하나 확보 — "열린 세션에도 즉시 적용"을 xterm 옵션으로 확인해야 한다.
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(900)
    const sid = (await window.ev.session.list()).slice(-1)[0]?.id
    const termOpts = () => { const t = window.__evTerm(sid); return { scrollback: t?.scrollback, cursorStyle: t?.cursorStyle, cursorBlink: t?.cursorBlink } }
    const before = termOpts()

    // 진입점 ②: Ctrl+, (기어·File>설정과 같은 상태를 연다).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))
    await wait(350)
    const openedByHotkey = !!document.querySelector('.drawer.open')

    // [일반] — 선택 자동복사 끄기 / 스크롤백 2000. (#67: 우클릭 스타일 줄은 없어졌다.)
    nav('general'); await wait(200)
    const ctxStyleRowGone = !rowByLabel('우클릭 메뉴 스타일')
    const copyToggle = rowByLabel('자동 복사')?.querySelector('.set-toggle')
    const copyOnBefore = copyToggle?.getAttribute('aria-checked')
    copyToggle?.click(); await wait(200)
    const copyOnAfter = rowByLabel('자동 복사')?.querySelector('.set-toggle')?.getAttribute('aria-checked')
    const sbSlider = rowByLabel('스크롤백')?.querySelector('input[type=range]')
    const sbMin = sbSlider?.min, sbMax = sbSlider?.max
    if (sbSlider) setRange(sbSlider, 2000)
    await wait(250)
    const afterScrollback = termOpts()

    // [터미널] — 커서 막대 + 깜빡임 끄기 + 시각 벨.
    nav('terminal'); await wait(200)
    rowByLabel('커서 모양')?.querySelector('.seg-ctl button[data-value="bar"]')?.click(); await wait(200)
    rowByLabel('커서 깜빡임')?.querySelector('.set-toggle')?.click(); await wait(200)
    rowByLabel('벨')?.querySelector('.seg-ctl button[data-value="visual"]')?.click(); await wait(250)
    const afterCursor = termOpts()

    // [단축키] — 치트시트와 같은 KEYMAP 파생(읽기 전용) + 커스터마이즈 안내.
    nav('keys'); await wait(200)
    const keyRows = document.querySelectorAll('.drawer.open .set-keys .cs-row').length
    const keyNote = document.querySelector('.drawer.open .set-note')?.textContent || ''
    const hasSettingsKey = [...document.querySelectorAll('.drawer.open .set-keys .cs-row')]
      .some(r => /설정/.test(r.querySelector('.cs-desc')?.textContent || ''))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(300)

    const persisted = (await window.ev.workspace.load()).ui
    return {
      openedByHotkey, ctxStyleRowGone, copyOnBefore, copyOnAfter, sbMin, sbMax,
      before, afterScrollback, afterCursor,
      keyRows, keyNote, hasSettingsKey,
      persisted: {
        copyOnSelect: persisted.copyOnSelect,
        scrollback: persisted.scrollback, cursorStyle: persisted.cursorStyle,
        cursorBlink: persisted.cursorBlink, bell: persisted.bell
      }
    }
  })()`)

  checks.push(['R5: Ctrl+, 로 설정 창이 열린다', r5.openedByHotkey === true])
  checks.push(['#67: 설정 [일반]에서 우클릭 스타일 줄이 사라졌다', r5.ctxStyleRowGone === true])
  checks.push(['R5: 선택 자동 복사 토글 on→off', r5.copyOnBefore === 'true' && r5.copyOnAfter === 'false'])
  checks.push(['R5: 스크롤백 슬라이더 1k–100k', r5.sbMin === '1000' && r5.sbMax === '100000'])
  checks.push([
    'R5: 스크롤백 변경이 열린 세션에 즉시 적용',
    r5.before.scrollback === 10000 && r5.afterScrollback.scrollback === 2000
  ])
  checks.push([
    'R5: 커서 모양·깜빡임 변경이 열린 세션에 즉시 적용',
    r5.before.cursorStyle === 'block' && r5.afterCursor.cursorStyle === 'bar' && r5.afterCursor.cursorBlink === false
  ])
  checks.push(['R5: [단축키] 섹션이 keymap 표를 싣는다', r5.keyRows >= 15 && r5.hasSettingsKey === true])
  // 문구는 2026-08-13 설명문 간결화로 바뀌었다("추후 지원" → "아직 지원하지 않습니다").
  // 검사하려는 것은 낱말이 아니라 **커스터마이즈가 아직 안 된다고 알려 주는가** 이므로 둘 다 받는다.
  checks.push(['R5: [단축키] 커스터마이즈 미지원 안내', /추후|아직/.test(r5.keyNote)])
  checks.push([
    'R5: 신규 설정 2종 영속(선택복사·스크롤백)',
    r5.persisted.copyOnSelect === false && r5.persisted.scrollback === 2000
  ])
  checks.push([
    'R5: 커서·벨 설정 영속',
    r5.persisted.cursorStyle === 'bar' && r5.persisted.cursorBlink === false && r5.persisted.bell === 'visual'
  ])

  // 재시작(재로드) 후에도 유지되는지 — 설정은 좁은 채널(ui:setPrefs)로 즉시 flush 된다.
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 1500))
  const r5b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(900)
    const sid = (await window.ev.session.list()).slice(-1)[0]?.id
    const t = window.__evTerm(sid)
    return { scrollback: t?.scrollback, cursorStyle: t?.cursorStyle }
  })()`)

  checks.push([
    'R5: 재시작 후 새 세션이 저장된 스크롤백·커서로 열린다',
    r5b.scrollback === 2000 && r5b.cursorStyle === 'bar'
  ])

  // ── R6 어서션 ── 새 그룹 / 이름 변경 / 삭제(기타 이동) / 트리 검색.
  const r6 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    const setInput = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // R4.3 에서 활성 탭을 [파일] 로 두고 저장했다 — 트리를 보려면 [연결] 로 되돌린다.
    ;document.querySelector('.lrail-item[data-tab="conn"]')?.click()
    await wait(300)
    // .srv-hd = [caret span][그룹명 텍스트][카운트 span]. 로컬 그룹은 연결 그룹이 아니라 제외.
    const groupNames = () => [...document.querySelectorAll('.tree .srv-hd')]
      .map(h => (h.childNodes[1]?.textContent || '').trim())
      .filter(n => n && n !== '로컬')
    const ctx = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
    const grpHd = (name) => [...document.querySelectorAll('.tree .srv-hd')].find(h => h.textContent.includes(name))
    const dlgConfirm = async (text) => {
      const input = document.querySelector('.dlg-overlay .dlg-input')
      if (input && text !== undefined) setInput(input, text)
      await wait(120)
      document.querySelector('.dlg-overlay .modal-ft .btn.pri, .dlg-overlay .modal-ft .btn.dgr')?.click()
      await wait(700)
    }

    const groupsBefore = groupNames()

    // ① 빈 영역 우클릭 → 새 그룹(R1 에서 비활성 자리였다) → 이름 입력 → 프로필 없는 그룹도 트리에 뜬다.
    const tree = document.querySelector('.sb-panel.active .tree')
    if (tree) ctx(tree, 120, 620)
    await wait(300)
    const newGroupDim = document.querySelector('.ctx-menu .ctx-item[data-action="group.new"]')?.classList.contains('dim')
    document.querySelector('.ctx-menu .ctx-item[data-action="group.new"]')?.click()
    await wait(350)
    const promptIsCustom = !!document.querySelector('.dlg-overlay .dlg-input')
    await dlgConfirm('결제팀')
    const groupsAfterNew = groupNames()
    const emptyGroupShown = groupsAfterNew.includes('결제팀')

    // ② 그룹 이름 변경 — 그룹 안 프로필의 group 이 일괄로 바뀐다.
    const dev = grpHd('개발')
    if (dev) ctx(dev, 160, 200)
    await wait(300)
    document.querySelector('.ctx-menu .ctx-item[data-action="group.rename"]')?.click()
    await wait(350)
    await dlgConfirm('개발2')
    await wait(600)
    const groupsAfterRename = groupNames()
    const profileGroups = (await window.ev.profile.list()).map(p => p.group)

    // ③ 그룹 삭제 — 확인 다이얼로그 후 프로필은 "기타"로 내려간다(삭제되지 않는다).
    const profileCountBefore = (await window.ev.profile.list()).length
    const renamed = grpHd('개발2')
    if (renamed) ctx(renamed, 160, 200)
    await wait(300)
    document.querySelector('.ctx-menu .ctx-item[data-action="group.delete"]')?.click()
    await wait(350)
    const delDialogDanger = !!document.querySelector('.dlg-overlay .modal.sm.danger')
    await dlgConfirm()
    await wait(700)
    const groupsAfterDelete = groupNames()
    const profileCountAfter = (await window.ev.profile.list()).length
    const groupsCleared = (await window.ev.profile.list()).every(p => !p.group)

    // ④ 트리 검색 — 이름/호스트/그룹 실시간 필터.
    const searchInput = document.querySelector('.sb-panel.active .sb-search input')
    const nodesFor = (q) => {
      setInput(searchInput, q)
      return new Promise(r => setTimeout(() => r([...document.querySelectorAll('.tree .srv-node .sname')].map(n => n.textContent)), 250))
    }
    const allNodes = await nodesFor('')
    const byName = await nodesFor('smoke-dev')
    const byHost = await nodesFor('10.9.9.10')
    const noHit = await nodesFor('존재하지않는서버')
    const noHitMsg = !!document.querySelector('.tree .empty')
    await nodesFor('')

    const persistedGroups = (await window.ev.workspace.load()).ui.groups
    return {
      groupsBefore, newGroupDim, promptIsCustom, groupsAfterNew, emptyGroupShown,
      groupsAfterRename, profileGroups, delDialogDanger, groupsAfterDelete,
      profileCountBefore, profileCountAfter, groupsCleared,
      allNodes, byName, byHost, noHit, noHitMsg, persistedGroups
    }
  })()`)

  checks.push(['R6: 빈 영역 "새 그룹" 활성화(흐린 톤 제거)', r6.newGroupDim === false])
  checks.push(['R6: 그룹 이름 입력은 커스텀 다이얼로그(네이티브 prompt 아님)', r6.promptIsCustom === true])
  checks.push(['R6: 프로필 없는 빈 그룹도 트리에 표시', r6.emptyGroupShown === true])
  checks.push([
    'R6: 그룹 이름 변경 → 그룹 내 프로필 일괄 갱신',
    r6.groupsAfterRename.includes('개발2') && !r6.groupsAfterRename.includes('개발') &&
      r6.profileGroups.every((g) => g === '개발2')
  ])
  checks.push(['R6: 그룹 삭제는 위험 톤 확인 다이얼로그', r6.delDialogDanger === true])
  checks.push([
    'R6: 그룹 삭제 → 프로필은 지워지지 않고 "기타"로 이동',
    r6.profileCountAfter === r6.profileCountBefore && r6.groupsCleared === true &&
      !r6.groupsAfterDelete.includes('개발2') && r6.groupsAfterDelete.includes('기타')
  ])
  checks.push(['R6: 그룹 정렬 — "기타"가 마지막', r6.groupsAfterDelete.indexOf('기타') === r6.groupsAfterDelete.length - 1])
  checks.push(['R6: 빈 그룹 목록 영속(ui.groups)', Array.isArray(r6.persistedGroups) && r6.persistedGroups.includes('결제팀')])
  checks.push(['R6: 트리 검색 — 이름으로 필터', r6.allNodes.length > 1 && r6.byName.join(',') === 'smoke-dev'])
  checks.push(['R6: 트리 검색 — 호스트로 필터', r6.byHost.length === 1 && r6.byHost[0] === 'hostkey-smoke'])
  checks.push(['R6: 검색 결과 없으면 안내 문구', r6.noHit.length === 0 && r6.noHitMsg === true])

  // ── F6 어서션 ── 저장된 스냅샷(로컬 2세션 + 2분할)을 seed 하고 재로드 → 부트 복원이 세션·분할을 되살린다.
  //   빈 스냅샷이면 placeholder(빈 시작) 유지. 손상/버전불일치 폴백은 workspace.test.ts 가 단위로 커버.
  SNAP.seed = {
    schemaVersion: 1, savedAt: '2026-08-02T00:00:00Z', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'split', direction: 'row', ratio: [0.5, 0.5], children: [
      { type: 'pane', sessionId: 's1' }, { type: 'pane', sessionId: 's2' }
    ] },
    sessions: [
      { id: 's1', type: 'local', shell: undefined, profileId: null, cwd: 'D:/f6/one', title: 'F6-복원1', serverKey: 'localhost' },
      { id: 's2', type: 'local', shell: undefined, profileId: null, cwd: 'D:/f6/two', title: 'F6-복원2', serverKey: 'localhost' }
    ],
    tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, font: UI.font, locale: 'ko' }
  }
  await win.webContents.reload()
  await new Promise((res) => setTimeout(res, 2500)) // 부트 복원(세션 재스폰) 대기

  const f6 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 2026-08-11: 세션 종료가 **로컬 셸도** 확인 다이얼로그를 거친다(준영님 결정).
    // 확인을 안 누르면 모달 오버레이가 이후 클릭을 전부 삼켜 뒤따르는 검사까지 연쇄로 무너진다.
    const okDialog = async () => {
      for (let i = 0; i < 20; i++) {
        const b = document.querySelector('.dlg-overlay .modal-ft .btn.dgr, .dlg-overlay .modal-ft .btn.pri')
        if (b) { b.click(); await wait(120); return true }
        await wait(50)
      }
      return false
    }
    await wait(300)
    const panes = document.querySelectorAll('.pane-grid .pane').length
    const tabs = document.querySelectorAll('.term-tabbar .ttab').length
    const noError = document.querySelectorAll('.pane-grid .restore-err-card').length === 0
    const grid = document.querySelector('.pane-grid.split') // 분할 그리드로 렌더
    return { panes, tabs, noError, split: !!grid }
  })()`)

  checks.push(['F6: 저장된 2세션 재스폰(탭 2개)', f6.tabs === 2])
  checks.push(['F6: 저장된 2분할 레이아웃 복원(패널 2개)', f6.panes === 2])
  checks.push(['F6: 분할 그리드 렌더(.split)', f6.split === true])
  checks.push(['F6: 로컬 복원은 오류 패널 없음', f6.noError === true])

  // pass 가 문자열이면 SKIP 사유다 — 환경이 거부해 판정 자체를 못 한 검사(PASS 도 FAIL 도 아니다).
  let ok = true
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const [name, pass] of checks) {
    if (typeof pass === 'string') {
      console.log(`SKIP ${name} — ${pass}`)
      skipped++
      continue
    }
    console.log((pass ? 'PASS ' : 'FAIL ') + name + (name === '3행 그리드' ? ` (${r.gridRows})` : ''))
    if (pass) passed++
    else {
      failed++
      ok = false
    }
  }
  console.log(`TOTAL ${passed} PASS / ${failed} FAIL / ${skipped} SKIP`)
  console.log('gridTemplateRows=' + r.gridRows)

  // 좀비 pty 정리 + 종료 배수. kill 직후 app.exit() 하면 node-pty 네이티브 exit 콜백이 도착하기
  // 전에 프로세스가 죽어 0xC0000409 로 즉사한다(_ptyDrain.cjs / PtyBackend.ts 주석의 실측).
  await endSuite(ok ? 0 : 1)
})

// 전체 스위트 상한(블록마다 실제 pty 스폰 + 재로드 대기가 있어 여유를 둔다).
// 이 상한은 **스위트가 매달렸을 때**를 잡기 위한 것이지 종료 구간을 감시하는 게 아니다 —
// 종료가 시작되면 아래 clearTimeout 으로 해제한다(안 그러면 배수 도중에 fail() 이 끼어들어
// 종료가 두 번 돈다. 실측: 116초 스위트 + 배수가 120초를 넘겨 그대로 SIGSEGV).
// 120→240초(2026-08-11). 이 환경에서 정상 실행이 116~118초라 **여유가 2초뿐이었다** — 다른 무거운
// 작업과 겹치면 상한에 닿아 무관한 검사가 떨어진다(실측: 부하 중 실행에서 R3.1·R4.1 이 각각 한 번씩
// 떨어졌고 단독 실행에서는 266/266 이었다). 상한은 "정상 실행 시간에 맞춘 값"이 아니라 "영영 안
// 끝나는 것을 잡는 안전망"이라 넉넉해야 맞다 — 빠듯하게 잡아 봐야 잡히는 건 진짜 멈춤이 아니라 부하다.
const SMOKE_TIMEOUT_MS = 240000
suiteTimeout = setTimeout(() => fail(`timeout (${SMOKE_TIMEOUT_MS / 1000}s)`), SMOKE_TIMEOUT_MS)
