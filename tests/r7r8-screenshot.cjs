// R7+R8 실기동 스크린샷.
//   `electron tests/r7r8-screenshot.cjs before` → agent_talk/R8-before.png (디자인 정돈 전 메인 화면)
//   `electron tests/r7r8-screenshot.cjs`        → agent_talk/R8-after.png (같은 구도) +
//                                                 agent_talk/R7-filetree-screenshot.png (로컬 파일 트리 + 우클릭 메뉴)
// before/after 는 같은 셋업 코드를 타므로 구도가 동일하다(세션 2개 · 배포 로그 · 사이드바 연결 탭).
// 로컬 파일 트리는 실제 node fs 로 만든 임시 디렉토리를 fs:* 핸들러가 그대로 읽는다(가짜 목록 아님).
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join, resolve, dirname } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, copyFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const BEFORE = process.argv.includes('before')
const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 로컬 파일 트리용 임시 디렉토리(한글 파일·폴더 + 크기·mtime 다양) ──
const FSROOT = mkdtempSync(join(tmpdir(), 'ara-r7-'))
// 다중 다운로드가 실제로 파일을 떨어뜨리는 곳(sftp:pickSaveDir 가 이 경로를 돌려준다).
const DLDIR = mkdtempSync(join(tmpdir(), 'ara-r7-dl-'))
function seedFs() {
  mkdirSync(join(FSROOT, '배포스크립트'))
  mkdirSync(join(FSROOT, '로그'))
  mkdirSync(join(FSROOT, 'node_modules'))
  writeFileSync(join(FSROOT, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
  writeFileSync(join(FSROOT, 'README_한글.md'), '# 한글 문서\n'.repeat(120))
  writeFileSync(join(FSROOT, 'package.json'), '{\n  "name": "ara"\n}\n')
  writeFileSync(join(FSROOT, 'access_20260731.log'), Buffer.alloc(2 * 1024 * 1024, 0x41))
  writeFileSync(join(FSROOT, '결제_정산.csv'), '주문번호,금액\n1,1000\n')
}
seedFs()

const PROFILES = [
  { id: 'p1', name: '결제서버', host: '10.20.30.40', port: 22, username: 'deploy', group: '운영', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } },
  { id: 'p2', name: 'web-dev01', host: '192.168.0.11', port: 22, username: 'deploy', group: '개발', auth: { type: 'password', secretRef: { store: 'vault', key: 'p2' } } }
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

function makeSession(type, title, serverKey, profileId) {
  const id = type + '-' + Math.random().toString(36).slice(2)
  const p = spawnPty()
  ptys.set(id, p)
  SESSIONS.push({ id, type, profileId: profileId ?? null, cwd: undefined, title, serverKey })
  p.onData((d) => pushData(id, d))
  p.onExit(() => { ptys.delete(id) })
  return id
}

// ── fs:* (로컬 파일 트리) — 실제 node fs. 앱의 LocalFsService 와 같은 계약 형태만 맞춘다. ──
const okList = (p) => {
  const abs = resolve(p === '.' || !p ? FSROOT : p)
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
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p9', auth: { type: 'password', secretRef: { store: 'vault', key: 'p9' } } } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { ...UI, groups: [] }
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
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
  // SFTP 스텁 — 트리·전송 큐 실증용으로 같은 임시 디렉토리를 "원격"으로 노출한다.
  // (실 SFTP 프로토콜·취소·부분정리는 vitest tests/sftp.test.ts 가 ssh2 하네스로 실증한다.)
  ipcMain.handle('sftp:list', (_e, { path }) => okList(path))
  // 다운로드: 진행 이벤트 2회 방출 후 실제로 복사 — 렌더러 전송 큐(순차·항목별 진행률)를 실증한다.
  ipcMain.handle('sftp:download', async (_e, { transferId, remotePath, localPath, size }) => {
    for (const done of [Math.round(size / 2), size]) {
      const wc = getWc()
      if (wc) wc.send('sftp:progress:' + transferId, { transferId, transferred: done, total: size })
      await wait(140)
    }
    copyFileSync(remotePath, localPath)
    return { ok: true }
  })
  ipcMain.handle('sftp:upload', () => ({ ok: true }))
  ipcMain.handle('sftp:cancel', () => ({ ok: true }))
  ipcMain.handle('sftp:rename', () => ({ ok: true }))
  ipcMain.handle('sftp:mkdir', () => ({ ok: true }))
  ipcMain.handle('sftp:remove', () => ({ ok: true }))
  ipcMain.handle('sftp:pickSavePath', () => ({ path: null }))
  ipcMain.handle('sftp:pickSaveDir', () => ({ path: DLDIR }))
  ipcMain.handle('sftp:pickUploadPaths', () => ({ paths: [] }))
  // 로컬 파일 트리 — 실제 임시 디렉토리.
  ipcMain.handle('fs:list', (_e, { path }) => okList(path))
  ipcMain.handle('fs:rename', (_e, { path, name }) => {
    try { renameSync(path, join(dirname(path), name)); return { ok: true } } catch (e) { return { ok: false, message: String(e.message) } }
  })
  ipcMain.handle('fs:mkdir', (_e, { dir, name }) => {
    try { mkdirSync(join(dir, name)); return { ok: true } } catch (e) { return { ok: false, message: String(e.message) } }
  })
  // #89: fs:remove → fs:trash. 이 하네스는 자기 임시 폴더만 쓰므로 그대로 지운다
  // (실제 휴지통을 부르지 않는다 — 스크린샷 한 장 찍자고 사용자 휴지통에 쌓을 이유가 없다).
  ipcMain.handle('fs:trash', (_e, { paths }) => {
    try { for (const p of paths) rmSync(p, { recursive: true, force: false }); return { ok: true } } catch (e) { return { ok: false, message: String(e.message) } }
  })
}

const E = '\x1b['
const R = E + '0m'
const LOG = [
  `${E}1;36mdeploy@결제서버:/srv/서비스$ ./배포.sh --stage prod${R}`,
  `${E}32m✔${R} 이미지 빌드 완료 · 402MB`,
  `${E}32m✔${R} 헬스체크 통과 (12/12)`,
  `${E}33m⚠${R} 캐시 워밍업 지연 — 재시도 1회`,
  `${E}90m# 차분한 다크 — 장식 글로우 없이 상태만 빛난다${R}`,
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

  // 공통 구도: SSH 세션 2개(그룹 래퍼 + 단독 탭) + 로컬 셸 1개 + 배포 로그.
  const ids = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    await window.__evConnect('p1')
    await wait(700)
    await window.__evConnect('p2')
    await wait(700)
    const list = await window.ev.session.list()
    // 로그는 활성(마지막 접속) 세션에 찍어야 화면에 보인다.
    return { ssh: [...list].reverse().find(s => s.type === 'ssh')?.id || '' }
  })()`)
  // 셸 자체 출력(프롬프트)이 로그와 겹치지 않도록 충분히 기다렸다 화면을 지우고 찍는다.
  // 프롬프트가 늦게 나오는 경우가 있어 한 번 더 지우고 다시 쓴다(clear 포함이라 멱등).
  await wait(2000)
  pushData(ids.ssh, '\x1b[2J\x1b[H' + LOG)
  await wait(900)
  pushData(ids.ssh, '\x1b[2J\x1b[H' + LOG)
  await wait(900)

  // ── ① 메인 화면(before/after 공통 구도) ──
  await capture(win, BEFORE ? 'R8-before.png' : 'R8-after.png')

  // R8 톤다운 실측(스크린샷 눈대중이 아니라 계산된 스타일로 확인).
  const r8 = await win.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('.ttab.active')
    const pane = document.querySelector('.pane')
    return {
      bodyGradient: getComputedStyle(document.body).backgroundImage,
      tabUnderGlow: tab ? getComputedStyle(tab, '::after').boxShadow : 'none',
      paneShadow: pane ? getComputedStyle(pane).boxShadow : '',
      paneFocused: !!document.querySelector('.pane.focused'),
      dotGlow: getComputedStyle(document.querySelector('.st') || document.body).boxShadow,
      groupGradient: getComputedStyle(document.querySelector('.tg') || document.body).backgroundImage
    }
  })()`)
  console.log('R8 톤다운:', JSON.stringify(r8))

  if (BEFORE) {
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    rmSync(FSROOT, { recursive: true, force: true })
  rmSync(DLDIR, { recursive: true, force: true })
    console.log('R8 BEFORE SCREENSHOT OK')
    app.exit(0)
    return
  }

  // ── ② 로컬 파일 트리 + 다중 선택 + 우클릭 메뉴 ──
  const s2 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // 로컬 셸을 열고 활성화 → [파일] 탭이 로컬 파일시스템을 탐색한다.
    const { id } = await window.ev.session.create({ type: 'local', title: '로컬 셸', serverKey: 'localhost', profileId: null })
    window.__evAdopt(id, '로컬 셸', 'localhost', 'local')
    await wait(900)
    document.querySelectorAll('.sb-tab')[1].click()
    await wait(900)
    const rows = [...document.querySelectorAll('.ftree .frow')]
    const files = rows.filter(r => !r.classList.contains('dir'))
    // ① 단일 선택 메뉴(다운로드 없음=로컬 / 이름 변경 있음)를 먼저 확인하고 닫는다.
    files[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(120)
    files[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }))
    await wait(250)
    const single = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)
    // ② Ctrl 클릭으로 파일 2개 다중 선택 → 다중 메뉴.
    files[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(120)
    files[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await wait(200)
    // 선택된 행 위에서 우클릭 → 파일 메뉴.
    const r = files[1].getBoundingClientRect()
    files[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 90, clientY: r.bottom + 4 }))
    await wait(400)
    return {
      single,
      names: rows.map(r => r.querySelector('.fn')?.textContent || ''),
      crumbs: [...document.querySelectorAll('.fcrumb .seg')].map(s => s.textContent),
      mtimes: [...document.querySelectorAll('.ftree .frow .fmt')].map(s => s.textContent).filter(Boolean),
      selected: document.querySelectorAll('.ftree .frow.sel').length,
      menu: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action),
      icons: document.querySelectorAll('.ftree .frow .fi svg').length
    }
  })()`)
  console.log('R7 파일 트리:', JSON.stringify(s2))
  await capture(win, 'R7-filetree-screenshot.png')

  // ── ③ 파일 조작 실동작(UI → IPC → 실제 파일시스템) ──
  // 새 폴더 / 이름 변경 / 삭제(취소 → 확인)를 화면에서 그대로 눌러 임시 디렉토리가 실제로 바뀌는지 본다.
  const s3 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const rows = () => [...document.querySelectorAll('.ftree .frow')]
    const names = () => rows().map(r => r.querySelector('.fn')?.textContent || '')
    const rowNamed = (n) => rows().find(r => (r.querySelector('.fn')?.textContent || '') === n)
    const pick = async (row, action) => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(120)
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }))
      await wait(250)
      document.querySelector('.ctx-menu .ctx-item[data-action="' + action + '"]')?.click()
      await wait(300)
    }
    document.querySelector('.ctx-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(200)

    // ① 새 폴더 — 빈 영역 우클릭 → 이름 입력 다이얼로그 → 확인.
    document.querySelector('.ftree').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 520 }))
    await wait(250)
    document.querySelector('.ctx-menu .ctx-item[data-action="file.mkdir"]')?.click()
    await wait(350)
    const dlgInput = document.querySelector('.dlg-overlay .dlg-input')
    if (dlgInput) setVal(dlgInput, '신규_폴더')
    await wait(120)
    document.querySelector('.dlg-overlay .modal-ft .btn.pri')?.click()
    await wait(700)
    const afterMkdir = names()

    // ② 이름 변경 — 인라인 입력에 새 이름 + Enter.
    const pk = rowNamed('package.json')
    if (pk) await pick(pk, 'file.rename')
    const edit = document.querySelector('.ftree .frow .fedit')
    if (edit) {
      setVal(edit, 'package_바뀜.json')
      edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    await wait(700)
    const afterRename = names()

    // ③ 삭제 취소 — 확인 다이얼로그에서 [취소] 하면 아무것도 지워지지 않는다.
    const del1 = rowNamed('신규_폴더/')
    if (del1) await pick(del1, 'file.delete')
    const dlgDanger = !!document.querySelector('.dlg-overlay .modal.sm.danger')
    const dlgText = document.querySelector('.dlg-overlay .dlg-msg')?.textContent || ''
    document.querySelector('.dlg-overlay .modal-ft .btn.sec')?.click()
    await wait(600)
    const afterCancel = names()

    // ④ 삭제 확인 — 위험 버튼(.dgr)으로 확정.
    const del2 = rowNamed('신규_폴더/')
    if (del2) await pick(del2, 'file.delete')
    document.querySelector('.dlg-overlay .modal-ft .btn.dgr')?.click()
    await wait(800)
    const afterDelete = names()
    return { afterMkdir, afterRename, afterCancel, afterDelete, dlgDanger, dlgText }
  })()`)
  // 화면만이 아니라 디스크가 실제로 바뀌었는지 main 쪽에서 확인한다.
  const onDisk = readdirSync(FSROOT)
  console.log('R7 파일 조작:', JSON.stringify({ ...s3, onDisk }))

  // ── ④ SSH 세션 다중 다운로드 — 전송 큐(순차 · 항목별 진행률) ──
  const s4 = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    // SSH 탭으로 전환 → [파일] 탭이 SFTP 백엔드로 갈아끼워진다.
    document.querySelector('.term-tabbar .ttab')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(700)
    document.querySelectorAll('.sb-tab')[1].click()
    await wait(800)
    const files = [...document.querySelectorAll('.ftree .frow')].filter(r => !r.classList.contains('dir'))
    files[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(100)
    files[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await wait(150)
    files[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 300 }))
    await wait(250)
    const menu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(i => i.dataset.action)
    document.querySelector('.ctx-menu .ctx-item[data-action="file.download"]')?.click()
    // 전송 중 큐를 샘플링한다(await 하지 않고 관찰).
    let maxItems = 0
    let sawProgress = false
    let sawCancel = false
    for (let i = 0; i < 60; i++) {
      await wait(70)
      const items = document.querySelectorAll('.sftp-xfer .xfer-item')
      if (items.length > maxItems) maxItems = items.length
      if ([...document.querySelectorAll('.sftp-xfer .xfer-pct')].some(p => p.textContent !== '0%')) sawProgress = true
      if (document.querySelector('.sftp-xfer .xfer-cancel')) sawCancel = true
      if (maxItems > 0 && items.length === 0) break
    }
    return { menu, maxItems, sawProgress, sawCancel, err: document.querySelector('.sftp-err')?.textContent || '' }
  })()`)
  const downloaded = readdirSync(DLDIR)
  console.log('R7 다중 다운로드:', JSON.stringify({ ...s4, downloaded }))

  const xferOk =
    s4.menu.join(',') === 'file.download,file.mkdir,file.delete' &&
    s4.maxItems === 2 &&
    s4.sawProgress === true &&
    s4.sawCancel === true &&
    s4.err === '' &&
    downloaded.length === 2

  const opsOk =
    s3.afterMkdir.includes('신규_폴더/') &&
    s3.afterRename.includes('package_바뀜.json') &&
    !s3.afterRename.includes('package.json') &&
    s3.dlgDanger === true &&
    s3.dlgText.includes('되돌릴 수 없습니다') &&
    s3.afterCancel.includes('신규_폴더/') &&
    !s3.afterDelete.includes('신규_폴더/') &&
    onDisk.includes('package_바뀜.json') &&
    !onDisk.includes('신규_폴더') &&
    !onDisk.includes('package.json')

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  rmSync(FSROOT, { recursive: true, force: true })
  rmSync(DLDIR, { recursive: true, force: true })

  // R8: 배경 그라디언트 · 탭 하단 발광 · dot 발광이 모두 사라졌고 패널 그림자는 중립 검정이다.
  const toned =
    r8.bodyGradient === 'none' &&
    r8.tabUnderGlow === 'none' &&
    r8.groupGradient === 'none' &&
    r8.dotGlow === 'none' &&
    // 패널: 중립 검정 드롭섀도 + 번짐 0 인 액센트 링(상태 표시)만. 발광(blur>0 액센트)은 없다.
    r8.paneShadow.includes('rgba(0, 0, 0') &&
    /rgba\(56, 189, 248[^)]*\) 0px 0px 0px 1px/.test(r8.paneShadow)

  const ok =
    toned &&
    opsOk &&
    xferOk &&
    s2.names.includes('배포스크립트/') &&
    s2.names.includes('README_한글.md') &&
    s2.crumbs.length > 0 &&
    s2.mtimes.length > 0 &&
    s2.selected === 2 &&
    s2.icons === s2.names.length &&
    s2.single.join(',') === 'file.rename,file.mkdir,file.delete' &&
    s2.menu.join(',') === 'file.mkdir,file.delete'
  console.log('R8 톤다운:', toned, '/ 파일 조작:', opsOk, '/ 전송 큐:', xferOk)
  console.log(ok ? 'R7R8 SCREENSHOT OK (로컬 트리 · 다중선택 · 메뉴 · 새폴더/이름변경/삭제 실동작 · 네온 톤다운)' : 'R7R8 SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('R7R8 screenshot timeout'); app.exit(1) }, 90000)
