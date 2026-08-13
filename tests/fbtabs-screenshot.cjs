// FB-tabs 실기동 스크린샷 — 그룹 래퍼 제거(평평한 탭) / 오버플로 드롭다운 / 드래그 분할 미리보기.
// r1-screenshot.cjs 와 같은 최소 IPC 스텁 패턴(실 main 재구현 아님, window.ev 계약만 흉내).
// 산출물: agent_talk/FB-tabs-flat.png · FB-tabs-overflow.png · FB-tabs-dropzone.png
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

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p-new' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'fbtabs 스크린샷: 실접속 미수행' }))
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    SESSIONS.push({ id, type: 'local', profileId: null, title: spec.title, serverKey: spec.serverKey })
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
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
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(150)
  win.setSize(w, h)
  await wait(300)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(600); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1000, height: 760, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(1200)

  // 1) 평평한 탭바 — 같은 서버(로컬) 세션 2개, 그룹 래퍼 없이 개별 탭 + dot 색 단서.
  const flatCheck = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(200)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(700)
    }
    await newLocal()
    await newLocal()
    await wait(400)
    return {
      tabCount: document.querySelectorAll('.term-tabbar .ttab').length,
      groupWrapperCount: document.querySelectorAll('.term-tabbar .tg').length
    }
  })()`)
  console.log('FB-tabs flat 상태:', JSON.stringify(flatCheck))
  await capture(win, 'FB-tabs-flat.png')

  // 2) 오버플로 드롭다운 — 탭을 더 열어 넘치게 한 뒤 드롭다운을 연다.
  const overflowCheck = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(120)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(280)
    }
    for (let i = 0; i < 10; i++) await newLocal()
    await wait(400)
    const btn = document.querySelector('.tt-overflow-btn')
    if (btn) btn.click()
    await wait(300)
    return {
      hasOverflowBtn: !!btn,
      menuOpen: !!document.querySelector('.ctx-menu'),
      menuItems: document.querySelectorAll('.ctx-menu .ctx-item').length,
      tabCount: document.querySelectorAll('.term-tabbar .ttab').length
    }
  })()`)
  console.log('FB-tabs 오버플로 상태:', JSON.stringify(overflowCheck))
  await capture(win, 'FB-tabs-overflow.png')

  // 3) 드래그 분할 미리보기 — 탭을 패널 위로 끄는 상황을 합성 DragEvent 로 재현(FB-0002).
  const dropzoneCheck = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) // 드롭다운 배경 클릭으로 닫기
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)
    const pane = document.querySelector('.pane-grid .pane')
    const anyTab = document.querySelector('.term-tabbar .ttab')
    if (!pane || !anyTab) return { ok: false }
    const sid = anyTab.getAttribute('data-session-id')
    const r = pane.getBoundingClientRect()
    // 왼쪽 가장자리 근처 — left(세로 분할) 미리보기가 뜨는 지점.
    const x = r.left + r.width * 0.08
    const y = r.top + r.height * 0.5
    const dt = new DataTransfer()
    dt.setData('text/plain', sid)
    pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
    await wait(200)
    const overlay = document.querySelector('.drop-preview')
    return { ok: true, hasOverlay: !!overlay, blocked: overlay ? overlay.classList.contains('blocked') : null }
  })()`)
  console.log('FB-tabs 드롭존 상태:', JSON.stringify(dropzoneCheck))
  await capture(win, 'FB-tabs-dropzone.png')

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  const ok =
    flatCheck.tabCount === 2 && flatCheck.groupWrapperCount === 0 &&
    overflowCheck.hasOverflowBtn === true && overflowCheck.menuOpen === true &&
    dropzoneCheck.ok === true && dropzoneCheck.hasOverlay === true
  console.log(ok ? 'FB-TABS SCREENSHOT OK' : 'FB-TABS SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('FB-tabs screenshot timeout'); app.exit(1) }, 60000)
