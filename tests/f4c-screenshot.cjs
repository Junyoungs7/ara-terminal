// F4c 실기동 스크린샷 — 로컬 세션 위에서 라디얼/팔레트/치트시트를 실제로 열어 3장 캡처.
// 산출물: agent_talk/F4c-radial-screenshot.png / F4c-palette-screenshot.png / F4c-cheatsheet-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

// 로컬 pty 세션 IPC(스크린샷용 최소 배선).
const ptys = new Map()
let getWc = () => null
function wireLocal() {
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
    p.onExit(({ exitCode }) => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {} ; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

const UI = { ctxMenuStyle: 'radial' }
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' } }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
}

// capturePage 는 소프트웨어 컴포지터에서 첫 프레임에 고정될 수 있어(모든 캡처가 동일 바이트가 됨),
// 캡처 직전 창을 1px 리사이즈해 강제로 새 프레임을 커밋시킨 뒤 캡처한다.
async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await new Promise((r) => setTimeout(r, 250))
  win.setSize(w, h)
  await new Promise((r) => setTimeout(r, 350))
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await new Promise((r) => setTimeout(r, 800)); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  // 로컬 세션 1개 + 한 번 분할해서 화면을 채운다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(700)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true })); await wait(600)
    // 터미널에 한글 명령 출력(배경 채우기).
    return true
  })()`)
  // 활성 pty 에 한글 출력.
  for (const [, p] of ptys) { try { p.write('echo 안녕하세요 A.R.A 라디얼 컨텍스트 메뉴\r') } catch {} }
  await new Promise((r) => setTimeout(r, 1000))

  // 1) 라디얼 — 우클릭으로 전개 후 스태거 완료 대기.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const grid = document.querySelector('.pane-grid')
    const r = grid.getBoundingClientRect()
    grid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 }))
    await wait(550)
    return document.querySelectorAll('.radial-menu.open .ri.shown').length
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  await capture(win, 'F4c-radial-screenshot.png')

  // 라디얼 닫기 → 팔레트로 전환.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(400)
    document.querySelector('.menu-toggle')?.click(); await wait(200)
    const grid = document.querySelector('.pane-grid')
    const r = grid.getBoundingClientRect()
    grid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width/2 - 140, clientY: r.top + 60 }))
    await wait(350)
    return document.querySelectorAll('.smart-palette.open .sp-item').length
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  await capture(win, 'F4c-palette-screenshot.png')

  // 팔레트 닫기 → 치트시트.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(400)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' })); await wait(400)
    return !!document.querySelector('.cheatsheet.open')
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  await capture(win, 'F4c-cheatsheet-screenshot.png')

  console.log('F4c screenshots done (radial / palette / cheatsheet)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 30000)
