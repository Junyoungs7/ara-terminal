// 한글 마이크로 텍스트 전/후 비교용 크롭 캡처.
// 탭바(‘세션 없음’ placeholder + 도구 버튼 3종)와 상태바를 원본 배율로 잘라 낸다.
// 확대는 합성 단계에서 nearest-neighbor 로 — 실제 픽셀을 그대로 보여주기 위함.
// ARA_CROP_OUT 에 저장 경로를 준다.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
const OUT = join(__dirname, '..', 'out')
const DEST = process.env.ARA_CROP_OUT || join(__dirname, '..', 'agent_talk', '_crop.png')

app.whenReady().then(async () => {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, sandbox: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  // 세션을 만들지 않아야 탭바 placeholder("세션 없음 · …")가 보인다.
  const rects = await win.webContents.executeJavaScript(`(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } }
    return { tabbar: r('.term-tabbar'), statusbar: r('.statusbar'), placeholder: !!document.querySelector('.tt-placeholder') }
  })()`)
  if (!rects.placeholder) console.log('WARN placeholder 없음 — 세션이 열려 있는 상태')

  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await new Promise((r) => setTimeout(r, 250))
  win.setSize(w, h); await new Promise((r) => setTimeout(r, 400))
  const shot = await win.webContents.capturePage()

  // 탭바 + 상태바를 위아래로 이어 붙인다(둘 다 한글 마이크로 텍스트 구간).
  const tab = shot.crop(rects.tabbar)
  const st = shot.crop(rects.statusbar)
  writeFileSync(DEST.replace('.png', '-tabbar.png'), tab.toPNG())
  writeFileSync(DEST.replace('.png', '-statusbar.png'), st.toPNG())
  console.log('CROP ' + DEST + ' tabbar=' + rects.tabbar.width + 'x' + rects.tabbar.height + ' statusbar=' + rects.statusbar.width + 'x' + rects.statusbar.height)
  app.exit(0)
})
setTimeout(() => { console.log('FAIL timeout'); app.exit(1) }, 40000)
