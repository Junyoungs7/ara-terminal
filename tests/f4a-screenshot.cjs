// F4a 실기동 스크린샷 — 실제 out/preload + renderer 로 창을 띄우고 Ctrl+- 로 4분할한 뒤
// 각 패널 세션에 서로 다른 한글 명령을 흘려보내고 포커스 링이 보이는 상태를 캡처한다.
// 산출물: agent_talk/F4a-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'F4a-screenshot.png')
const ptys = new Map()
const isWin = process.platform === 'win32'

// 실제 계약과 동일한 최소 세션 IPC(배칭 포함). 세션마다 고유 id.
function wire(getWc) {
  ipcMain.handle('session:create', () => {
    const id = 'ss-' + Math.random().toString(36).slice(2, 8)
    const file = isWin ? 'powershell.exe' : '/bin/sh'
    const p = pty.spawn(file, isWin ? ['-NoLogo'] : [], {
      name: 'xterm-256color', cols: 80, rows: 20, cwd: process.cwd(), env: process.env, useConpty: isWin, useConptyDll: isWin
    })
    let buf = [], bytes = 0, timer = null
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (!buf.length) return
      const m = buf.length === 1 ? buf[0] : Buffer.concat(buf, bytes)
      buf = []; bytes = 0
      const u = new Uint8Array(m.length); u.set(m)
      const wc = getWc(); if (wc && !wc.isDestroyed()) wc.postMessage('session:data:' + id, u)
    }
    p.onData((d) => { const b = Buffer.from(d, 'utf8'); buf.push(b); bytes += b.length; if (bytes >= 65536) flush(); else if (!timer) timer = setTimeout(flush, 16) })
    p.onExit(() => { flush(); ptys.delete(id) })
    ptys.set(id, p)
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {} ; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', (_e, { id }) => { try { ptys.get(id)?.pause() } catch {} })
  ipcMain.on('session:resume', (_e, { id }) => { try { ptys.get(id)?.resume() } catch {} })
  // Shell/useProfiles 마운트 시 호출 — 핸들러 부재로 인한 콘솔 에러 방지.
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({}))
}

// 순서대로 스폰된 pty 에 명령 주입(패널 배치 순서와 동일).
function feed(cmds) {
  const ids = [...ptys.keys()]
  ids.forEach((id, i) => {
    const c = cmds[i]
    if (c) ptys.get(id)?.write((isWin ? c + '\r\n' : c + '\n'))
  })
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

  // 첫 세션 + Ctrl+- 3회로 4분할.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(500)
    const split = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, shiftKey: true, bubbles: true }))
    split(); await wait(400); split(); await wait(400); split(); await wait(400)
    return document.querySelectorAll('.pane-grid .pane').length
  })()`)
  await new Promise((r) => setTimeout(r, 800))

  // 각 패널에 서로 다른 한글 출력.
  feed([
    isWin ? 'echo [패널1] 로컬 PowerShell; echo 한글 정렬 테스트 가나다라' : 'echo 패널1 로컬셸; echo 한글정렬',
    isWin ? 'echo [패널2] 빌드 로그; echo 배포 스크립트 실행중' : 'echo 패널2 빌드로그',
    isWin ? 'echo [패널3] tail -f 로그; echo 503 결제승인 오류' : 'echo 패널3 로그',
    isWin ? 'echo [패널4] htop; echo CPU 34% 메모리 12.4G' : 'echo 패널4 시스템'
  ])
  await new Promise((r) => setTimeout(r, 2000))

  // 좌상 패널에 포커스(시안 링) — 이미 마지막 분할 패널이 포커스이므로 명시적으로 첫 패널 클릭.
  await win.webContents.executeJavaScript(`(() => {
    const p = document.querySelectorAll('.pane-grid .pane')[0]
    if (p) p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return document.querySelectorAll('.pane-grid .pane.focused').length
  })()`)
  await new Promise((r) => setTimeout(r, 700))

  win.focus()
  // 컴포지터 페인트가 끝날 때까지 비어있지 않은 캡처를 재시도.
  let png = Buffer.alloc(0)
  for (let i = 0; i < 10 && png.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const img = await win.webContents.capturePage()
    png = img.toPNG()
  }
  writeFileSync(SHOT, png)
  console.log('SCREENSHOT saved: ' + SHOT + ' bytes=' + png.length)
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(png.length > 0 ? 0 : 1)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 35000)
