// UI-font 폰트 전환 증거 — 설정에서 터미널 폰트를 D2Coding으로 바꾼 뒤 드로어를 닫고
// 사이드바·상태바가 즉시 같은 폰트로 바뀌는지 한 화면에 캡처(재시작 없이, 열린 세션 포함).
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
const OUT = join(__dirname, '..', 'out')
const outPath = (name) => join(__dirname, '..', 'agent_talk', name)

const ptys = new Map()
let getWc = () => null
ipcMain.handle('session:create', () => {
  const id = 'loc-' + Math.random().toString(36).slice(2)
  const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env, useConpty: true, useConptyDll: true }
  const p = pty.spawn('powershell.exe', ['-NoLogo'], opts)
  ptys.set(id, p)
  p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
  p.onExit(() => {})
  return { id }
})
ipcMain.handle('session:resize', () => ({ ok: true }))
ipcMain.handle('session:destroy', () => ({ ok: true }))
ipcMain.handle('session:list', () => [])
ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
ipcMain.on('session:pause', () => {})
ipcMain.on('session:resume', () => {})
const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 } }
ipcMain.handle('app:getVersion', () => '0.1.0')
ipcMain.handle('profile:list', () => [])
ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
ipcMain.handle('ui:setGroups', () => ({ ok: true }))
ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119', webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
    getWc = safeWc(() => win)
    await win.loadFile(join(OUT, 'renderer', 'index.html'))
    await new Promise((r) => setTimeout(r, 700))
    await win.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready
      const btn = [...document.querySelectorAll('button')].find(b => /로컬 셸/.test(b.textContent))
      btn?.click()
    })()`)
    await new Promise((r) => setTimeout(r, 900))

    const before = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sess-node .sess-name')).fontFamily`)

    // 설정 드로어 열기 → [폰트] → D2Coding 선택 → 닫기.
    await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      document.querySelector('.titlebar .tb-gear')?.click(); await wait(400)
      document.querySelector('.drawer.open .set-nav span[data-section="font"]')?.click(); await wait(250)
      const d2 = [...document.querySelectorAll('.drawer.open .font-list .font-item')].find(f => /D2Coding/.test(f.textContent))
      d2?.click(); await wait(300)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(400)
    })()`)
    await new Promise((r) => setTimeout(r, 400))

    const after = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sess-node .sess-name')).fontFamily`)
    const term = await win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--term').trim()`)
    const mono = await win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()`)

    let full = await win.webContents.capturePage()
    for (let i = 0; i < 5 && full.toPNG().length === 0; i++) { await new Promise((r) => setTimeout(r, 300)); full = await win.webContents.capturePage() }
    writeFileSync(outPath('UI-font-switch.png'), full.toPNG())

    console.log('before=' + before)
    console.log('after=' + after)
    console.log('--term=' + term)
    console.log('--mono=' + mono)
    console.log('SWITCH_OK changed=' + (before !== after) + ' monoMatchesTerm=' + (term === mono))
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 25000)
