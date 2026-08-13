// W3sat 위성 기능 3종 스크린샷 — F18 명령어 북 / F19 tmux 헬퍼 / F17 AI 부트스트랩(ARA_AI_FAKE 배선).
// 배선 패턴은 tests/w3-screenshot.cjs 를 그대로 따른다: session/workspace 는 다른 하네스와 같은
// 최소 배선, ai:* 는 이 파일이 직접 흉내낸다(실 AraSession 은 vault 배선이 무거워 재사용하지 않음).
//
// 산출물: ① agent_talk/W3sat-book-screenshot.png      (명령어 북 검색 + 펼친 예시)
//         ② agent_talk/W3sat-tmux-screenshot.png      ([모니터] 탭 tmux 헬퍼, SSH 세션 활성)
//         ③ agent_talk/W3sat-bootstrap-screenshot.png (부트스트랩 폼 제출 → 아라 답변, 코드블록 포함)
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

// ── 세션 IPC (smoke-boot.cjs/w3-screenshot.cjs 와 같은 attach/backlog 패턴) ──
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
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko', aiModel: UI.aiModel }
  }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
}

// ── ai:* IPC 캔드 배선(F17 부트스트랩 데모용) — W3-done.md 와 같은 계약, 다른 답변 내용. ──
const ANSWER_CHUNKS = [
  '요청하신 조건으로 새 프로젝트를 시작하는 순서입니다.\n\n',
  '```bash\n',
  'mkdir -p my-app && cd my-app\n',
  'npm init -y\n',
  '```\n\n',
  '위 명령까지 실행하시면 기본 골격이 준비됩니다.'
]
let usage = { input: 0, output: 0 }
function wireAi() {
  ipcMain.handle('ai:getState', () => ({ hasKey: true, model: UI.aiModel, turns: [], streaming: false, usage }))
  ipcMain.handle('ai:setKey', () => ({ ok: true }))
  ipcMain.handle('ai:cancel', () => ({ ok: true }))
  ipcMain.handle('ai:clear', () => ({ ok: true }))
  ipcMain.handle('ai:send', () => {
    const turnId = 'w3sat-' + Math.random().toString(36).slice(2)
    ;(async () => {
      for (const chunk of ANSWER_CHUNKS) {
        await new Promise((r) => setTimeout(r, 100))
        const wc = getWc()
        if (wc && !wc.isDestroyed()) wc.send('ai:delta', { turnId, text: chunk })
      }
      usage = { input: usage.input + 58, output: usage.output + 40 }
      const wc = getWc()
      if (wc && !wc.isDestroyed()) wc.send('ai:end', { turnId, ok: true })
    })()
    return { turnId }
  })
}

// capturePage() 는 가끔 직전 프레임을 돌려준다(w3-screenshot.cjs 에서 관찰) — 바이트 동일하면 재시도.
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
  wireAi()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  // 로컬 세션 하나(＋ → 로컬 셸) — 명령어 북/부트스트랩의 "로컬" 대상, [터미널로 보내기] 목적지.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(700)
    return true
  })()`)

  // ── 1) F18 명령어 북: Ctrl+Shift+K → 검색 → 항목 펼침 → 캡처 ──
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(300)
    const input = document.querySelector('.cheatsheet.open .sp-search input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '로그')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(300)
    document.querySelector('.cheatsheet.open .cb-row')?.click()
    await wait(300)
    return document.querySelectorAll('.cheatsheet.open .cb-item').length
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await capture(win, 'W3sat-book-screenshot.png')

  await win.webContents.executeJavaScript(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
  await new Promise((r) => setTimeout(r, 300))

  // ── 2) F19 tmux 헬퍼: fake SSH 세션 편입(__evAdopt) → [모니터] 탭 → 캡처 ──
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.__evAdopt?.('fake-ssh-1', 'demo-server', 'demo-server', 'ssh')
    await wait(300)
    document.querySelector('.sb-tab[role="tab"]:nth-of-type(3)')?.click()
    await wait(400)
    return !!document.querySelector('.tmuxbar')
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await capture(win, 'W3sat-tmux-screenshot.png')

  // 로컬 세션으로 되돌린다(부트스트랩 데모의 "로컬" 대상이 활성이도록).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelectorAll('.ttab')[0]?.click()
    await wait(300)
    return true
  })()`)

  // ── 3) F17 AI 부트스트랩: 패널 열기 → 부트스트랩 버튼 → 폼 채움 → 제출 → 스트리밍 완료 → 캡처 ──
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.titlebar .tb-ai')?.click(); await wait(400)
    document.querySelector('.ai-panel [data-action="ai.bootstrap.open"]')?.click(); await wait(400)
    // 종류는 기본값(웹)을 그대로 둔다 — 폼을 열면 이미 선택돼 있다.
    const setVal = (el, v) => {
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const inputs = document.querySelectorAll('.ai-bootstrap .dlg-input')
    setVal(inputs[0], 'Node.js')
    setVal(inputs[1], 'demo-app')
    setVal(inputs[2], '/srv/demo-app')
    await wait(200)
    document.querySelector('.ai-bootstrap [data-action="ai.bootstrap.submit"]')?.click()
    await wait(1500)
    return document.querySelectorAll('.ai-panel .ai-code').length
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await capture(win, 'W3sat-bootstrap-screenshot.png')

  console.log('W3sat screenshots done (book / tmux / bootstrap)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 40000)
