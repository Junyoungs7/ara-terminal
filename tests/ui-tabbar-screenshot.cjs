// UI-tabbar 산출물 스크린샷 — 세션 0개(빈 탭바, ＋ 버튼만) 캡처.
// 산출물: agent_talk/UI-tabbar-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'UI-tabbar-screenshot.png')

app.whenReady().then(async () => {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, sandbox: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await new Promise((r) => setTimeout(r, 250))
  win.setSize(w, h); await new Promise((r) => setTimeout(r, 400))
  const shot = await win.webContents.capturePage()
  writeFileSync(SHOT, shot.toPNG())
  console.log('SCREENSHOT ' + SHOT + ' bytes=' + shot.toPNG().length)
  app.exit(0)
})
