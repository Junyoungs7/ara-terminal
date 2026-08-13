// 가독성 패스 before/after 캡처 — 사이드바 트리 + 터미널 탭 + 상태바 + 한글 터미널 출력이
// 한 화면에 모두 들어오게 띄우고 1장 캡처한다.
// 산출물 이름은 ARA_SHOT_NAME, 터미널 기본 크기는 ARA_SHOT_TT(= defaults.ts ui.font.sizePx) 로 받는다.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const NAME = process.env.ARA_SHOT_NAME || 'FIX-readability-before.png'
const TT = Number(process.env.ARA_SHOT_TT || 13)

const profiles = [
  { id: 'p1', name: 'dev-server', host: '10.0.14.21', port: 22, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }, group: '개발' },
  { id: 'p2', name: 'stage-web-01', host: '10.0.14.44', port: 22, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p2' } }, group: '개발' },
  { id: 'p3', name: 'prod-api-01', host: '172.31.8.9', port: 22, username: 'root', auth: { type: 'password', secretRef: { store: 'vault', key: 'p3' } }, group: '운영' }
]

const ptys = new Map()
let getWc = () => null

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => profiles)
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: TT, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win32 = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: process.env }
    if (win32) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win32 ? 'powershell.exe' : '/bin/sh', win32 ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => { const wc = getWc(); if (!wc) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
    p.onExit(() => ptys.delete(id))
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

async function capture(win) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await new Promise((r) => setTimeout(r, 250))
  win.setSize(w, h); await new Promise((r) => setTimeout(r, 400))
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await new Promise((r) => setTimeout(r, 800)); img = await win.webContents.capturePage() }
  writeFileSync(join(__dirname, '..', 'agent_talk', NAME), img.toPNG())
  console.log('SCREENSHOT ' + NAME + ' bytes=' + img.toPNG().length)
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
  await new Promise((r) => setTimeout(r, 900))

  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(900)
    return document.querySelectorAll('.ttab').length
  })()`)

  for (const [, p] of ptys) {
    try {
      p.write('echo 안녕하세요 A.R.A 터미널입니다; echo 한글 가독성 점검 — 라벨·메타·상태바; echo "배포 완료: 3개 파일 전송됨"\r')
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1600))

  await capture(win)

  // 고정 높이 행(타이틀바 32 / 탭바 34 / 상태바 26 …)에서 커진 텍스트가 잘리는지 전수 확인.
  // 모달·드로어·치트시트·팔레트까지 열어 놓고 한 번에 훑는다.
  const clipped = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 모달·드로어는 React state 로 마운트되므로 실제 트리거를 눌러 연다.
    ;[...document.querySelectorAll('.tb-menu span')].find((s) => s.textContent === 'Session')?.click()
    await wait(200)
    // R4.1: Session 드롭다운 → 연결 관리자.
    document.querySelector('.ctx-menu .ctx-item[data-action="connection.manager"]')?.click()
    await wait(400)
    document.querySelector('.titlebar .tb-gear')?.click()
    await wait(400)
    document.querySelector('.titlebar .tb-help')?.click()
    await wait(400)

    const bad = []
    // (1) 고정 높이 컨테이너: 자식 텍스트 박스가 컨테이너 밖으로 나가면 잘린다.
    for (const sel of ['.titlebar', '.sb-tabs', '.term-tabbar', '.statusbar', '.pane-hd', '.sftp-path-bar']) {
      for (const box of document.querySelectorAll(sel)) {
        const b = box.getBoundingClientRect()
        for (const el of box.querySelectorAll('*')) {
          if (!el.textContent.trim() || el.children.length) continue
          const r = el.getBoundingClientRect()
          if (r.height === 0) continue
          if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)
            bad.push(sel + ' > ' + (el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 12) + '" 세로넘침')
        }
      }
    }
    // (2) overflow:hidden 으로 실제 내용이 잘려 있는 요소.
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (el.clientHeight === 0) continue
      if (cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1)
        bad.push((el.className || el.tagName) + ' 세로잘림 ' + el.scrollHeight + '>' + el.clientHeight)
      if (cs.overflowX === 'hidden' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1)
        bad.push((el.className || el.tagName) + ' 가로잘림 ' + el.scrollWidth + '>' + el.clientWidth)
    }
    const opened = ['.overlay.open', '.drawer.open', '.cheatsheet.open', '.smart-palette.open'].filter((s) => document.querySelector(s))
    return { bad: [...new Set(bad)], opened, scanned: document.querySelectorAll('body *').length }
  })()`)

  console.log(`스캔 대상 ${clipped.scanned}개 요소 · 열린 오버레이: ${clipped.opened.join(' ') || '없음'}`)
  if (clipped.bad.length) {
    console.log('FAIL 클리핑 ' + clipped.bad.length + '건:')
    for (const c of clipped.bad) console.log('  - ' + c)
  } else {
    console.log('PASS 고정 높이 클리핑 없음')
  }
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(clipped.bad.length ? 1 : 0)
})

setTimeout(() => { console.log('FAIL timeout (45s)'); app.exit(1) }, 45000)
