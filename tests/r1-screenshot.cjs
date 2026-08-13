// R1 실기동 스크린샷 — 세션 전환 후 스크롤백 보존을 눈으로 확인한다.
// 시나리오: 세션 A 출력 → 같은 패널에서 B 로 전환 → A 로 복귀(버퍼 남아 있어야 함) → 분할로 A·B 동시 표시.
// 산출물: agent_talk/R1-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PROFILES = [
  { id: 'p-kvt', name: 'KVT', host: '192.168.100.56', port: 22, username: 'jun', auth: { type: 'password', secretRef: { store: 'vault', key: 'p-kvt' } }, group: '개발' }
]

const ptys = new Map()
const SESSIONS = [] // session:list 응답(렌더러가 id 로 입력을 보낼 수 있게 실제 목록을 준다)
let getWc = () => null

// 실 main 과 같은 attach 계약: attach 전 출력은 백로그에 쌓아 두었다가 attach 시 한 번에 넘긴다.
const BACKLOG = new Map()
const backlogOf = (id) => {
  let st = BACKLOG.get(id)
  if (!st) BACKLOG.set(id, (st = { chunks: [], attached: false }))
  return st
}
function pushData(id, d) {
  const b = Buffer.from(d, 'utf8')
  const u = new Uint8Array(b.length)
  u.set(b)
  const st = backlogOf(id)
  st.chunks.push(u)
  if (!st.attached) return
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.postMessage('session:data:' + id, u)
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...PROFILES[0], ...input, id: input.id || 'p-new' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'r1 스크린샷: 실접속 미수행' }))
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    SESSIONS.push({ id, type: 'local', profileId: null, title: spec.title, serverKey: spec.serverKey })
    p.onData((d) => pushData(id, d))
    p.onExit(({ exitCode }) => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
    return { id }
  })
  ipcMain.handle('session:attach', (_e, { id }) => {
    const st = backlogOf(id)
    st.attached = true
    const total = st.chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of st.chunks) { out.set(c, off); off += c.length }
    return { backlog: out }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(250)
  win.setSize(w, h)
  await wait(400)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(800); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(1200)

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const nl = navigator.userAgent.includes('Windows') ? '\\r\\n' : '\\n'
    const newLocal = async () => {
      document.querySelector('.tterm-add')?.click(); await wait(250)
      document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1400)
      const list = await window.ev.session.list()
      return list[list.length - 1].id
    }
    const clickTab = async (n) => {
      const tab = [...document.querySelectorAll('.term-tabbar .ttab')].find(t => t.textContent.includes(n))
      if (tab) tab.click()
      await wait(700)
    }
    const shown = () => [...document.querySelectorAll('.pane-grid .pane')]
      .filter(p => getComputedStyle(p).display !== 'none')
      .map(p => p.textContent || '').join('\\n')

    // 세션 A(셸 1): 배포 로그 흉내 출력.
    const a = await newLocal()
    window.ev.session.input(a, 'echo "[A] 배포 스크립트 시작 — 세션 A 스크롤백"' + nl)
    await wait(900)
    window.ev.session.input(a, 'echo "[A] 한글 출력 무결성 확인: 결제·승인·정산"' + nl)
    await wait(1200)

    // 같은 패널에서 세션 B 로 전환(＋ → 로컬 셸): 예전엔 이 시점에 A 의 xterm 이 dispose 되어 버퍼가 사라졌다.
    const b = await newLocal()
    window.ev.session.input(b, 'echo "[B] 다른 세션 — 여기 출력은 A 와 섞이지 않는다"' + nl)
    await wait(1200)

    // A 로 복귀 → A 버퍼가 그대로 남아 있어야 한다.
    await clickTab('셸 1')
    const aKept = /\\[A\\] 배포 스크립트 시작/.test(shown())

    // 분할로 A·B 를 나란히(교차 전환 후에도 양쪽 버퍼 유지).
    // 세로 분할(Ctrl+\\ = 좌·우)을 쓴다: R2 부터 Ctrl+- 는 상·하 배치라 패널 높이가 절반이 되고,
    // PowerShell 배너까지 얹히면 먼저 찍힌 줄이 뷰포트 밖으로 밀려 "보이는 텍스트" 판정이 흔들린다.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(1500)
    await clickTab('셸 2')
    await wait(600)
    const bothKept = /\\[A\\] 배포 스크립트 시작/.test(shown()) && /\\[B\\] 다른 세션/.test(shown())
    return { aKept, bothKept, panes: document.querySelectorAll('.pane-grid .pane').length }
  })()`)

  console.log('R1 화면 검증:', JSON.stringify(result))
  await capture(win, 'R1-screenshot.png')

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  const ok = result.aKept === true && result.bothKept === true && result.panes === 2
  console.log(ok ? 'R1 SCREENSHOT OK (버퍼 보존 확인)' : 'R1 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R1 screenshot timeout'); app.exit(1) }, 60000)
