// F2 실기동 스크린샷 — 실제 out/preload + out/renderer(xterm)로 창을 띄우고 세션을 열어
// 한글 명령을 실행한 뒤 터미널 탭 화면을 캡처한다. 산출물: agent_talk/F2-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'F2-screenshot.png')
const ptys = new Map()

// 실제 계약과 동일한 최소 세션 IPC(smoke와 동일 배칭).
function wire(getWc) {
  ipcMain.handle('session:create', () => {
    const id = 'ss'
    const file = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const p = pty.spawn(file, process.platform === 'win32' ? ['-NoLogo'] : [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: process.env, useConpty: process.platform === 'win32', useConptyDll: process.platform === 'win32' })
    let buf = [], bytes = 0, timer = null
    const flush = () => { if (timer) { clearTimeout(timer); timer = null } if (!buf.length) return; const m = buf.length === 1 ? buf[0] : Buffer.concat(buf, bytes); buf = []; bytes = 0; const u = new Uint8Array(m.length); u.set(m); const wc = getWc(); if (wc && !wc.isDestroyed()) wc.postMessage('session:data:' + id, u) }
    p.onData((d) => { const b = Buffer.from(d, 'utf8'); buf.push(b); bytes += b.length; if (bytes >= 65536) flush(); else if (!timer) timer = setTimeout(flush, 16) })
    p.onExit(() => { flush(); ptys.delete(id) })
    ptys.set(id, p); return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', (_e, { id }) => { try { ptys.get(id)?.pause() } catch {} })
  ipcMain.on('session:resume', (_e, { id }) => { try { ptys.get(id)?.resume() } catch {} })
}

app.whenReady().then(async () => {
  let win
  wire(safeWc(() => win))
  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 500))

  // 실제 UI 경로로 새 세션: + 버튼 클릭(탭바 렌더 유발) 후 한글 명령 주입.
  await win.webContents.executeJavaScript(`(() => {
    const add = document.querySelector('.tterm-add')
    if (add) add.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 1200))

  // 활성 세션에 한글 명령 주입(탭 클릭으로 열린 세션 id를 xterm가 잡음).
  const isWin = process.platform === 'win32'
  const cmd = isWin
    ? 'echo 한글출력테스트; echo 안녕하세요 A.R.A 터미널; dir | Select-Object -First 3\r\n'
    : 'echo 한글출력테스트; echo 안녕하세요 A.R.A 터미널; ls\n'
  // 렌더러의 activeId 세션에 input. 세션 id는 tterm-add로 생성된 것.
  await win.webContents.executeJavaScript(`window.ev.session.input('ss', ${JSON.stringify(cmd)})`)
  await new Promise((r) => setTimeout(r, 2500))

  const img = await win.webContents.capturePage()
  writeFileSync(SHOT, img.toPNG())
  console.log('SCREENSHOT saved: ' + SHOT + ' bytes=' + img.toPNG().length)
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 20000)
