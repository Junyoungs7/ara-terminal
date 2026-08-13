// MVP 폴리시 2건 수용 검사 + 스크린샷 1장.
//  (1) 4분할 상태에서 라디얼 아이콘이 뒤 배경(divider·패널 헤더·터미널 글자)에 비치거나 가리지 않는다.
//  (2) 로컬 PowerShell 첫 프롬프트에 OSC7 주입 명령이 노출되지 않는다.
// 산출물: agent_talk/FIX-polish-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

// src/main/sessions/osc7.ts SHELL_INTEGRATION.powershell 와 동일 — 하네스는 main 번들을 못 불러오므로 복제.
const PS_INTEGRATION = [
  '$global:__ARA_PROMPT = $function:prompt',
  'function global:prompt {',
  '  $p = (Get-Location).Path',
  "  Write-Host -NoNewline ([char]27 + ']7;file://' + $env:COMPUTERNAME + '/' + ($p -replace '\\\\', '/') + [char]7)",
  '  if ($global:__ARA_PROMPT) { & $global:__ARA_PROMPT } else { "PS $p> " }',
  '}'
].join('\n')

const ptys = new Map()
let getWc = () => null
function wireLocal() {
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    // PtyBackend 와 동일하게 셸 시작 인자로 주입 — stdin 주입이 아니므로 에코가 없다.
    const encoded = Buffer.from(PS_INTEGRATION, 'utf16le').toString('base64')
    const args = win ? ['-NoLogo', '-NoExit', '-EncodedCommand', encoded] : []
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', args, opts)
    ptys.set(id, p)
    p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
    p.onExit(({ exitCode }) => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' } }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
}

// 소프트웨어 컴포지터에서 첫 프레임에 고정되는 것을 피해 캡처 직전 1px 리사이즈로 새 프레임을 강제한다.
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

const checks = []

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
  await new Promise((r) => setTimeout(r, 800))

  // 세션 1 + 분할 3회 = 4분할(2x2).
  const panes = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(900)
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true }))
      await wait(800)
    }
    return document.querySelectorAll('.pane').length
  })()`)
  checks.push(['4분할 패널 생성', panes === 4])

  for (const [, p] of ptys) { try { p.write('echo 안녕하세요 A.R.A 라디얼 4분할 점검\r') } catch {} }
  await new Promise((r) => setTimeout(r, 1400))

  // (2) 터미널 버퍼에 OSC7 주입 명령이 남지 않았는지.
  const term = await win.webContents.executeJavaScript(`(() => {
    const els = [...document.querySelectorAll('.pane-body .xterm-rows')]
    return els.map((e) => e.innerText).join('\\n')
  })()`)
  checks.push(['첫 프롬프트에 OSC7 주입 명령 미노출', !/__ARA_PROMPT|global:prompt|EncodedCommand/.test(term)])
  checks.push(['한글 출력 정상', term.includes('안녕하세요')])

  // (1) 4패널 교차점에서 라디얼 전개.
  const shown = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const grid = document.querySelector('.pane-grid')
    const gr = grid.getBoundingClientRect()
    grid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(gr.left + gr.width/2), clientY: Math.round(gr.top + gr.height/2) }))
    await wait(700)
    return document.querySelectorAll('.radial-menu.open .ri.shown').length
  })()`)
  checks.push(['라디얼 8항목 전개', shown === 8])

  // 아이콘 디스크가 (a) 불투명하고 (b) 히트테스트 최상단인지 — 둘 중 하나라도 깨지면 배경이 비쳐 "가림"이 된다.
  const occl = await win.webContents.executeJavaScript(`(() => {
    const alphaOf = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return 1; const p = m[1].split(','); return p.length > 3 ? parseFloat(p[3]) : 1 }
    const bad = []
    const nodes = [...document.querySelectorAll('.radial-menu.open .ri-icon'), document.querySelector('.radial-menu.open .radial-center')]
    for (const el of nodes) {
      if (!el) continue
      const id = el.closest('.ri')?.dataset.action || 'center'
      const cs = getComputedStyle(el)
      if (alphaOf(cs.backgroundColor) < 1) bad.push(id + ':bg-alpha=' + cs.backgroundColor)
      if (parseFloat(cs.opacity) < 1) bad.push(id + ':opacity=' + cs.opacity)
      const r = el.getBoundingClientRect()
      for (const [tag, x, y] of [['c', r.left+r.width/2, r.top+r.height/2], ['n', r.left+r.width/2, r.top+3], ['s', r.left+r.width/2, r.bottom-3], ['w', r.left+3, r.top+r.height/2], ['e', r.right-3, r.top+r.height/2]]) {
        const top = document.elementFromPoint(x, y)
        if (!top || !el.contains(top)) bad.push(id + ':' + tag + '-occluded-by-' + (top ? top.className : 'null'))
      }
    }
    return bad
  })()`)
  checks.push(['라디얼 아이콘 불투명 + 가림 없음' + (occl.length ? ' → ' + occl.join(', ') : ''), occl.length === 0])

  await new Promise((r) => setTimeout(r, 200))
  await capture(win, 'FIX-polish-screenshot.png')

  let ok = true
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name)
    if (!pass) ok = false
  }
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('FAIL timeout (45s)'); app.exit(1) }, 45000)
