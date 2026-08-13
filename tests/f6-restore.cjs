// F6 E2E 복원 하네스 — 실(real) main 모듈로 저장→재기동→복원 2시나리오를 실증한다.
//  A) 정상 복원: 로컬 2(서로 다른 cwd) + SSH 1(하네스) + 2분할 → 저장 → 재기동 → 3세션·분할·cwd·활성 탭 복원
//  B) 부분 복원(C-4): SSH 하네스를 내려 재접속 실패 유도 → 로컬 2 정상 복원 + SSH 페인만 오류 카드(재시도)
// 스크린샷: agent_talk/F6-restore-screenshot.png, agent_talk/F6-partial-screenshot.png
// "재기동"은 창을 닫고 WorkspaceStore/SessionManager 를 새로 만들어 같은 workspace.json 에서 하이드레이트하는 것으로 흉내낸다.
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, existsSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const {
  WorkspaceStore,
  HistoryStore,
  MainSessionManager,
  SafeStorageSecretStore,
  ProfileStore,
  registerWorkspaceIpc,
  registerSessionIpc,
  registerProfileIpc,
  registerSshIpc,
  startPasswordServer
} = require('./.f6-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 매 재기동 시 IPC 핸들러를 새로 등록하려면 기존 핸들러를 지워야 한다(ipcMain.handle 중복 금지).
const INVOKE_CH = [
  'workspace:load', 'workspace:save', 'ui:setPrefs', 'ui:setGroups', 'ui:setFont', 'ui:setSidebar', 'app:getVersion',
  'session:create', 'session:resize', 'session:destroy', 'session:list', 'session:attach', 'session:rename',
  'session:autoTitle',
  'profile:list', 'profile:save', 'profile:delete', 'ssh:connect', 'ssh:forgetHostKey',
  // F11: registerWorkspaceIpc 가 함께 등록한다 — 여기 빠지면 재기동(boot 재호출)에서
  // "second handler" 로 죽는다.
  'history:load', 'history:append'
]
const SEND_CH = ['session:input', 'session:pause', 'session:resume']
function clearIpc() {
  for (const c of INVOKE_CH) ipcMain.removeHandler(c)
  for (const c of SEND_CH) ipcMain.removeAllListeners(c)
}

const wsPath = () => join(app.getPath('userData'), 'workspace.json')

let win = null
let sessions = null
const CURRENT = { store: null, profiles: null } // 현재 실행의 실 store(재기동 시 교체) — flush 참조용.
const getWc = () => (win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null)

// 하나의 "실행" 배선: 실 WorkspaceStore + SessionManager + Profile/SSH + Workspace IPC.
function boot(userData) {
  clearIpc()
  const store = new WorkspaceStore(join(userData, 'workspace.json'), '0.1.0')
  const history = new HistoryStore(join(userData, 'history.json'))
  const secrets = new SafeStorageSecretStore(join(userData, 'secrets.vault'))
  const profiles = new ProfileStore(store, secrets)
  registerWorkspaceIpc(store, history)
  sessions = registerSessionIpc(getWc)
  registerProfileIpc(profiles)
  registerSshIpc(profiles, store, sessions)
  // app:getVersion 은 registerWorkspaceIpc 가 이미 등록(app.getVersion) — 중복 등록 금지.
  CURRENT.store = store
  CURRENT.profiles = profiles
  return { store, profiles }
}

// 창은 1회 생성하고 재기동은 loadFile 재로드로 흉내낸다(Windows 에서 destroy() 가 이벤트루프를 막는 문제 회피).
// IPC 는 window 와 독립(ipcMain 전역)이라 boot() 재등록 후 reload 하면 renderer 가 fresh 하게 boot 복원을 재실행한다.
async function ensureWindow() {
  if (win && !win.isDestroyed()) {
    await win.loadFile(join(OUT, 'renderer', 'index.html')) // 재로드 = 재기동
    await wait(700)
    return win
  }
  const w = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win = w
  await w.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(700)
  return w
}
// (진단 로그는 하네스 디버깅 편의를 위해 유지 — 프로덕션 코드가 아님)

async function capture(name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await wait(200); win.setSize(w, h); await wait(350)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(700); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

const checks = []
const check = (name, pass) => { checks.push([name, pass]); console.log((pass ? 'PASS ' : 'FAIL ') + name) }

async function run() {
  const userData = mkdtempSync(join(tmpdir(), 'ev-f6-'))
  app.setPath('userData', userData)

  // 로컬 셸이 cwd 를 바꾸도록 실제 cd 명령을 보낸다(OSC7 셸 통합이 cwd 를 방출 → main 이 추적).
  // Windows=PowerShell, POSIX=sh. 서로 다른 cwd 2곳.
  const isWin = process.platform === 'win32'
  const cdCmd = (p) => (isWin ? `cd '${p}'\r` : `cd '${p}'\n`)
  const dirA = mkdtempSync(join(tmpdir(), 'ev-cwdA-'))
  const dirB = mkdtempSync(join(tmpdir(), 'ev-cwdB-'))

  // ── SSH 하네스 기동(시나리오 A 용). 비밀번호 인증 에코 서버. ──
  const harness = await startPasswordServer({ password: 'f6pw' })

  // ═══ 실행 1: 세션 구성 + 저장 ═══
  boot(userData)
  await ensureWindow()

  // SSH 프로필 저장(호스트키 TOFU 최초 접속을 위해 acceptHostKey 재호출 경로 사용).
  await win.webContents.executeJavaScript(`(async () => {
    const { profile } = await window.ev.profile.save({
      name: 'f6-remote', host: '127.0.0.1', port: ${harness.port}, username: 'dev',
      authType: 'password', secret: 'f6pw', group: '개발'
    })
    window.__f6profileId = profile.id
    return profile.id
  })()`)

  // 로컬1(pane1) 열고 cd dirA (→ OSC7 로 cwd 추적).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // ＋ 는 메뉴를 연다(UX 라운드1) — "로컬 셸"까지 골라야 세션이 생긴다.
    document.querySelector('.tterm-add')?.click(); await wait(300)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1200)
    const list = await window.ev.session.list()
    if (list[0]) window.ev.session.input(list[0].id, ${JSON.stringify(cdCmd(dirA.replace(/\\/g, '/')))})
    await wait(1000)
    return true
  })()`)
  // 로컬2(분할 pane2) — Ctrl+- 새 세션+패널. cd dirB. (이후 pane2 는 SSH 로 교체 → 로컬2 는 배경 탭)
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(1400)
    const list = await window.ev.session.list()
    const last = list[list.length - 1]
    if (last) window.ev.session.input(last.id, ${JSON.stringify(cdCmd(dirB.replace(/\\/g, '/')))})
    await wait(1000)
    return list.length
  })()`)

  // SSH 접속 → 포커스 패널(pane2)에 SSH 를 표시(트리 서버 노드 클릭 = connectProfile → 세션 편입 + 활성).
  // showSession 이 포커스 패널의 세션을 SSH 로 교체 → pane1=로컬1, pane2=SSH, 로컬2 는 배경 탭.
  const sshAdopt = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const id = window.__f6profileId
    // 최초 호스트키(TOFU): confirm() 을 우회해 직접 acceptHostKey 로 knownHosts 에 저장 후 그 세션은 정리.
    // 이후 트리 클릭의 connectProfile 은 knownHosts 일치로 confirm 없이 접속된다.
    let seed = await window.ev.ssh.connect(id)
    if (!seed.ok && seed.reason === 'hostKeyNew') seed = await window.ev.ssh.connect(id, true)
    if (seed.ok) await window.ev.session.destroy(seed.id)
    await wait(600)
    // 실 connectProfile 경로(seam)로 접속 → adopt + 활성 → 포커스 패널(pane2)에 SSH 표시.
    if (window.__evConnect) await window.__evConnect(id)
    await wait(2000)
    const list = await window.ev.session.list()
    return { ok: seed.ok, reason: seed.reason, afterCount: list.length, types: list.map(s=>s.type).join(',') }
  })()`)
  console.log('실행1 SSH connect:', JSON.stringify(sshAdopt))
  await wait(1500)
  const diag = await win.webContents.executeJavaScript(`(async () => {
    const list = await window.ev.session.list()
    return { count: list.length, types: list.map(s => s.type + ':' + (s.cwd||'')).join(' | '),
      panes: document.querySelectorAll('.pane-grid .pane').length,
      tabs: document.querySelectorAll('.term-tabbar .ttab').length }
  })()`)
  console.log('실행1 진단:', JSON.stringify(diag))

  // 저장 반영을 위해 persist 가 돌 시간을 준 뒤, before-quit 대신 store.flush() 로 디스크에 확정.
  await wait(1500)
  // 실행1의 store 는 boot() 클로저 안 → 재확보를 위해 workspace.load()/save() 왕복 후 새 store 로 flush.
  // 렌더러 persist 가 workspace:save 로 store.update() 했으므로, 같은 파일을 새 store 로 열면 최신본이 로드된다.
  // 단 update 는 30s 디바운스라 아직 디스크에 없을 수 있으므로, 명시적으로 현재 스냅샷을 저장한다.
  await win.webContents.executeJavaScript(`(async () => {
    // 종료 직전 최신 상태 저장을 강제(session.list 최신 cwd·SSH 포함). 테스트 seam.
    if (window.__evPersist) await window.__evPersist()
    return true
  })()`)
  await wait(800)

  // 렌더러 persist 는 workspace:save → store.update()(30s 디바운스). before-quit 처럼 즉시 디스크로 내린다.
  CURRENT.store.flush()

  const savedSnap = JSON.parse(readFileSync(wsPath(), 'utf8'))
  console.log('저장된 세션 수:', savedSnap.sessions.length, '| cwd들:', savedSnap.sessions.map((s) => s.type + ':' + (s.cwd || '')).join(', '))
  check('저장: 세션 3개(로컬2+SSH1)', savedSnap.sessions.length === 3)
  check('저장: SSH 세션 profileId 기록', savedSnap.sessions.some((s) => s.type === 'ssh' && s.profileId))
  const localCwds = savedSnap.sessions.filter((s) => s.type === 'local').map((s) => (s.cwd || '').toLowerCase())
  check('저장: 로컬 2세션이 서로 다른 cwd 추적(OSC7)', localCwds.length === 2 && localCwds[0] && localCwds[1] && localCwds[0] !== localCwds[1])
  check('저장: layout 이 2+ 패널(분할)', savedSnap.layout.type === 'split')

  // ═══ 재기동(시나리오 A: 정상 복원) — 세션매니저/스토어를 새로 만들고 renderer 를 재로드해 하이드레이트 ═══
  console.log('재기동A 시작...')
  const prev1 = sessions
  boot(userData) // 같은 userData → 같은 workspace.json 로드 + 새 SessionManager
  await ensureWindow() // 재로드 = 재기동, boot 복원 재실행
  try { prev1?.destroyAll() } catch (e) { console.log('destroyAll1 err', e.message) } // 이전 실행 pty 정리
  console.log('재기동A 창 로드 완료')
  // SSH 프로필 있으므로 트리 렌더 → 부트 복원이 로컬2 재스폰 + SSH 재접속.
  await wait(3500)

  const a = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await wait(500)
    const list = await window.ev.session.list()
    const panes = document.querySelectorAll('.pane-grid .pane').length
    const errCards = document.querySelectorAll('.pane-grid .restore-err-card').length
    const tabs = document.querySelectorAll('.term-tabbar .ttab').length
    // R3.9 로 패널 헤더 타입 칩이 사라졌다 — SSH 세션 복원 여부는 세션 목록으로 본다.
    const sshChip = list.filter((s) => s.type === 'ssh').length
    const activeTab = document.querySelectorAll('.term-tabbar .ttab.active').length
    // 복원 직후 화면: 보이는 패널의 터미널에 출력(프롬프트 등)이 실제로 찍혀 있어야 한다(R1.1 attach 재생).
    // R3.4 WebGL 렌더러에서는 내용이 canvas 로 가므로 xterm 버퍼를 직접 읽는다(DOM textContent 는 폴백).
    const paneText = (p) => {
      const id = p.dataset.sessionId
      return ((id && window.__evTerm(id)?.text()) || p.querySelector('.term-pane')?.textContent || '').trim()
    }
    const painted = [...document.querySelectorAll('.pane-grid .pane')]
      .filter((p) => getComputedStyle(p).display !== 'none')
      .filter((p) => paneText(p).length > 0).length
    return { sessionCount: list.length, panes, errCards, tabs, sshChip, activeTab, painted }
  })()`)
  console.log('시나리오A 복원:', JSON.stringify(a))
  check('A: 세션 3개 복원(로컬2+SSH1)', a.sessionCount === 3)
  check('A: 분할 패널 2개 복원', a.panes === 2)
  check('A: 오류 패널 없음(전체 정상 복원)', a.errCards === 0)
  check('A: 활성 탭 1개', a.activeTab === 1)
  check('A: 복원된 패널 2개 모두 출력 표시(빈 화면 아님)', a.painted === 2)
  await capture('F6-restore-screenshot.png')

  // ═══ 재기동(시나리오 B: 부분 복원) — SSH 하네스를 내려 재접속 실패 유도 ═══
  console.log('재기동B 시작...')
  const prev2 = sessions
  // 이전 실행 SSH 세션을 먼저 끊어야 harness.close() 가 완료된다(열린 연결이 남으면 server.close 가 대기).
  try { prev2?.destroyAll() } catch (e) { console.log('destroyAll2 err', e.message) }
  await wait(500)
  await harness.close() // SSH 서버 down → 재접속 실패
  console.log('  harness closed')
  boot(userData)
  await ensureWindow()
  console.log('  재기동B 로드 완료 — SSH 재접속 실패 대기')
  // SSH 재접속 실패 확정(readyTimeout 최대 10s) + 오류 카드 렌더 대기.
  await wait(13000)

  const b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await wait(500)
    const list = await window.ev.session.list()
    const panes = document.querySelectorAll('.pane-grid .pane').length
    const errCards = document.querySelectorAll('.pane-grid .restore-err-card').length
    const retryBtn = !!document.querySelector('.pane-grid .restore-err-card .rec-btn.primary')
    const errTitle = document.querySelector('.pane-grid .restore-err-card .rec-title')?.textContent || ''
    // 로컬 세션은 정상(터미널 페인 존재). 세션마다 xterm 이 상주하므로(R1.1) 화면에 보이는 것만 센다.
    const termPanes = [...document.querySelectorAll('.pane-grid .pane')]
      .filter((p) => getComputedStyle(p).display !== 'none' && p.querySelector('.term-pane')).length
    return { sessionCount: list.length, panes, errCards, retryBtn, errTitle, termPanes }
  })()`)
  console.log('시나리오B 부분복원:', JSON.stringify(b))
  // 저장된 배치: pane1=로컬1, pane2=SSH, 로컬2 는 배경 탭. 부분 복원 시 pane2 만 오류, 나머지 정상.
  check('B: 로컬 2세션은 정상 복원(session.list=2)', b.sessionCount === 2)
  check('B: SSH 페인만 오류 카드 1개(부분 복원)', b.errCards === 1)
  check('B: 오류 카드에 재시도 버튼', b.retryBtn === true)
  check('B: 정상 로컬 터미널 페인 렌더(오류 아닌 패널)', b.termPanes === 1)
  check('B: 전체 실패 아님(패널 2개 = 로컬1 + SSH오류)', b.panes === 2)
  await capture('F6-partial-screenshot.png')

  let ok = true
  for (const [, pass] of checks) if (!pass) ok = false
  console.log(ok ? '\nF6 E2E ALL PASS' : '\nF6 E2E FAIL')
  try { sessions?.destroyAll() } catch {}
  app.exit(ok ? 0 : 1)
}

app.whenReady().then(() =>
  run().catch((e) => {
    console.error('F6 harness ERROR:', e && e.stack ? e.stack : e)
    app.exit(1)
  })
)

setTimeout(() => { console.log('F6 harness timeout'); app.exit(1) }, 150000)
