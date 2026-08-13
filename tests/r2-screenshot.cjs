// R2 실기동 스크린샷 — 분할이 "기존 창을 나란히 배치"하는지 + 탭 인라인 이름 변경을 눈으로 확인한다.
// 시나리오: 로컬 셸 1개 + 같은 서버 SSH 2세션(·2 자동 구분) → 세로 분할로 배경 세션이 새 패널에 올라온다
//           (새 셸 생성 0) → 탭 더블클릭으로 이름 편집 중인 화면.
// 산출물: agent_talk/R2-split-screenshot.png, agent_talk/R2-rename-screenshot.png
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

const PROFILES = [
  { id: 'p-dev', name: 'dev-server', host: '10.20.30.40', port: 22, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p-dev' } }, group: '개발' }
]

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
  const opts = { name: 'xterm-256color', cols: 100, rows: 26, cwd: process.cwd(), env: process.env }
  if (win) { opts.useConpty = true; opts.useConptyDll = true }
  return pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
}

// 실 main(MainSessionManager.nextTitle)과 같은 규칙: 이미 쓰는 이름이면 ·2, ·3 …
function nextTitle(base) {
  const used = new Set(SESSIONS.filter((s) => ptys.has(s.id)).map((s) => s.title))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(base + '·' + n)) return base + '·' + n
}

function register(id, p, meta) {
  ptys.set(id, p)
  SESSIONS.push(meta)
  p.onData((d) => pushData(id, d))
  p.onExit(() => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode: 0 }); ptys.delete(id) })
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...PROFILES[0], ...input } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  // 실접속 대신 로컬 pty 를 SSH 세션으로 태운다(탭 그룹·이름 자동 구분 확인이 목적).
  ipcMain.handle('ssh:connect', (_e, { profileId }) => {
    const profile = PROFILES.find((p) => p.id === profileId)
    if (!profile) return { ok: false, reason: 'network', message: 'no profile' }
    const id = 'ssh-' + Math.random().toString(36).slice(2)
    const title = nextTitle(profile.name)
    register(id, spawnPty(), { id, type: 'ssh', profileId, cwd: undefined, title, serverKey: profile.name })
    return { ok: true, id, title }
  })
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    register(id, spawnPty(), { id, type: 'local', profileId: null, cwd: spec.cwd, title: spec.title, serverKey: spec.serverKey })
    return { id }
  })
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
    if (s && title) s.title = title
    return { ok: true }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(250)
  win.setSize(w, h)
  await wait(400)
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
  await wait(1400)

  const split = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const nl = navigator.userAgent.includes('Windows') ? '\\r\\n' : '\\n'
    const panes = () => document.querySelectorAll('.pane-grid .pane').length
    const sessionCount = async () => (await window.ev.session.list()).length
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(250)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1400)
      const list = await window.ev.session.list()
      return list[list.length - 1].id
    }
    // ① 로컬 셸 — 배포 로그 흉내.
    const local = await newLocal()
    window.ev.session.input(local, 'echo "[로컬] 빌드 산출물 검증 — 결제·승인·정산"' + nl)
    await wait(900)

    // ② 같은 서버로 SSH 2세션 → 탭 이름이 dev-server / dev-server·2 로 자동 구분된다(R2.1).
    await window.__evConnect('p-dev'); await wait(1300)
    await window.__evConnect('p-dev'); await wait(1300)
    const sshIds = (await window.ev.session.list()).filter(s => s.type === 'ssh').map(s => s.id)
    window.ev.session.input(sshIds[0], 'echo "[dev-server] 배포 스크립트 대기 중"' + nl)
    window.ev.session.input(sshIds[1], 'echo "[dev-server·2] 로그 tail — 같은 서버 두 번째 세션"' + nl)
    await wait(1400)

    // ③ 세로 분할: 새 셸을 만들지 않고 배경 탭(직전 사용 세션)을 왼쪽/오른쪽에 나란히 올린다.
    const before = await sessionCount()
    const panesBefore = panes()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(1500)
    const after = await sessionCount()
    const shown = [...document.querySelectorAll('.pane-grid .pane')]
      .filter(p => getComputedStyle(p).display !== 'none')
      .map(p => p.querySelector('.ptitle')?.textContent || '')
    const tabNames = [...document.querySelectorAll('.term-tabbar .ttab .tlabel')].map(t => t.textContent)
    return { panesBefore, panes: panes(), before, after, shown, tabNames }
  })()`)

  console.log('R2 분할 검증:', JSON.stringify(split))
  await capture(win, 'R2-split-screenshot.png')

  const rename = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 로컬 탭을 더블클릭 → 인라인 편집. 편집 중 상태 그대로 촬영한다(Enter 는 누르지 않는다).
    const tab = [...document.querySelectorAll('.term-tabbar .ttab')].find(t => /셸/.test(t.textContent))
    tab?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(400)
    const input = document.querySelector('.term-tabbar .ttab .tt-edit')
    if (input) {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(input, '결제 배포')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.setSelectionRange(4, 4)
    }
    await wait(300)
    return { editing: !!input, value: input?.value || '' }
  })()`)

  console.log('R2 이름 변경 검증:', JSON.stringify(rename))
  await capture(win, 'R2-rename-screenshot.png')

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  const ok =
    split.panesBefore === 1 &&
    split.panes === 2 &&
    split.before === split.after && // 분할이 새 셸을 만들지 않았다
    split.tabNames.includes('dev-server') &&
    split.tabNames.includes('dev-server·2') &&
    rename.editing === true
  console.log(ok ? 'R2 SCREENSHOT OK (분할=기존 세션 배치 · 이름 자동 구분 · 인라인 편집)' : 'R2 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R2 screenshot timeout'); app.exit(1) }, 90000)
