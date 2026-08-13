// R3 실기동 스크린샷 — 터미널 표준 기능을 눈으로 확인한다.
//   ① ANSI 16색 테마: `ls --color` 류 컬러 출력 + normal/bright 스와치 → agent_talk/R3-ansi-screenshot.png
//   ② 인라인 검색 바: 한글 검색어 매치 상태                      → agent_talk/R3-search-screenshot.png
// GPU 를 끄지 않는다(다른 하네스와 다른 점) — WebGL 렌더러가 실제로 붙는지 함께 확인하기 위해서다.
// ANSI 출력은 pushData 로 넣는다: 셸 종류별 이스케이프 따옴표 지옥을 피하면서도 실제 경로
// (main → session:data → xterm.write) 를 그대로 탄다.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ptys = new Map()
const SESSIONS = []
let getWc = () => null
const OPENED = []

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
  const win = process.platform === 'win32'
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: process.cwd(), env: process.env }
  if (win) { opts.useConpty = true; opts.useConptyDll = true }
  return pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('app:openExternal', (_e, { url }) => {
    const ok = /^https?:\/\//.test(url)
    if (ok) OPENED.push(url)
    return { ok }
  })
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: input }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: {
      sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
      ctxMenuStyle: 'list',
      font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
      locale: 'ko', scrollback: 10000, copyOnSelect: true
    }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'R3 하네스는 로컬만' }))
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const p = spawnPty()
    ptys.set(id, p)
    SESSIONS.push({ id, type: 'local', profileId: null, cwd: spec.cwd, title: spec.title, serverKey: spec.serverKey })
    p.onData((d) => pushData(id, d))
    p.onExit(() => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode: 0 }); ptys.delete(id) })
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
  ipcMain.handle('session:rename', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    if (s && title) { s.title = title; s.manualTitle = true }
    return { ok: true }
  })
  ipcMain.handle('session:autoTitle', (_e, { id, title }) => {
    const s = SESSIONS.find((x) => x.id === id)
    // 실 main(MainSessionManager.isShellPathTitle)과 같은 규칙 — conpty 가 보내는 셸 경로 제목은 무시.
    if (!s || !title || s.manualTitle || /(?:^|[\\/])[^\\/\s]+\.exe$/i.test(title.trim())) return { applied: false }
    s.title = title
    return { applied: true }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

// ── 화면에 찍을 ANSI 데모 ──
const E = '\x1b['
const R = E + '0m'
// `ls --color=auto` 가 실제로 내는 색: 디렉터리 34, 실행파일 32, 아카이브 31, 심볼릭 36.
const LS = [
  `${E}1;36m$ ls --color=auto /srv/서비스${R}`,
  `${E}34m배포스크립트/${R}  ${E}34m로그/${R}  ${E}34m설정/${R}  ${E}32mdeploy.sh${R}  ${E}32m헬스체크.sh${R}  ${E}31m백업_20260731.tar.gz${R}  ${E}36m현재 -> /srv/서비스/v42${R}`,
  '',
  `${E}1;36m$ git log --oneline -3${R}`,
  `${E}33m8f21ac4${R} ${E}1;32m(HEAD -> ${E}1;35mmain${E}1;32m)${R} 결제 승인 재시도 로직 보강`,
  `${E}33m19cd330${R} 세션 복원 안정화 — 부분 복원 카드 추가`,
  `${E}33mc014eea${R} ${E}31m창 파괴 레이스 해소${R} — isDestroyed 가드`,
  '',
  `${E}1;36m$ ./헬스체크.sh${R}`,
  `${E}32m✔${R} 데이터베이스 연결 정상 · 응답 12ms`,
  `${E}33m⚠${R} 디스크 사용률 81% — 로그 회전 필요`,
  `${E}31m✗${R} 결제 게이트웨이 타임아웃 (3/3 재시도 실패)`,
  `${E}90m# 다음 정기 백업: 2026-08-04 03:00 KST${R}`,
  `${E}35mhttps://verygoodtour.com/runbook/결제장애${R}  ${E}90m(Ctrl+클릭으로 열기)${R}`,
  ''
].join('\r\n')

// normal 8 + bright 8 스와치 — 테마 16색이 전부 살아 있는지 한눈에 보이게.
const SWATCH = [
  `${E}1mANSI 16색 팔레트 (design-system §1.6)${R}`,
  '  normal  ' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${E}4${i}m${E}30m ${i} ${R}`).join(''),
  '  bright  ' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${E}10${i}m${E}30m ${i + 8} ${R}`).join(''),
  '  전경색  ' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${E}3${i}m 가나다 ${R}`).join(''),
  '  bright  ' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${E}9${i}m 가나다 ${R}`).join(''),
  ''
].join('\r\n')

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(250)
  win.setSize(w, h)
  await wait(500)
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
  win.focus()
  await wait(1500)

  const sid = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(1600)
    const list = await window.ev.session.list()
    return list[list.length - 1].id
  })()`)

  // 셸 프롬프트가 자리를 잡은 뒤 ANSI 데모를 흘려 넣는다(실제 출력 경로 그대로).
  pushData(sid, '\r\n' + LS + '\r\n' + SWATCH)
  // OSC 0/2 제목 — 탭 이름이 셸 제목을 따라가는지도 같은 화면에서 보인다(R3.6).
  pushData(sid, '\x1b]0;deploy@web-01: /srv/서비스\x07')
  await wait(1500)

  const ansi = await win.webContents.executeJavaScript(`(async () => {
    const info = window.__evTerm('${sid}')
    const theme = info?.theme || {}
    const text = info?.text() || ''
    const tab = document.querySelector('.term-tabbar .ttab[data-session-id="${sid}"] .tlabel')?.textContent || ''
    return {
      scrollback: info?.scrollback,
      unicode: info?.unicode,
      webgl: !!document.querySelector('.pane .term-pane canvas'),
      ansi16: ['black','red','green','yellow','blue','magenta','cyan','white',
        'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite']
        .every(k => typeof theme[k] === 'string' && theme[k].length > 0),
      selection: theme.selectionBackground, cursorAccent: theme.cursorAccent,
      colored: text.includes('배포스크립트') && text.includes('ANSI 16색'),
      tab
    }
  })()`)
  console.log('R3 ANSI 검증:', JSON.stringify(ansi))
  await capture(win, 'R3-ansi-screenshot.png')

  const search = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(500)
    const input = document.querySelector('.term-search .ts-input')
    if (input) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '결제')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(700)
    return {
      open: !!document.querySelector('.term-search'),
      value: input?.value || '',
      hit: !document.querySelector('.term-search .ts-miss')
    }
  })()`)
  console.log('R3 검색 검증:', JSON.stringify(search))
  await capture(win, 'R3-search-screenshot.png')

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  const ok =
    ansi.scrollback === 10000 &&
    ansi.unicode === '11' &&
    ansi.ansi16 === true &&
    !!ansi.selection && !!ansi.cursorAccent &&
    ansi.colored === true &&
    ansi.tab.includes('deploy@web-01') &&
    search.open === true && search.value === '결제' && search.hit === true
  console.log('WebGL 렌더러: ' + (ansi.webgl ? '활성(canvas)' : 'DOM 폴백'))
  console.log(ok ? 'R3 SCREENSHOT OK (ANSI 16색 · 검색 · 스크롤백 10000 · OSC 제목)' : 'R3 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R3 screenshot timeout'); app.exit(1) }, 90000)
