// R5+R6 실기동 스크린샷 2장.
//   ① agent_talk/R5-settings-screenshot.png — 설정 창 [일반] 탭(좌측 nav 5섹션 + 우클릭 스타일·
//      선택 자동복사·스크롤백), 뒤로 터미널 출력이 보이는 상태.
//   ② agent_talk/R6-groups-screenshot.png — 연결 트리의 그룹들 + 검색 필터가 걸린 상태 +
//      그룹 우클릭 메뉴(새 연결/이름 변경/삭제).
// SSH 는 실접속 없이 로컬 pty 를 'ssh' 세션으로 태운다(r4-screenshot 과 같은 수법).
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

// 그룹이 여러 개여야 R6 정렬·검색·그룹 메뉴가 화면에서 읽힌다.
const mkProfile = (id, name, host, group) => ({
  id,
  name,
  host,
  port: 22,
  username: 'deploy',
  auth: { type: 'password', secretRef: { store: 'vault', key: id } },
  ...(group ? { group } : {})
})
let PROFILES = [
  mkProfile('p1', '결제서버', '10.20.30.40', '운영'),
  mkProfile('p2', '정산배치', '10.20.30.41', '운영'),
  mkProfile('p3', 'web-dev01', '192.168.0.11', '개발'),
  mkProfile('p4', '사내위키', '192.168.0.90')
]
// R6: 프로필이 없는 빈 그룹도 트리에 남는다(ui.groups).
let GROUPS = ['결제팀']
const UI = {
  sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
  ctxMenuStyle: 'list',
  font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
  locale: 'ko',
  scrollback: 10000,
  copyOnSelect: true,
  cursorStyle: 'block',
  cursorBlink: true,
  bell: 'off'
}

const ptys = new Map()
const SESSIONS = []
let getWc = () => null

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

function spawnPty() {
  const win = process.platform === 'win32'
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: process.cwd(), env: process.env }
  if (win) { opts.useConpty = true; opts.useConptyDll = true }
  return pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
}

function makeSession(type, title, serverKey, profileId) {
  const id = type + '-' + Math.random().toString(36).slice(2)
  const p = spawnPty()
  ptys.set(id, p)
  SESSIONS.push({ id, type, profileId: profileId ?? null, cwd: undefined, title, serverKey })
  p.onData((d) => pushData(id, d))
  p.onExit(() => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode: 0 }); ptys.delete(id) })
  return id
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, input) => {
    const id = input.id || 'p' + (PROFILES.length + 1)
    const profile = {
      id, name: input.name, host: input.host, port: input.port, username: input.username,
      auth: { type: 'password', secretRef: { store: 'vault', key: id } },
      ...(input.group ? { group: input.group } : {})
    }
    PROFILES = [...PROFILES.filter((p) => p.id !== id), profile]
    return { profile }
  })
  ipcMain.handle('profile:delete', (_e, { id }) => { PROFILES = PROFILES.filter((p) => p.id !== id); return { ok: true } })
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { ...UI, groups: GROUPS }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', (_e, { groups }) => { GROUPS = groups; return { ok: true } })
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
  ipcMain.handle('ui:setSidebar', (_e, s) => { UI.sidebar = s; return { ok: true } })
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', (_e, { profileId }) => {
    const p = PROFILES.find((x) => x.id === profileId)
    const id = makeSession('ssh', p.name, p.name, p.id)
    return { ok: true, id, title: p.name }
  })
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))
  ipcMain.handle('session:create', (_e, spec) => ({ id: makeSession('local', spec.title, spec.serverKey, null) }))
  ipcMain.handle('session:attach', (_e, { id }) => {
    const st = backlogOf(id)
    st.attached = true
    const total = st.chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of st.chunks) { out.set(c, off); off += c.length }
    return { backlog: out }
  })
  ipcMain.handle('session:rename', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    if (s && title) { s.title = title; s.manualTitle = true }
    return { ok: true }
  })
  ipcMain.handle('session:autoTitle', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    if (!s || !title || s.manualTitle || /(?:^|[\\/])[^\\/\s]+\.exe$/i.test(title.trim())) return { applied: false }
    s.title = title
    return { applied: true }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/srv/서비스', entries: [] }))
}

const E = '\x1b['
const R = E + '0m'
const LOG = [
  `${E}1;36mdeploy@결제서버:/srv/서비스$ ./배포.sh --stage prod${R}`,
  `${E}32m✔${R} 이미지 빌드 완료 · 402MB`,
  `${E}32m✔${R} 헬스체크 통과 (12/12)`,
  `${E}33m⚠${R} 캐시 워밍업 지연 — 재시도 1회`,
  `${E}90m# 설정 창에서 바꾼 값은 이 세션에도 즉시 적용된다${R}`,
  ''
].join('\r\n')

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(250)
  win.setSize(w, h)
  await wait(500)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(800); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  win.focus()
  await wait(1500)

  // 세션 하나(SSH) 확보 → 배포 로그를 찍어 뒤 배경이 빈 화면이 아니게 한다.
  const sshId = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await window.__evConnect('p1')
    await wait(1400)
    return (await window.ev.session.list()).find(s => s.type === 'ssh')?.id || ''
  })()`)
  pushData(sshId, '\r\n' + LOG)
  await wait(1200)

  // ── ① 설정 창 [일반] ──
  const s1 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 진입점 ①: 타이틀바 기어.
    document.querySelector('.titlebar .tb-gear')?.click()
    await wait(500)
    const rowByLabel = (text) => [...document.querySelectorAll('.drawer.open .set-row')]
      .find(r => (r.querySelector('.sr-label')?.textContent || '').includes(text))
    // 스크롤백을 눈에 띄는 값으로 움직여 슬라이더·수치가 화면에 보이게 한다.
    const sb = rowByLabel('스크롤백')?.querySelector('input[type=range]')
    if (sb) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(sb, '30000')
      sb.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(400)
    return {
      open: !!document.querySelector('.drawer.open'),
      nav: [...document.querySelectorAll('.drawer.open .set-nav span')].map(s => s.textContent),
      onSection: document.querySelector('.drawer.open .set-nav span.on')?.textContent || '',
      rows: [...document.querySelectorAll('.drawer.open .set-row .sr-label')].map(l => l.textContent),
      scrollbackVal: rowByLabel('스크롤백')?.querySelector('.v')?.textContent || ''
    }
  })()`)
  console.log('R5 설정 창:', JSON.stringify(s1))
  await capture(win, 'R5-settings-screenshot.png')

  // ── ② 그룹 관리 + 검색 ──
  const s2 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) // 설정 창 닫기
    await wait(400)
    // 검색: "10.20" → 운영 그룹 두 대만 남는다(이름·호스트·그룹 실시간 필터).
    const input = document.querySelector('.sb-panel.active .sb-search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '10.20')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(400)
    const filtered = [...document.querySelectorAll('.tree .srv-node .sname')].map(n => n.textContent)
    // 그룹 헤더 우클릭 → 새 연결 / 이름 변경 / 삭제.
    const hd = [...document.querySelectorAll('.tree .srv-hd')].find(h => h.textContent.includes('운영'))
    // 메뉴를 그룹·서버 행 아래에 펼쳐 트리 내용이 가려지지 않게 한다(스크린샷 가독성).
    const r = hd.getBoundingClientRect()
    hd.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 70, clientY: r.bottom + 78 }))
    await wait(400)
    return {
      filtered,
      menu: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action),
      menuLabels: [...document.querySelectorAll('.ctx-menu .ctx-item .ci-lbl')].map(i => i.textContent)
    }
  })()`)
  console.log('R6 그룹/검색:', JSON.stringify(s2))
  await capture(win, 'R6-groups-screenshot.png')

  for (const p of ptys.values()) { try { p.kill() } catch {} }

  const ok =
    s1.open === true &&
    s1.nav.join(',') === '일반,터미널,폰트,단축키,정보' &&
    s1.onSection === '일반' &&
    s1.rows.length === 3 &&
    s1.scrollbackVal.replace(/[^0-9]/g, '') === '30000' &&
    s2.filtered.join(',') === '결제서버,정산배치' &&
    s2.menu.join(',') === 'group.newConn,group.rename,group.delete'
  console.log(ok ? 'R5R6 SCREENSHOT OK (설정 5섹션 · 그룹 메뉴 · 검색 필터)' : 'R5R6 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R5R6 screenshot timeout'); app.exit(1) }, 90000)
