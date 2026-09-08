// W1 트랙 C 실기동 검증 + 스크린샷.
//   `electron tests/w1c-screenshot.cjs`
//     → agent_talk/W1C-history-screenshot.png  (F11 인라인 고스트 자동완성)
//     → agent_talk/W1C-preview-screenshot.png  (F15 미니 프리뷰 레일 + 호버 확대)
//
// 키 입력은 webContents.sendInputEvent 로 넣는다 — xterm 의 printable 입력은 helper textarea 의
// input 이벤트로 들어와서 합성 KeyboardEvent 로는 재현되지 않는다(Chromium 입력 파이프라인 경유 필요).
// 로컬 셸은 cmd.exe 를 쓴다: PSReadLine 이 줄을 다시 그리지 않아 에코 타이밍이 결정적이다.
//
// DLP: 클립보드·업로드는 전부 임시 디렉토리와 스텁 핸들러 안에서만 돈다(실서버·실 OS 클립보드 접근 없음).
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join, resolve, dirname } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const IS_WIN = process.platform === 'win32'

// ── 임시 자원: "원격" 디렉토리(SFTP 스텁이 읽는다) + 클립보드에 담겼다고 가정할 로컬 파일 ──
const REMOTE = mkdtempSync(join(tmpdir(), 'ara-w1c-remote-'))
const LOCAL = mkdtempSync(join(tmpdir(), 'ara-w1c-local-'))
const SHELL_CWD = mkdtempSync(join(tmpdir(), 'ara-w1c-shell-'))
mkdirSync(join(REMOTE, '배포스크립트'))
writeFileSync(join(REMOTE, 'README_한글.md'), '# 한글 문서\n')
const CLIP_FILE = join(LOCAL, '배포_설정.yaml')
writeFileSync(CLIP_FILE, 'env: prod\n')

// F11 히스토리 시드 — 고스트가 물어 올 후보. 'npm r' → 최신 접두 일치인 'npm run build'.
const HISTORY = {
  local: ['git status', 'docker compose ps', 'npm run build'],
  결제서버: ['systemctl status pay', 'tail -f /var/log/pay/access.log']
}
const appended = [] // history:append 로 실제 올라온 것(비밀번호가 여기 없어야 한다)
const uploads = [] // sftp:upload 호출 기록(F14)
const ptyInput = [] // 셸로 실제 전달된 입력(Tab·ESC 통과 확인용)
let clipboardFiles = [] // clipboard:readFiles 스텁이 돌려줄 경로

const PROFILES = [
  { id: 'p1', name: '결제서버', host: '10.20.30.40', port: 22, username: 'deploy', group: '운영', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } }
]
const UI = {
  sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
  ctxMenuStyle: 'list',
  font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
  locale: 'ko',
  scrollback: 10000,
  copyOnSelect: true,
  cursorStyle: 'block',
  cursorBlink: true,
  bell: 'off'
}

const ptys = new Map()
const SESSIONS = []
let getWc = () => null
// 비밀번호 프롬프트 재현용: 켜면 입력을 셸로 넘기지 않는다(= 에코 없음). 실제 password 프롬프트가
// 정확히 이 모양이다 — 쳐도 화면에 아무것도 안 찍히고 커서는 프롬프트 끝에 머문다.
let noEcho = false

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

function spawnPty() {
  // cwd 는 리포가 아니라 임시 디렉토리다: 이 하네스는 진짜 셸에 키를 넣으므로, 지우다 만 입력이
  // 실행되면 작업 트리에 파일이 생긴다(실제로 빈 파일 하나가 만들어진 적이 있다).
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: SHELL_CWD, env: process.env }
  if (IS_WIN) {
    opts.useConpty = true
    opts.useConptyDll = true
  }
  return pty.spawn(IS_WIN ? 'cmd.exe' : '/bin/sh', [], opts)
}

function makeSession(type, title, serverKey, profileId) {
  const id = type + '-' + Math.random().toString(36).slice(2)
  const p = spawnPty()
  ptys.set(id, p)
  SESSIONS.push({ id, type, profileId: profileId ?? null, cwd: undefined, title, serverKey })
  p.onData((d) => pushData(id, d))
  p.onExit(() => ptys.delete(id))
  return id
}

const okList = (p) => {
  const abs = resolve(p === '.' || !p ? REMOTE : p)
  const entries = readdirSync(abs).map((name) => {
    const s = statSync(join(abs, name))
    return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs }
  })
  entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ko')))
  return { ok: true, path: abs, parent: dirname(abs) === abs ? abs : dirname(abs), entries }
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, i) => ({ profile: { ...i, id: 'p9', auth: { type: 'password', secretRef: { store: 'vault', key: 'p9' } } } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { ...UI, groups: [] }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', (_e, s) => { UI.sidebar = s; return { ok: true } })
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', (_e, { profileId }) => {
    const p = PROFILES.find((x) => x.id === profileId)
    return { ok: true, id: makeSession('ssh', p.name, p.name, p.id), title: p.name }
  })
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))
  ipcMain.handle('session:create', (_e, spec) => ({ id: makeSession('local', spec.title, spec.serverKey, null) }))
  ipcMain.handle('session:attach', (_e, { id }) => {
    const st = backlogOf(id)
    st.attached = true
    const total = st.chunks.reduce((a, c) => a + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of st.chunks) { out.set(c, off); off += c.length }
    return { backlog: out }
  })
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => {
    ptyInput.push({ id, data })
    if (!noEcho) ptys.get(id)?.write(data)
  })
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})

  // ── 트랙 C 신규 채널(실제 앱과 같은 계약) ──
  ipcMain.handle('history:load', (_e, { scope }) => ({ entries: HISTORY[scope] ?? [] }))
  ipcMain.handle('history:append', (_e, { scope, command }) => {
    appended.push({ scope, command })
    ;(HISTORY[scope] ?? (HISTORY[scope] = [])).push(command)
    return { ok: true }
  })
  // 실 OS 클립보드는 이 환경에서 막혀 있을 수 있어 스텁으로 주입한다(T1 CLIP-* 와 같은 제약).
  ipcMain.handle('clipboard:readFiles', () => ({ paths: clipboardFiles }))

  ipcMain.handle('sftp:list', (_e, { path }) => okList(path))
  ipcMain.handle('sftp:upload', (_e, req) => { uploads.push(req); return { ok: true } })
  ipcMain.handle('sftp:download', () => ({ ok: true }))
  ipcMain.handle('sftp:cancel', () => ({ ok: true }))
  ipcMain.handle('sftp:rename', () => ({ ok: true }))
  ipcMain.handle('sftp:mkdir', () => ({ ok: true }))
  ipcMain.handle('sftp:remove', () => ({ ok: true }))
  ipcMain.handle('sftp:pickSavePath', () => ({ path: null }))
  ipcMain.handle('sftp:pickSaveDir', () => ({ path: null }))
  ipcMain.handle('sftp:pickUploadPaths', () => ({ paths: [] }))
  ipcMain.handle('fs:list', (_e, { path }) => okList(path))
  ipcMain.handle('fs:rename', () => ({ ok: true }))
  ipcMain.handle('fs:mkdir', () => ({ ok: true }))
  // #89·#92: 사용자 휴지통·다운로드 폴더를 건드리지 않는다.
  ipcMain.handle('fs:trash', () => ({ ok: true }))
  // #88 R2: 새 쓰기 채널 둘도 막는다 — fs:move 는 **실제로 파일을 옮긴다**(휴지통도 안 거친다).
  // 하네스가 사용자 PC 를 건드리지 않는다는 규칙은 채널이 늘 때마다 다시 지켜야 한다.
  ipcMain.handle('fs:move', () => ({ ok: true }))
  ipcMain.handle('fs:newFile', () => ({ ok: true }))
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
}

// ── 키 입력 (Chromium 입력 파이프라인 — xterm 이 진짜 타이핑으로 받는다) ──
async function typeText(win, text) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await wait(28)
  }
  await wait(160)
}
async function pressKey(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await wait(260)
}
// 줄 지우기는 Backspace 로 한다 — Ctrl+C 는 conpty 에서 cmd.exe 를 통째로 끝내 버려서
// 이후 에코가 사라지고(= 고스트도 안 뜨고) 뒤 검증이 전부 무너진다.
async function clearLine(win, n = 32) {
  for (let i = 0; i < n; i++) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await wait(12)
  }
  await wait(400)
}

const js = (win, code) => win.webContents.executeJavaScript(code)
const ghostText = (win) => js(win, `document.querySelector('.term-ghost')?.textContent ?? null`)

// 실제 포인터 이동 — React 의 onMouseEnter 는 합성 mouseenter 로는 안 열린다(루트에서 잡는 것은
// mouseover/mouseout 이다). Chromium 입력으로 넣어야 진짜 호버가 된다.
async function hover(win, selector) {
  const at = await js(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!at) return null
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  await wait(120)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
  await wait(400)
  return at
}

async function capture(win, name, before) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(200)
  win.setSize(w, h)
  await wait(450)
  if (before) await before()
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) {
    await wait(800)
    img = await win.webContents.capturePage()
  }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

const results = {}
const cleanup = () => {
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  // Windows 는 방금 죽인 셸이 아직 디렉토리를 잡고 있어 EBUSY 가 난다. 임시 디렉토리가 남는 것은
  // 무해하지만, 여기서 던지면 결과 출력과 app.exit 를 통째로 건너뛰어 하네스가 타임아웃으로 끝난다.
  for (const d of [REMOTE, LOCAL, SHELL_CWD]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
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
  win.focus()
  await wait(1500)

  // ── 로컬 셸 하나 열고 프롬프트가 자리 잡을 때까지 대기 ──
  const localId = await js(win, `(async () => {
    const { id } = await window.ev.session.create({ type: 'local', title: '로컬 셸', serverKey: 'localhost', profileId: null })
    window.__evAdopt(id, '로컬 셸', 'localhost', 'local')
    return id
  })()`)
  await wait(2500)
  // 프롬프트만 남기고 화면 정리(cmd 배너가 스크린샷을 어지럽힌다).
  await js(win, `window.__evTerm(${JSON.stringify(localId)}) && 1`)
  await typeText(win, 'cls')
  await pressKey(win, 'Return')
  await wait(900)

  // ── ① F11: 인라인 고스트 자동완성 ──
  // #194 ② 로 고스트는 **손을 멈추고 250ms 뒤**에 뜬다(에코가 늦으면 +45ms 씩 재시도). 700ms 는
  // 그 위에 얹은 여유다 — 이 값을 250 아래로 줄이면 고스트를 읽기 전에 찍는다.
  await typeText(win, 'npm r')
  await wait(700)
  results.ghost = await ghostText(win)
  await capture(win, 'W1C-history-screenshot.png')

  // → 채택 → 고스트가 실제 입력으로 바뀐다(#194 ⑤ 전에는 Tab 이었다 — 그 키는 셸에 돌려줬다.
  // 커서가 줄 끝이라 → 가 받는다. 결과 키 이름은 그대로 둔다 — 이 하네스의 결과를 읽는 눈이 있다).
  await pressKey(win, 'Right')
  await wait(500)
  results.afterTabGhost = await ghostText(win)
  results.lineAfterTab = await js(win, `(() => {
    const t = window.__evTerm(${JSON.stringify(localId)})
    return t ? t.text().split('\\n').filter(l => l.trim()).pop() : ''
  })()`)

  // 줄을 비우고 ESC 해제를 확인한다.
  await clearLine(win)
  await typeText(win, 'npm r')
  await wait(700)
  results.lineBeforeEsc = await js(win, `(() => {
    const t = window.__evTerm(${JSON.stringify(localId)})
    return t ? t.text().split('\\n').filter(l => l.trim()).pop() : ''
  })()`)
  results.ghostBeforeEsc = await ghostText(win)
  await pressKey(win, 'Escape')
  await wait(300)
  results.ghostAfterEsc = await ghostText(win)

  // 고스트가 없을 때 Tab·ESC 는 셸로 그대로 간다(앱이 셸 기능을 뺏지 않는다 — R3.8).
  await clearLine(win)
  await typeText(win, 'zzqq')
  await wait(400)
  results.ghostNoMatch = await ghostText(win)
  const before = ptyInput.length
  await pressKey(win, 'Tab')
  await pressKey(win, 'Escape')
  results.passThrough = ptyInput.slice(before).map((x) => x.data)
  await clearLine(win, 40)

  // ── ② F11: 비밀번호는 수집하지 않는다 ──
  // 에코를 끊어 실제 비밀번호 프롬프트를 재현한다(쳐도 화면에 안 찍히고 커서는 프롬프트 끝).
  const appendedBefore = appended.length
  pushData(localId, '\r\nPassword: ')
  await wait(500)
  noEcho = true
  await typeText(win, 'hunter2-secret')
  results.pwCursorLine = await js(win, `(() => {
    const t = window.__evTerm(${JSON.stringify(localId)})
    return t ? t.text().split('\\n').filter(l => l.trim()).pop() : ''
  })()`)
  await pressKey(win, 'Return')
  await wait(700)
  noEcho = false
  results.pwAppended = appended.slice(appendedBefore).map((a) => a.command)

  // 평범한 명령은 기록된다(수집 자체가 죽은 게 아니다).
  pushData(localId, '\r\n')
  await wait(400)
  await typeText(win, 'echo 수집확인')
  await pressKey(win, 'Return')
  await wait(1000)
  results.normalAppended = appended.map((a) => a.command).includes('echo 수집확인')

  // 공백으로 시작하는 입력은 제외(셸 관례).
  await typeText(win, ' echo 비밀유지')
  await pressKey(win, 'Return')
  await wait(1000)
  results.spacePrefixSkipped = !appended.some((a) => a.command.includes('비밀유지'))

  // ── ③ F14: 클립보드 파일 → SFTP 업로드 / 로컬은 경로 붙여넣기 ──
  clipboardFiles = [CLIP_FILE]
  // 로컬 세션에서 Ctrl+V → 경로 문자열이 셸로 들어간다.
  const inputBefore = ptyInput.length
  await pressKey(win, 'v', ['control'])
  await wait(700)
  results.localPaste = ptyInput.slice(inputBefore).map((x) => x.data)
  await clearLine(win, 80)

  // SSH 세션으로 전환 → [파일] 탭에서 하위 폴더로 들어가 "현재 원격 디렉토리"를 만든다.
  const sshId = await js(win, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await window.__evConnect('p1')
    await wait(900)
    document.querySelectorAll('.sb-tab')[1].click()
    await wait(900)
    const dir = [...document.querySelectorAll('.ftree .frow.dir')][0]
    dir?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(900)
    const list = await window.ev.session.list()
    return [...list].reverse().find(s => s.type === 'ssh')?.id || ''
  })()`)
  // 사이드바를 [연결] 탭으로 돌려 둔다 — Ctrl+V 업로드가 [파일] 탭을 스스로 펼치는지 본다.
  await js(win, `document.querySelectorAll('.sb-tab')[0].click()`)
  await wait(500)
  await js(win, `document.querySelector('.term-pane .xterm-helper-textarea')?.focus()`)
  await wait(300)
  const uploadsBefore = uploads.length
  await pressKey(win, 'v', ['control'])
  await wait(1200)
  results.uploads = uploads.slice(uploadsBefore).map((u) => ({ sessionId: u.sessionId, localPath: u.localPath, remoteDir: u.remoteDir }))
  results.uploadSessionMatches = results.uploads.every((u) => u.sessionId === sshId)
  results.fileTabRevealed = await js(win, `document.querySelectorAll('.sb-tab')[1].classList.contains('active')`)
  clipboardFiles = []

  // ── ④ F15: 미니 프리뷰 레일 ──
  // 세션마다 다른 내용을 찍어 카드가 서로 다른 화면을 보여 주는지 확인한다.
  const E = '\x1b['
  pushData(sshId, `\r\n${E}1;36mdeploy@결제서버:/srv/서비스$${E}0m tail -f /var/log/pay/access.log\r\n${E}32m✔${E}0m 결제 승인 1,204건 · 평균 82ms\r\n${E}33m⚠${E}0m 재시도 큐 3건\r\n${E}90m2026-08-04 12:31:07 POST /api/pay 200${E}0m\r\n`)
  await wait(700)
  await pressKey(win, 'p', ['control', 'shift'])
  await wait(900)
  results.railOpen = await js(win, `!!document.querySelector('.mini-rail')`)
  results.cardCount = await js(win, `document.querySelectorAll('.mini-card').length`)
  results.cardsHaveText = await js(win, `[...document.querySelectorAll('.mini-body')].filter(b => b.textContent.trim()).length`)
  // 호버 확대(실제 포인터 이동). 캡처 직전 리사이즈로 포인터가 떨어질 수 있어 다시 올린 뒤 찍는다.
  await hover(win, '.mini-card')
  results.zoomOpen = await js(win, `!!document.querySelector('.mini-zoom')`)
  results.zoomHasText = await js(win, `(document.querySelector('.mini-zoom-body')?.textContent ?? '').trim().length > 0`)
  await capture(win, 'W1C-preview-screenshot.png', () => hover(win, '.mini-card'))

  // 포인터를 치워 확대 프리뷰를 닫는다(클릭 전환 확인에 방해되지 않게).
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 })
  await wait(300)

  // 카드 클릭 → 그 세션으로 전환.
  results.switched = await js(win, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const cards = [...document.querySelectorAll('.mini-card')]
    const target = cards.find(c => !c.classList.contains('active'))
    if (!target) return 'no-inactive-card'
    const id = target.dataset.session
    target.click()
    await wait(700)
    return document.querySelector('.mini-card.active')?.dataset.session === id ? 'ok' : 'not-switched'
  })()`)

  // 토글로 닫힌다.
  await pressKey(win, 'p', ['control', 'shift'])
  await wait(500)
  results.railClosed = await js(win, `!document.querySelector('.mini-rail')`)

  console.log('W1C 결과:', JSON.stringify(results, null, 1))

  const ok =
    // F11 고스트: 'npm r' → 'npm run build' 의 나머지가 흐린 글자로 뜨고, → 가 그것을 실입력으로 만든다.
    results.ghost === 'un build' &&
    results.afterTabGhost === null &&
    (results.lineAfterTab || '').includes('npm run build') &&
    results.ghostBeforeEsc === 'un build' &&
    results.ghostAfterEsc === null &&
    // 고스트가 없으면 Tab(\t)·ESC(\x1b) 는 셸로 그대로 간다.
    results.ghostNoMatch === null &&
    results.passThrough.includes('\t') &&
    results.passThrough.some((d) => d.startsWith('\x1b')) &&
    // 비밀번호는 어디에도 남지 않는다 / 평범한 명령은 남는다 / 공백 시작은 제외.
    results.pwAppended.length === 0 &&
    results.normalAppended === true &&
    results.spacePrefixSkipped === true &&
    !appended.some((a) => a.command.includes('hunter2')) &&
    // F14: 로컬은 경로 붙여넣기, SSH 는 현재 원격 디렉토리로 업로드 + [파일] 탭 자동 노출.
    results.localPaste.some((d) => d.includes('배포_설정.yaml')) &&
    results.uploads.length === 1 &&
    results.uploads[0].localPath === CLIP_FILE &&
    results.uploads[0].remoteDir.replace(/\\/g, '/').endsWith('/배포스크립트') &&
    results.uploadSessionMatches === true &&
    results.fileTabRevealed === true &&
    // F15: 레일 토글 · 세션 수만큼 카드 · 호버 확대 · 클릭 전환.
    results.railOpen === true &&
    results.cardCount >= 2 &&
    results.cardsHaveText >= 2 &&
    results.zoomOpen === true &&
    results.zoomHasText === true &&
    results.switched === 'ok' &&
    results.railClosed === true

  cleanup()
  console.log(ok ? 'W1C SCREENSHOT OK (F11 고스트·비밀번호 제외 / F14 파일 붙여넣기 / F15 미니 프리뷰)' : 'W1C SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => {
  console.log('W1C screenshot timeout')
  cleanup()
  app.exit(1)
}, 180000)
