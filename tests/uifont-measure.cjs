// UI-font 진단 하네스 — 한글 상단 잘림 원인을 실측으로 확정한다(추정 금지).
// f5-screenshot.cjs 의 부팅 패턴(로컬 세션 + 워크스페이스 목 IPC) 재사용.
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

const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 } }
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('button')].find(b => /로컬 셸/.test(b.textContent))
    btn?.click(); await wait(900)
    return true
  })()`)

  const result = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready
    const glyphMetrics = (fontFamily, sizePx, char) => {
      const c = document.createElement('canvas')
      const ctx = c.getContext('2d')
      ctx.font = sizePx + 'px ' + fontFamily
      const m = ctx.measureText(char)
      return {
        actualAscent: m.actualBoundingBoxAscent,
        actualDescent: m.actualBoundingBoxDescent,
        fontAscent: m.fontBoundingBoxAscent,
        fontDescent: m.fontBoundingBoxDescent
      }
    }
    const describe = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return { sel, found: false }
      const cs = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return {
        sel, found: true,
        text: el.textContent,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        overflow: cs.overflowY,
        elHeight: rect.height,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        clipped: el.scrollHeight > el.clientHeight + 0.5
      }
    }
    const monoStack = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
    const termStack = getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
    return {
      cssVars: { mono: monoStack, term: termStack },
      fontsLoaded: {
        jetbrainsHasHangul: document.fonts.check("11.5px 'JetBrains Mono'", '셀'),
        nanumHasHangul: document.fonts.check("11.5px 'Nanum Gothic Coding'", '셀')
      },
      glyph_mono_11_5: glyphMetrics(monoStack, 11.5, '셀'),
      glyph_nanum_alone_11_5: glyphMetrics("'Nanum Gothic Coding'", 11.5, '셀'),
      glyph_jetbrains_alone_11_5: glyphMetrics("'JetBrains Mono'", 11.5, '셀'),
      glyph_term_14: glyphMetrics(termStack, 14, '셀'),
      elements: [
        describe('.sess-node .sess-name'),
        describe('.sb-seg.host .lbl'),
        describe('.sb-seg.host .val'),
        describe('.sb-right .sb-seg .lbl')
      ]
    }
  })()`)

  writeFileSync(outPath('UI-font-measure.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('measure timeout'); app.exit(1) }, 30000)
