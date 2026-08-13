// FB-ui2 실기동 스크린샷 4종 — 우측 액티비티 바 / 이관된 모니터 / detach 탭 표시 / 연결 관리자
// 우클릭 메뉴. 배선 패턴은 tests/fbmon-screenshot.cjs·fbtabs-screenshot.cjs 를 그대로 따른다
// (최소 IPC 스텁, 실 main 재구현 아님 — window.ev 계약만 흉내).
//
// 산출물: ① agent_talk/FB-ui2-activitybar.png (우측 액티비티 바 4아이콘)
//         ② agent_talk/FB-ui2-monitor.png     (모니터를 우측 패널로 열고 포트 데이터 표시)
//         ③ agent_talk/FB-ui2-detached.png    (패널에서 뺀 탭 — 은은한 흐림 처리)
//         ④ agent_talk/FB-ui2-connmenu.png    (연결 관리자 좌측 프로필 우클릭 메뉴)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let getWc = () => null

// ── 세션 IPC(로컬 pty) — fbmon-screenshot.cjs 와 같은 attach/backlog 패턴 ──
const ptys = new Map()
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
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.postMessage('session:data:' + id, u)
}
function attachBacklog(id) {
  const st = backlogOf(id)
  st.attached = true
  const total = st.chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of st.chunks) { out.set(c, off); off += c.length }
  return out
}
function wireLocal() {
  ipcMain.handle('session:attach', (_e, { id }) => ({ backlog: attachBacklog(id) }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

// FB-ui2-connmenu 스크린샷용 프로필(연결 관리자 좌측 목록에 뜨는 대상).
const FAKE_PROFILE = {
  id: 'p1',
  name: 'dev-server',
  host: '10.0.4.21',
  port: 22,
  username: 'dev',
  type: 'ssh',
  auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
}
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [FAKE_PROFILE])
  // ContextMenu [복제]/[삭제] 를 실제로 눌러도 죽지 않게(스크린샷 자체는 클릭까지 요구하지 않는다).
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p-new' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'fbui2 스크린샷: 실접속 미수행' }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [FAKE_PROFILE], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    // FB-ui2: activeTab='conn' — 사이드바에 모니터 탭이 더 없다(우측으로 이관).
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
}

function wireTelemetryAndForward() {
  ipcMain.handle('telemetry:start', () => ({ ok: true }))
  ipcMain.handle('telemetry:stop', () => ({ ok: true }))
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('forward:create', () => ({ ok: false, reason: 'network' }))
  ipcMain.handle('forward:stop', () => ({ ok: true }))
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))
}

function pushPorts(sessionId) {
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.send('telemetry:data:' + sessionId, {
    sessionId,
    ports: [
      { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
      { proto: 'tcp', port: 3000, pid: 2451, process: 'node' },
      { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' }
    ],
    stats: null
  })
}

let lastBytes = -1
async function capture(win, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [w, h] = win.getSize()
    win.setSize(w - 1, h)
    await wait(250)
    win.setSize(w, h)
    await wait(400)
    let img = await win.webContents.capturePage()
    let png = img.toPNG()
    if (png.length === 0) { await wait(700); img = await win.webContents.capturePage(); png = img.toPNG() }
    if (png.length !== lastBytes || attempt === 2) {
      lastBytes = png.length
      writeFileSync(shotPath(name), png)
      console.log('SCREENSHOT ' + name + ' bytes=' + png.length + (attempt > 0 ? ' (attempt ' + (attempt + 1) + ')' : ''))
      return
    }
  }
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()
  wireTelemetryAndForward()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(900)

  const newLocal = async () => {
    await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('.tterm-add')?.click(); await wait(150)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(500)
    })()`)
  }

  // ── ① 로컬 세션 1개만 있는 기본 화면 — 우측 액티비티 바(아라·모니터·설정·피드백) ──
  await newLocal()
  await wait(300)
  const barCheck = await win.webContents.executeJavaScript(`(() => ({
    items: Array.from(document.querySelectorAll('.activity-bar .act-item')).map(el => el.getAttribute('data-activity')),
    hasFileTab: !!document.querySelector('.sb-tab[role="tab"]'),
    hasMonitorTabInSidebar: Array.from(document.querySelectorAll('.sb-tab')).some(el => el.textContent.includes('모니터'))
  }))()`)
  console.log('FB-ui2 액티비티 바 상태:', JSON.stringify(barCheck))
  await capture(win, 'FB-ui2-activitybar.png')

  // ── ② 모니터를 우측 패널로 열기 — 활성 SSH 세션 + 포트 데이터 ──
  const sshId = await win.webContents.executeJavaScript(`(async () => {
    const { id } = await window.ev.session.create({ type: 'local', title: 'bash', serverKey: 'dev-server', cwd: undefined, profileId: 'p1', shell: undefined })
    window.__evAdopt?.(id, 'bash', 'dev-server', 'ssh')
    return id
  })()`)
  await wait(400)
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.activity-bar .act-item[data-activity="monitor"]')?.click() })()`)
  await wait(300)
  pushPorts(sshId)
  await wait(400)
  const monitorCheck = await win.webContents.executeJavaScript(`(() => ({
    open: !!document.querySelector('.monitor-panel'),
    rows: document.querySelectorAll('.monitor-panel .prow').length,
    activeIcon: document.querySelector('.activity-bar .act-item[data-activity="monitor"]')?.classList.contains('active')
  }))()`)
  console.log('FB-ui2 모니터 패널 상태:', JSON.stringify(monitorCheck))
  await capture(win, 'FB-ui2-monitor.png')
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.activity-bar .act-item[data-activity="monitor"]')?.click() })()`)
  await wait(200)

  // ── ③ detach 탭 — bash(ssh) 세션이 포커스 패널을 차지한 채 두 번째 로컬 셸을 분할해 나란히 띄운 뒤,
  //     터미널 우클릭 [패널에서 빼기] 로 그중 하나를 뗀다. 뗀 세션의 탭은 은은하게 흐려진다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(400)
  })()`)
  const splitCheck = await win.webContents.executeJavaScript(`(() => ({ paneCount: document.querySelectorAll('.pane-grid .pane').length }))()`)
  console.log('FB-ui2 분할 상태:', JSON.stringify(splitCheck))
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const panes = document.querySelectorAll('.pane-grid .pane')
    const target = panes[panes.length - 1]
    if (!target) return false
    const r = target.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: x, clientY: y }))
    await wait(80)
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
    await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="pane.close"]')?.click()
    return true
  })()`)
  await wait(400)
  const detachCheck = await win.webContents.executeJavaScript(`(() => ({
    paneCount: document.querySelectorAll('.pane-grid .pane').length,
    tabCount: document.querySelectorAll('.term-tabbar .ttab').length,
    detachedCount: document.querySelectorAll('.term-tabbar .ttab.detached').length
  }))()`)
  console.log('FB-ui2 detach 상태:', JSON.stringify(detachCheck))
  await capture(win, 'FB-ui2-detached.png')

  // ── ④ 연결 관리자 좌측 프로필 목록 우클릭 메뉴 ──
  await win.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }))
  })()`)
  await wait(400)
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const row = document.querySelector('.prof-list .prof')
    if (!row) return false
    const r = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 30, clientY: r.top + 10 }))
    await wait(250)
    return true
  })()`)
  await wait(300)
  const connMenuCheck = await win.webContents.executeJavaScript(`(() => ({
    open: !!document.querySelector('.ctx-menu'),
    items: Array.from(document.querySelectorAll('.ctx-menu .ctx-item')).map(el => el.getAttribute('data-action'))
  }))()`)
  console.log('FB-ui2 연결 관리자 메뉴 상태:', JSON.stringify(connMenuCheck))
  await capture(win, 'FB-ui2-connmenu.png')

  const ok =
    JSON.stringify(barCheck.items) === JSON.stringify(['ai', 'monitor', 'settings', 'feedback']) &&
    barCheck.hasMonitorTabInSidebar === false &&
    // 3개 주입(22/3000/5432) 중 22는 기본 필터("사용자 포트", <1024 숨김)에 걸려 2개만 보인다
    // — FB-monitor 가 다듬은 기능이 그대로 살아 있다는 증거이기도 하다.
    monitorCheck.open === true && monitorCheck.rows === 2 &&
    detachCheck.detachedCount >= 1 &&
    connMenuCheck.open === true &&
    JSON.stringify(connMenuCheck.items) === JSON.stringify(['profile.new', 'server.edit', 'server.duplicate', 'server.delete'])
  console.log(ok ? 'FB-UI2 SCREENSHOT OK' : 'FB-UI2 SCREENSHOT FAIL')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 45000)
