// UI-font before/after 증거 캡처 — 사이드바 세션명 + 상태바 라벨을 같은 구도로 캡처 후
// 해당 영역만 잘라 4배 확대(nativeImage, 외부 의존성 없음)해 잘림 해소를 눈으로 비교한다.
// 사용: electron tests/uifont-screenshot.cjs <before|after>
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

const TAG = process.argv[2] === 'after' ? 'after' : 'before'
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
      return !!btn
    })()`)
    await new Promise((r) => setTimeout(r, 1000))

    const rects = await win.webContents.executeJavaScript(`(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }
      return { sessName: r('.sess-node .sess-name'), sbLbl: r('.sb-seg.host .lbl'), sbVal: r('.sb-seg.host .val'), dpr: window.devicePixelRatio }
    })()`)

    const full = await win.webContents.capturePage()
    const fullSize = full.getSize()
    const [cssW] = win.getContentSize()
    console.log('fullSize=' + JSON.stringify(fullSize) + ' cssW=' + cssW)
    const scale = fullSize.width / cssW // 실제 캡처 배율(HiDPI 보정) — 가정하지 않고 실측.

    writeFileSync(outPath(`UI-font-${TAG}-full.png`), full.toPNG())

    // 사이드바 세션명 + 상태바 호스트 세그먼트를 한 프레임에 담는 영역을 잘라 4배 확대.
    const sN = rects.sessName
    const pad = 6
    const region = {
      x: Math.max(0, Math.round((sN.x - pad) * scale)),
      y: Math.max(0, Math.round((sN.y - pad) * scale)),
      width: Math.round((sN.width + pad * 2) * scale),
      height: Math.round((sN.height + pad * 2) * scale)
    }
    const cropped = full.crop(region)
    const zoom = cropped.resize({ width: region.width * 6, height: region.height * 6, quality: 'good' })
    writeFileSync(outPath(`UI-font-${TAG}-sessname-6x.png`), zoom.toPNG())

    const sL = rects.sbLbl
    const region2 = {
      x: Math.max(0, Math.round((sL.x - pad) * scale)),
      y: Math.max(0, Math.round((sL.y - pad) * scale)),
      width: Math.round((sL.width + pad * 2) * scale),
      height: Math.round((sL.height + pad * 2) * scale)
    }
    const cropped2 = full.crop(region2)
    const zoom2 = cropped2.resize({ width: region2.width * 6, height: region2.height * 6, quality: 'good' })
    writeFileSync(outPath(`UI-font-${TAG}-statusbar-6x.png`), zoom2.toPNG())

    console.log('rects=' + JSON.stringify(rects) + ' scale=' + scale)
    console.log('SCREENSHOTS_OK ' + TAG)
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 25000)
