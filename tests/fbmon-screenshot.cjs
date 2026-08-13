// FB-monitor 실기동 스크린샷 3종 — 배선 패턴은 tests/w3sat-screenshot.cjs 를 그대로 따른다
// (session/workspace 는 다른 하네스와 같은 최소 배선). __evAdopt 로 로컬 pty 를 "SSH 로 편입"하고,
// 트리에 서버 노드가 뜨도록 그 serverKey 와 이름이 같은 가짜 프로필 하나를 profile:list 로 얹는다.
//
// 산출물: ① agent_talk/FB-mon-tree.png   (사이드바 트리 계층 가독성 — 서버 밑 세션 2개, 캐럿·가이드선·개수 pill)
//         ② agent_talk/FB-mon-ports.png  ([모니터] 탭 검색·범위 필터·감춘 개수)
//         ③ agent_talk/FB-mon-tmux.png   (트리 우클릭 → tmux 서브메뉴 호버)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

let getWc = () => null

// ── 세션 IPC (smoke-boot.cjs/w3sat-screenshot.cjs 와 같은 attach/backlog 패턴) ──
const ptys = new Map()
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
function attachBacklog(id) {
  const st = backlogOf(id)
  st.attached = true
  const total = st.chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of st.chunks) { out.set(c, off); off += c.length }
  return out
}
function wireLocal() {
  ipcMain.handle('session:attach', (_e, { id }) => ({ backlog: attachBacklog(id) }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, aiModel: 'claude-sonnet-5' }
// FB-monitor: 트리 서버 노드는 profiles 에서 파생된다 — __evAdopt 로 만드는 세션의 serverKey('dev-server')와
// 이름이 같은 가짜 SSH 프로필을 하나 얹어야 그 밑에 세션 행이 그려진다.
const FAKE_PROFILE = {
  id: 'p1',
  name: 'dev-server',
  host: '10.0.4.21',
  port: 22,
  username: 'dev',
  type: 'ssh',
  auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
}
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [FAKE_PROFILE])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [FAKE_PROFILE], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko', aiModel: UI.aiModel }
  }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
}

// [모니터] 탭 검색·필터 스크린샷용 — telemetry 는 폴링을 시작하지 않고(no-op) 필요한 순간에
// 이 파일이 직접 telemetry:data 를 한 번 밀어 넣는다(실 ssh2 없이 실사용 데이터 모양만 재현 — DLP).
function wireTelemetryAndForward() {
  ipcMain.handle('telemetry:start', () => ({ ok: true }))
  ipcMain.handle('telemetry:stop', () => ({ ok: true }))
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('forward:create', () => ({ ok: false, reason: 'network' }))
  ipcMain.handle('forward:stop', () => ({ ok: true }))
  // FB-0004: 우클릭 tmux 서브메뉴 조회 — "실행 중인 세션 없음"으로 고정(설치·있음 상태는 tmuxList.test.ts 가 본다).
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))
}

function pushPorts(sessionId) {
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.send('telemetry:data:' + sessionId, {
    sessionId,
    ports: [
      { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
      { proto: 'tcp', port: 443, pid: 1180, process: 'nginx' },
      { proto: 'tcp', port: 3000, pid: 2451, process: 'node' },
      { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' },
      { proto: 'tcp', port: 6379, pid: 77, process: 'redis-server' },
      { proto: 'tcp', port: 33060 } // 권한 없음(다른 사용자 소유) — pid/process 없음
    ],
    stats: null
  })
}

let lastBytes = -1
async function capture(win, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [w, h] = win.getSize()
    win.setSize(w - 1, h)
    await new Promise((r) => setTimeout(r, 300))
    win.setSize(w, h)
    await new Promise((r) => setTimeout(r, 500))
    let img = await win.webContents.capturePage()
    let png = img.toPNG()
    if (png.length === 0) { await new Promise((r) => setTimeout(r, 800)); img = await win.webContents.capturePage(); png = img.toPNG() }
    if (png.length !== lastBytes || attempt === 2) {
      lastBytes = png.length
      writeFileSync(shotPath(name), png)
      console.log('SCREENSHOT ' + name + ' bytes=' + png.length + (attempt > 0 ? ' (attempt ' + (attempt + 1) + ')' : ''))
      return
    }
  }
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()
  wireTelemetryAndForward()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  // dev-server 밑에 세션 2개(bash·htop) — FB-0001 트리 계층 가독성 데모.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const mkSsh = async (title) => {
    const id = await win.webContents.executeJavaScript(`(async () => {
      const { id } = await window.ev.session.create({ type: 'local', title: ${JSON.stringify(title)}, serverKey: 'dev-server', cwd: undefined, profileId: 'p1', shell: undefined })
      window.__evAdopt?.(id, ${JSON.stringify(title)}, 'dev-server', 'ssh')
      return id
    })()`)
    return id
  }
  const bashId = await mkSsh('bash')
  await mkSsh('htop')
  await wait(500)

  // ── 1) 트리 계층 스크린샷: [연결] 탭 기본 화면(서버 노드 + 세션 2개 펼침) ──
  await capture(win, 'FB-mon-tree.png')

  // ── 2) 포트 모니터: bash 세션을 활성화 → [모니터] 탭 → 포트 데이터 주입 → 검색어 입력 ──
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.tree .sess-node')[0]?.click()
    return true
  })()`)
  await wait(300)
  pushPorts(bashId)
  await wait(300)
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.sb-tab[role="tab"]:nth-of-type(3)')?.click()
    await wait(300)
    const input = document.querySelector('.pmon .sb-search input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'node')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  })()`)
  await wait(400)
  await capture(win, 'FB-mon-ports.png')

  // 검색어를 지워 범위 필터(감춘 개수)만 남은 상태로 돌린 뒤 [연결] 탭으로 복귀.
  await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('.pmon .sb-search input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.querySelector('.sb-tab[role="tab"]:nth-of-type(1)')?.click()
    return true
  })()`)
  await wait(300)

  // ── 3) tmux 서브메뉴: 세션 행 우클릭 → tmux 항목 호버 ──
  // React 는 mouseenter 직전에 mouseover 전이가 있어야 감지한다(합성 이벤트 트래킹) — 둘 다 보낸다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const row = document.querySelector('.tree .sess-node')
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 220 }))
    await wait(250)
    const tmuxItem = document.querySelector('.ctx-menu .ctx-item[data-action="session.tmux"]')
    tmuxItem?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    tmuxItem?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await wait(250)
    return !!document.querySelector('.ctx-submenu')
  })()`)
  await wait(400)
  await capture(win, 'FB-mon-tmux.png')

  console.log('FB-monitor screenshots done (tree / ports / tmux)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 40000)
