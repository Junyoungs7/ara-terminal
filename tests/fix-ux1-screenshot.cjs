// 실사용 UX 라운드1 스크린샷 — 트리 우클릭 메뉴 / 커스텀 호스트키 모달 / ＋메뉴·커스텀 드롭다운.
// 산출물: agent_talk/FIX-ux1-treemenu.png, FIX-ux1-hostkey.png, FIX-ux1-dropdown.png, FIX-ux1-addmenu.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

const PROFILES = [
  { id: 'p-kvt', name: 'KVT', host: '192.168.100.56', port: 22, username: 'jun', auth: { type: 'password', secretRef: { store: 'vault', key: 'p-kvt' } }, group: '개발' },
  { id: 'p-prod', name: '결제-운영', host: '10.20.30.40', port: 22, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p-prod' } }, group: '운영' }
]

const ptys = new Map()
let getWc = () => null

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...PROFILES[0], ...input, id: input.id || 'p-new' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  // 호스트키 모달 캡처용: 항상 최초 접속(TOFU) 을 돌려준다.
  ipcMain.handle('ssh:connect', (_e, { profileId }) => {
    const p = PROFILES.find((x) => x.id === profileId)
    return { ok: false, reason: 'hostKeyNew', hostId: p.host + ':' + p.port, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:yotEW8gALLzMGE68FQiu8eq8RtdkR4GbGXjRb/EHFI4' }
  })
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
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
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

const checks = []

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  // ── 1. 트리 서버 노드 우클릭 메뉴 ──
  const a = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const srv = [...document.querySelectorAll('.tree .srv-node:not(.new-local)')].find(n => /KVT/.test(n.textContent))
    const r = srv.getBoundingClientRect()
    srv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 120), clientY: Math.round(r.bottom) }))
    await wait(400)
    return { items: document.querySelectorAll('.ctx-menu .ctx-item').length, labels: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.textContent) }
  })()`)
  checks.push(['트리 우클릭 메뉴 6항목', a.items === 6])
  console.log('  메뉴: ' + a.labels.join(' / '))
  await capture(win, 'FIX-ux1-treemenu.png')

  // ── 2. 커스텀 호스트키 모달 ──
  const b = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)
    window.__nativeUsed = false
    window.confirm = () => { window.__nativeUsed = true; return false }
    window.__evConnect('p-kvt')
    await wait(600)
    const m = document.querySelector('.overlay .modal.sm')
    return { open: !!m, text: m ? m.textContent : '', nativeUsed: window.__nativeUsed }
  })()`)
  checks.push(['커스텀 호스트키 모달 표시', b.open === true])
  checks.push(['네이티브 confirm 미사용', b.nativeUsed === false])
  checks.push(['모달에 SHA256 지문 표시', /SHA256:yotEW8/.test(b.text)])
  await capture(win, 'FIX-ux1-hostkey.png')

  // ── 3. 커스텀 드롭다운(연결 관리자 그룹 필드) ──
  const c = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 호스트키 모달 취소.
    const cancel = [...document.querySelectorAll('.overlay .modal.sm .btn')].find(x => x.textContent.trim() === '취소')
    if (cancel) cancel.click()
    await wait(300)
    const sessionMenu = [...document.querySelectorAll('.tb-menu span')].find(s => s.textContent === 'Session')
    if (sessionMenu) sessionMenu.click()
    await wait(200)
    // R4.1: Session 드롭다운 → 연결 관리자.
    document.querySelector('.ctx-menu .ctx-item[data-action="connection.manager"]')?.click()
    await wait(500)
    document.querySelector('.prof-form .dd .dd-btn')?.click()
    await wait(300)
    return {
      nativeSelects: document.querySelectorAll('select').length,
      opts: [...document.querySelectorAll('.prof-form .dd .dd-list .dd-opt')].map(o => o.textContent)
    }
  })()`)
  checks.push(['네이티브 <select> 0개', c.nativeSelects === 0])
  checks.push(['커스텀 드롭다운 펼침(개발/운영)', c.opts.join(',') === '개발,운영'])
  await capture(win, 'FIX-ux1-dropdown.png')

  // ── 4. 탭바 ＋ 원클릭 로컬 셸(UI-tabbar) + 우클릭 보조 메뉴(로컬 셸 / SSH 연결) ──
  const d = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(300)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(300)
    const tabsBefore = document.querySelectorAll('.term-tabbar .ttab').length
    document.querySelector('.tterm-add')?.click()
    await wait(500)
    const tabsAfterClick = document.querySelectorAll('.term-tabbar .ttab').length
    const noMenuOnClick = document.querySelectorAll('.ctx-menu').length === 0
    document.querySelector('.tterm-add')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
    await wait(300)
    return {
      tabsBefore, tabsAfterClick, noMenuOnClick,
      items: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.textContent)
    }
  })()`)
  checks.push(['＋ 좌클릭 = 메뉴 없이 로컬 셸 1개 생성', d.noMenuOnClick && d.tabsAfterClick === d.tabsBefore + 1])
  checks.push(['＋ 우클릭 보조 메뉴 = 로컬 셸 / SSH 연결', d.items.length === 2 && /로컬 셸/.test(d.items[0])])
  console.log('  ＋우클릭 보조메뉴: ' + d.items.join(' / '))
  await capture(win, 'FIX-ux1-addmenu.png')

  // ── 5. 터미널 우클릭 리스트 메뉴(기본값) ──
  const e = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)
    document.querySelector('.tterm-add')?.click(); await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click()
    await wait(1400)
    const grid = document.querySelector('.pane-grid')
    const r = grid.getBoundingClientRect()
    grid.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(r.left + 150), clientY: Math.round(r.top + 120) }))
    await wait(400)
    return {
      items: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action),
      icons: document.querySelectorAll('.ctx-menu .ctx-item .ci-ic svg').length,
      hints: [...document.querySelectorAll('.ctx-menu .ctx-item .ci-kbd')].map(k => k.textContent),
      style: document.querySelector('.menu-toggle span:last-child')?.textContent || ''
    }
  })()`)
  checks.push(['터미널 우클릭 = 리스트 8항목', e.items.length === 8])
  checks.push(['리스트 항목 아이콘 8개', e.icons === 8])
  checks.push(['단축키 힌트 표시', e.hints.includes('Ctrl+W')])
  checks.push(['토글 라벨 기본 = 리스트', e.style === '리스트'])
  console.log('  리스트 힌트: ' + e.hints.join(' / '))
  await capture(win, 'FIX-ux1-listmenu.png')

  let ok = true
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name)
    if (!pass) ok = false
  }
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('FAIL timeout (60s)'); app.exit(1) }, 60000)
