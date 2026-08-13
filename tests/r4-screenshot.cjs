// R4 실기동 스크린샷 — 창/셸 크롬을 눈으로 확인한다.
//   ① 메뉴바 드롭다운이 열려 있고(항목 + keymap 단축키 힌트)
//   ② 상태바가 활성 SSH 세션의 user@host:port + 연결 dot + cwd + 세션 수/인코딩/버전을 찍고
//   ③ 사이드바 폭이 드래그로 넓혀진 상태
//   → agent_talk/R4-screenshot.png
// SSH 는 실접속 없이 로컬 pty 를 'ssh' 세션으로 태운다(smoke-boot 과 같은 수법) — 상태바가 보는 것은
// 프로필 메타(user@host:port)와 세션 타입뿐이라 실접속이 없어도 표시 경로는 그대로 탄다.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'R4-screenshot.png')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PROFILE = {
  id: 'r4-p1',
  name: '결제서버',
  host: '10.20.30.40',
  port: 22,
  username: 'deploy',
  auth: { type: 'password', secretRef: { store: 'vault', key: 'r4-p1' } },
  group: '운영'
}

const ptys = new Map()
const SESSIONS = []
let getWc = () => null
let sidebar = { collapsed: false, activeTab: 'conn', width: 264 }

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
  ipcMain.handle('profile:list', () => [PROFILE])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: input }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [PROFILE], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: {
      sidebar: { ...sidebar },
      ctxMenuStyle: 'list',
      font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
      locale: 'ko', scrollback: 10000, copyOnSelect: true
    }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', (_e, s) => { sidebar = s; return { ok: true } })
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => {
    const id = makeSession('ssh', PROFILE.name, PROFILE.name, PROFILE.id)
    return { ok: true, id, title: PROFILE.name }
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
  // [파일] 탭이 열려 있어도 크래시하지 않게(스크린샷은 [연결] 탭을 쓴다).
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/srv/서비스', entries: [] }))
}

// 화면에 찍을 배포 로그 — 상태바의 cwd 와 같은 맥락으로 읽히게.
const E = '\x1b['
const R = E + '0m'
const LOG = [
  `${E}1;36mdeploy@결제서버:/srv/서비스$ ./배포.sh --stage prod${R}`,
  `${E}32m✔${R} 이미지 빌드 완료 · 402MB`,
  `${E}32m✔${R} 헬스체크 통과 (12/12)`,
  `${E}33m⚠${R} 캐시 워밍업 지연 — 재시도 1회`,
  `${E}32m✔${R} 트래픽 전환 완료 · v42 → v43`,
  `${E}90m# 상태바에 user@host:port · 현재 경로가 그대로 뜬다${R}`,
  ''
].join('\r\n')

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

  // 로컬 셸 하나 + SSH 세션 하나(활성) — 상태바 세션 수가 2 가 된다.
  const sshId = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1200)
    await window.__evConnect('${PROFILE.id}')
    await wait(1200)
    return (await window.ev.session.list()).find(s => s.type === 'ssh')?.id || ''
  })()`)

  pushData(sshId, '\r\n' + LOG)
  // OSC7 cwd (F7 경로) — 상태바 [경로] 칸이 여기서 채워진다.
  win.webContents.send('session:cwd:' + sshId, { id: sshId, cwd: '/srv/서비스/릴리스/v43' })
  await wait(1200)

  // R4.3 폭 드래그로 사이드바를 넓힌 뒤, R4.1 Split 메뉴를 펼친 상태로 찍는다.
  const state = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const widthOf = () => Math.round(parseFloat(getComputedStyle(document.querySelector('.sidebar')).width))
    const before = widthOf()
    const rez = document.querySelector('.sb-resizer')
    rez?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: before }))
    await wait(60)
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: before + 60 }))
    await wait(200)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await wait(300)
    const width = widthOf()
    // 메뉴 열기(Split — 항목마다 Ctrl+Shift 힌트가 붙어 화면에서 바로 읽힌다).
    ;[...document.querySelectorAll('.tb-menu span')].find(s => s.textContent === 'Split')?.click()
    await wait(400)
    return {
      width, before,
      menuOpen: !!document.querySelector('.ctx-menu'),
      menuItems: [...document.querySelectorAll('.ctx-menu .ctx-item .ci-lbl')].map(e => e.textContent),
      menuHints: [...document.querySelectorAll('.ctx-menu .ctx-item .ci-kbd')].map(e => e.textContent),
      host: document.querySelector('.statusbar .sb-seg.host .val')?.textContent || '',
      dot: document.querySelector('.statusbar .sb-seg.host .sb-dot')?.className || '',
      cwd: document.querySelector('.statusbar .sb-seg.cwd .val')?.textContent || '',
      right: [...document.querySelectorAll('.statusbar .sb-right .sb-seg')].map(e => e.textContent),
      title: document.title
    }
  })()`)

  console.log('R4 검증:', JSON.stringify(state, null, 0))

  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await wait(250)
  win.setSize(w, h); await wait(600)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(800); img = await win.webContents.capturePage() }
  writeFileSync(SHOT, img.toPNG())
  console.log('SCREENSHOT R4-screenshot.png bytes=' + img.toPNG().length)

  for (const p of ptys.values()) { try { p.kill() } catch {} }

  const ok =
    state.menuOpen === true &&
    state.menuItems.includes('가로 분할') &&
    state.menuHints.includes('Ctrl+Shift+-') &&
    state.host === 'deploy@10.20.30.40:22' &&
    state.dot.includes('connected') &&
    state.cwd === '/srv/서비스/릴리스/v43' &&
    state.right.some((s) => s.includes('UTF-8')) &&
    state.width === state.before + 60 &&
    state.title === 'A.R.A — 결제서버'
  console.log(ok ? 'R4 SCREENSHOT OK (메뉴 드롭다운 · 상태바 실데이터 · 사이드바 폭 · 창 타이틀)' : 'R4 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R4 screenshot timeout'); app.exit(1) }, 90000)
