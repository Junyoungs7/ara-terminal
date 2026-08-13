// UI-font4 before/after — 사이드바 세션명·상태바·탭 라벨을 krSystemFallback off(before)/on(after)
// 두 상태로 같은 구도(6배 확대)로 캡처. 구조는 uifont2-measure-gpu.cjs 재사용.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

const OUT = join(__dirname, '..', 'out')
const outPath = (name) => join(__dirname, '..', 'agent_talk', name)

function nearestZoomPng(img, zoomX) {
  const { width: w, height: h } = img.getSize()
  const src = img.toBitmap()
  const dst = Buffer.alloc(w * zoomX * h * zoomX * 4)
  const dw = w * zoomX
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      for (let dy = 0; dy < zoomX; dy++) {
        const rowBase = ((y * zoomX + dy) * dw + x * zoomX) * 4
        for (let dx = 0; dx < zoomX; dx++) {
          const di = rowBase + dx * 4
          dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3]
        }
      }
    }
  }
  return nativeImage.createFromBitmap(dst, { width: dw, height: h * zoomX }).toPNG()
}

let getWc = () => null
const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58, krSystemFallback: false } }
ipcMain.handle('session:create', () => ({ id: 'loc-0' }))
ipcMain.handle('session:resize', () => ({ ok: true }))
ipcMain.handle('session:destroy', () => ({ ok: true }))
ipcMain.handle('session:list', () => [])
ipcMain.on('session:input', () => {})
ipcMain.on('session:pause', () => {})
ipcMain.on('session:resume', () => {})
ipcMain.handle('app:getVersion', () => '0.1.0')
ipcMain.handle('profile:list', () => [])
ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
ipcMain.handle('ui:setGroups', () => ({ ok: true }))
ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
ipcMain.handle('mcp:getState', () => ({ enabled: false, listening: false, port: null, token: null, clientConnected: false, sessions: [] }))

async function captureCropStable(win, region) {
  let prevBitmap = null
  let best = null
  for (let i = 0; i < 20; i++) {
    const full = await win.webContents.capturePage()
    const s = full.getSize()
    if (s.width > 0 && s.height > 0 && region.x + region.width <= s.width && region.y + region.height <= s.height) {
      const cropped = full.crop(region)
      const bitmap = cropped.toBitmap()
      best = cropped
      if (prevBitmap) {
        let diffSum = 0
        for (let k = 0; k < bitmap.length; k++) diffSum += Math.abs(bitmap[k] - prevBitmap[k])
        if (diffSum / bitmap.length < 1) return cropped
      }
      prevBitmap = bitmap
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (best) return best
  throw new Error('crop region never produced a valid frame after 20 retries')
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119', webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
    getWc = safeWc(() => win)

    for (const phase of ['before', 'after']) {
      UI.font = { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58, krSystemFallback: phase === 'after' }
      await win.loadFile(join(OUT, 'renderer', 'index.html'))
      await new Promise((r) => setTimeout(r, 700))
      await win.webContents.executeJavaScript(`(async () => { await document.fonts.ready })()`)
      await win.webContents.executeJavaScript(`(() => { document.querySelector('.tterm-add')?.click() })()`)
      await new Promise((r) => setTimeout(r, 900))

      const info = await win.webContents.executeJavaScript(`(() => {
        const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } }
        return { sessName: r('.sess-node .sess-name'), sbLbl: r('.sb-seg.host .lbl'), tlabel: r('.ttab .tlabel') }
      })()`)

      const [cssW] = win.getContentSize()
      let full0Size = { width: 0, height: 0 }
      for (let i = 0; i < 10 && full0Size.width === 0; i++) {
        full0Size = (await win.webContents.capturePage()).getSize()
        if (full0Size.width === 0) await new Promise((r) => setTimeout(r, 120))
      }
      const scale = full0Size.width / cssW || 1
      const PAD = 6
      const ZOOM = 6
      const targets = [
        { sel: '.sess-node .sess-name', key: 'sessName', tag: 'sidebar' },
        { sel: '.sb-seg.host .lbl', key: 'sbLbl', tag: 'statusbar' },
        { sel: '.ttab .tlabel', key: 'tlabel', tag: 'tab' }
      ]
      for (const t of targets) {
        const rect = info[t.key]
        if (!rect) { console.log(`[${phase}] ${t.tag} NOT FOUND`); continue }
        const rawX = Math.round((rect.x - PAD) * scale)
        const rawY = Math.round((rect.y - PAD) * scale)
        const x = Math.max(0, rawX)
        const y = Math.max(0, rawY)
        const region = {
          x, y,
          width: Math.min(Math.round((rect.width + PAD * 2) * scale) - (x - rawX), full0Size.width - x),
          height: Math.min(Math.round((rect.height + PAD * 2) * scale) - (y - rawY), full0Size.height - y)
        }
        const cropped = await captureCropStable(win, region)
        writeFileSync(outPath(`UI-font4-${phase}-${t.tag}.png`), nearestZoomPng(cropped, ZOOM))
      }
      console.log(`[${phase}] done`)
    }
    console.log('BEFORE_AFTER_OK')
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 40000)
