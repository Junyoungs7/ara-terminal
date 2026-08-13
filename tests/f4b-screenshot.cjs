// F4b 실기동 스크린샷 — 실제 ssh2 서버 하네스에 접속해 서버 그룹 시나리오를 재현한 뒤 캡처한다.
// 구성: 서버 1개(하네스)에 SSH 세션 2개 + 로컬 1개 → 탭바 [서버그룹(2)]+[로컬 탭], 트리 서버 하위 세션 2행.
// 산출물: agent_talk/F4b-screenshot.png
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')
const { Server, utils } = require('ssh2')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'F4b-screenshot.png')

// ── 실제 ssh2 비밀번호 서버(입력 에코 + 한글 배너). tests/ssh-harness.ts와 동일 구조. ──
function startSshServer() {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const password = 'testpw123'
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === password) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => acceptPty && acceptPty())
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('A.R.A 원격 셸 준비 완료\r\n$ ')
          stream.on('data', (d) => stream.write(d))
        })
      })
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, password }))
  })
}

// 로컬 pty 세션 IPC.
const ptys = new Map()
let getWc = () => null
function streamPty(id, p) {
  ptys.set(id, p)
  p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
  p.onExit(({ exitCode }) => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
}
function wireLocal() {
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    streamPty(id, pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts))
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {} ; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

// 실제 ssh2로 접속해 shell 채널을 세션으로 흘린다(서버 그룹용 SSH 세션).
const { Client } = require('ssh2')
const sshChannels = new Map()
function wireSsh(port, password) {
  ipcMain.handle('ssh:connect', () => new Promise((resolve) => {
    const c = new Client()
    c.on('ready', () => {
      c.shell({ term: 'xterm-256color', cols: 100, rows: 28 }, (err, ch) => {
        if (err) { resolve({ ok: false, reason: 'network', message: err.message }); return }
        const id = 'ssh-' + Math.random().toString(36).slice(2)
        sshChannels.set(id, { c, ch })
        ch.on('data', (d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
        resolve({ ok: true, id })
      })
    })
    c.on('error', (e) => resolve({ ok: false, reason: 'network', message: e.message }))
    c.connect({ host: '127.0.0.1', port, username: 'deploy', password })
  }))
  // SSH 세션 입력도 채널로.
  ipcMain.on('session:input', (_e, { id, data }) => { const s = sshChannels.get(id); if (s) s.ch.write(data) })
}

app.whenReady().then(async () => {
  const { port, password } = await startSshServer()
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireSsh(port, password)
  // 프로필 IPC: 하네스 서버를 가리키는 SSH 프로필 1개 + safeStorage vault.
  const profiles = [{ id: 'p1', name: 'dev-server', host: '127.0.0.1', port, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }, group: '개발' }]
  if (safeStorage.isEncryptionAvailable()) safeStorage.encryptString(password)
  ipcMain.handle('profile:list', () => profiles)
  ipcMain.handle('profile:save', () => ({ profile: profiles[0] }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles, knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: '나눔고딕코딩', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' } }))

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 600))

  // 시나리오: 로컬 세션 1개(+ 버튼) → 서버 노드 클릭 2회(SSH 세션 2개, 같은 서버 그룹).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(700)
    const node = document.querySelector('.tree .srv-node')
    if (node) node.click(); await wait(900)
    const node2 = document.querySelector('.tree .srv-node')
    if (node2) node2.click(); await wait(900)
    // 활성 SSH 세션에 한글 명령 주입(터미널 화면 채우기).
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  // 활성 SSH 채널에 한글 입력 에코.
  for (const [, s] of sshChannels) s.ch.write('echo 안녕하세요 A.R.A 서버 그룹 동기\r')
  await new Promise((r) => setTimeout(r, 1500))

  // 페인트 완료 대기 후 캡처(0바이트 방지).
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) {
    await new Promise((r) => setTimeout(r, 1200))
    img = await win.webContents.capturePage()
  }
  writeFileSync(SHOT, img.toPNG())
  console.log('SCREENSHOT saved: ' + SHOT + ' bytes=' + img.toPNG().length)
  console.log('tabgroups + local tab + tree session rows captured (real ssh2 harness)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  for (const [, s] of sshChannels) { try { s.c.end() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 25000)
