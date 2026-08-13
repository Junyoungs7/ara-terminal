// F5 실기동 스크린샷 — 로컬 세션 + 설정 드로어 + 폰트 전환 후 한글 터미널 출력을 실제 캡처.
// 산출물: ① agent_talk/F5-drawer-screenshot.png (드로어: 비교스트립+폰트리스트+미리보기)
//         ② agent_talk/F5-terminal-screenshot.png (폰트 변경 후 터미널 한글 출력)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

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

const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 } }
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
}

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

  // 로컬 세션 1개 + 한글 출력으로 터미널을 채운다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(800)
    return true
  })()`)
  const koLines = [
    'echo "$ ./배포스크립트/backup.sh --db main"',
    'echo "✔ 데이터베이스 백업이 완료되었습니다. 파일: 백업_20260731.sql (성공)"',
    'echo "⚠ 로그 디렉터리 용량 78% — 오래된 로그를 정리하세요."',
    'echo "ℹ 다음 정기 백업: 2026-08-01 03:00 KST · 예상 소요 4분"',
    'echo "✗ 커넥션 풀 고갈: POST /api/결제/승인 재시도 3/3 실패"'
  ]
  for (const [, p] of ptys) { try { for (const l of koLines) p.write(l + '\r') } catch {} }
  await new Promise((r) => setTimeout(r, 1200))

  // 1) 설정 드로어 열기 → 비교 스트립+폰트 리스트+미리보기 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await document.fonts.ready
    // R5: 탭바 도구 버튼 제거 — 타이틀바 기어가 설정 진입점이고, 폰트 UI 는 [폰트] 섹션에 있다.
    document.querySelector('.titlebar .tb-gear')?.click(); await wait(500)
    document.querySelector('.drawer.open .set-nav span[data-section="font"]')?.click(); await wait(300)
    return !!document.querySelector('.drawer.open')
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  await capture(win, 'F5-drawer-screenshot.png')

  // 2) 폰트를 D2Coding 으로 전환 + 크기 16px → 드로어 닫고 터미널 한글 출력 캡처(실시간 반영).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const d2 = [...document.querySelectorAll('.drawer.open .font-list .font-item')].find(f => /D2Coding/.test(f.textContent))
    d2?.click(); await wait(300)
    const sizeSlider = document.querySelector('.drawer.open .fp-controls input[type=range]')
    if (sizeSlider) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(sizeSlider, '16'); sizeSlider.dispatchEvent(new Event('change', { bubbles: true })); sizeSlider.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(400)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500)
    return getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await capture(win, 'F5-terminal-screenshot.png')

  console.log('F5 screenshots done (drawer / terminal)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 30000)
