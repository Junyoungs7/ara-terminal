// F3 실기동 스크린샷 — 실제 out/preload + out/renderer로 창을 띄우고:
//  ① 연결 관리자 모달 열린 화면 → agent_talk/F3-modal-screenshot.png
//  ② node ssh2 테스트 서버에 실제 SSH 접속한 터미널 화면 → agent_talk/F3-ssh-screenshot.png
// ssh:connect는 여기서 실제 ssh2 Client로 접속→shell 채널을 session:data 파이프라인에 흘린다(앱 계약 동일).
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const { Server, Client, utils } = require('ssh2')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT_MODAL = join(__dirname, '..', 'agent_talk', 'F3-modal-screenshot.png')
const SHOT_SSH = join(__dirname, '..', 'agent_talk', 'F3-ssh-screenshot.png')

// ── 테스트용 ssh2 서버(비밀번호 인증, shell 에코 + 한글 배너) ──
function startSshServer() {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'testpw123') ctx.accept()
      else if (ctx.method === 'none') ctx.reject(['password'])
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept()
        s.on('pty', (a) => { if (a) a() })
        s.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('\x1b[36mA.R.A 원격 셸에 접속되었습니다\x1b[0m\r\n')
          stream.write('deploy@dev-server:~$ \r\n')
          stream.on('data', (d) => stream.write(d)) // 에코
        })
      })
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ── 앱 계약과 동일한 최소 IPC 배선 ──
const profiles = []
const vault = {}
function wireIpc(getWc, sshPort) {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' } }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => profiles)
  ipcMain.handle('profile:save', (_e, input) => {
    const id = input.id || 'p-dev'
    if (input.secret && safeStorage.isEncryptionAvailable()) vault[id] = safeStorage.encryptString(input.secret).toString('base64')
    const profile = { id, name: input.name, host: input.host, port: input.port, username: input.username, auth: { type: 'password', secretRef: { store: 'vault', key: id } }, group: input.group }
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx >= 0) profiles[idx] = profile
    else profiles.push(profile)
    return { profile }
  })
  ipcMain.handle('profile:delete', () => ({ ok: true }))

  const channels = new Map()
  wireIpc.lastChannel = null
  ipcMain.handle('ssh:connect', async (_e, { profileId }) => {
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) return { ok: false, reason: 'network', message: 'no profile' }
    const secret = vault[profileId] ? safeStorage.decryptString(Buffer.from(vault[profileId], 'base64')) : ''
    return await new Promise((resolve) => {
      const c = new Client()
      c.on('ready', () => {
        c.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, ch) => {
          if (err) { resolve({ ok: false, reason: 'network', message: err.message }); return }
          const id = 'ssh-' + Math.random().toString(36).slice(2)
          channels.set(id, { c, ch })
          wireIpc.lastChannel = ch
          ch.on('data', (d) => { const wc = getWc(); if (wc && !wc.isDestroyed()) { const b = Buffer.from(d); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) } })
          ch.stderr.on('data', (d) => { const wc = getWc(); if (wc && !wc.isDestroyed()) { const b = Buffer.from(d); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) } })
          ch.on('close', () => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode: 0 }) })
          resolve({ ok: true, id })
        })
      })
      c.on('error', (e) => resolve({ ok: false, reason: 'network', message: e.message }))
      c.connect({ host: '127.0.0.1', port: sshPort, username: profile.username, password: secret, hostVerifier: () => true })
    })
  })

  ipcMain.on('session:input', (_e, { id, data }) => channels.get(id)?.ch.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
  ipcMain.handle('session:create', () => ({ id: 'noop' }))
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { channels.get(id)?.ch.setWindow(rows, cols, 0, 0) } catch {} return { ok: true } })
  ipcMain.handle('session:destroy', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])
}

app.whenReady().then(async () => {
  const { port } = await startSshServer()
  let win
  wireIpc(safeWc(() => win), port)

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 500))

  // 프로필 저장(모달에 리스트 행이 보이도록) 후 렌더러 재로드로 목록 반영.
  await win.webContents.executeJavaScript(`window.ev.profile.save({ name: 'dev-server', host: '127.0.0.1', port: ${port}, username: 'deploy', authType: 'password', secret: 'testpw123', group: '개발' })`)
  await win.webContents.reload()
  await new Promise((r) => setTimeout(r, 700))

  // ① 연결 관리자 모달 열기 → 스크린샷.
  // R4.1: Session 은 드롭다운 — 첫 항목(연결 관리자)까지 골라야 모달이 열린다.
  await win.webContents.executeJavaScript(`(async () => {
    const m = [...document.querySelectorAll('.tb-menu span')].find(s => s.textContent === 'Session')
    if (m) m.click()
    await new Promise(r => setTimeout(r, 200))
    document.querySelector('.ctx-menu .ctx-item[data-action="connection.manager"]')?.click()
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  writeFileSync(SHOT_MODAL, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT modal: ' + SHOT_MODAL)

  // 모달 닫고 → 트리 서버 노드 클릭(원클릭 SSH 접속).
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await new Promise((r) => setTimeout(r, 300))
  await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.tree .srv-node'); if (n) n.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`)
  await new Promise((r) => setTimeout(r, 1500))

  // 원격 셸에 한글 입력을 서버로 보내 에코가 터미널에 표시되게 한다(사용자 타이핑 시뮬레이션).
  if (wireIpc.lastChannel) {
    wireIpc.lastChannel.write('echo 안녕하세요 A.R.A 터미널 — 원격 접속 성공\r\n')
  }
  await new Promise((r) => setTimeout(r, 1000))
  writeFileSync(SHOT_SSH, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT ssh: ' + SHOT_SSH)

  app.exit(0)
})

setTimeout(() => { console.log('f3 screenshot timeout'); app.exit(1) }, 25000)
