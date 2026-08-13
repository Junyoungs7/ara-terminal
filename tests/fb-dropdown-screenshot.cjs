// FB-dropdown 실기동 검증 스크린샷.
// 연결 관리자를 열고 그룹 콤보(.dd)를 펼쳐 목록이 모달 푸터 버튼([취소]/[저장 후 접속]) 뒤로
// 가려지지 않고 온전히 보이는지 실측한다 — z-index/overflow 판정용 겹침 검사 포함.
// r5r6-screenshot.cjs 의 IPC 스텁 패턴을 그대로 쓴다(새 하네스 아님).
const { app, BrowserWindow, ipcMain } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 그룹 6종 — 목록을 충분히 길게 만들어(240px 근처) 클리핑/flip 판정이 화면에서도 뚜렷하게 보이게 한다.
const mkProfile = (id, name, host, group) => ({
  id, name, host, port: 22, username: 'deploy',
  auth: { type: 'password', secretRef: { store: 'vault', key: id } },
  ...(group ? { group } : {})
})
let PROFILES = [
  mkProfile('p1', '결제서버', '10.20.30.40', '운영'),
  mkProfile('p2', '정산배치', '10.20.30.41', '개발'),
  mkProfile('p3', 'web-dev01', '192.168.0.11', 'QA'),
  mkProfile('p4', '사내위키', '192.168.0.90', '기획')
]
let GROUPS = ['백업', '모니터링']
const UI = {
  sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
  ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
  locale: 'ko', scrollback: 10000, copyOnSelect: true, cursorStyle: 'block', cursorBlink: true, bell: 'off'
}

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('profile:save', (_e, input) => {
    const id = input.id || 'p' + (PROFILES.length + 1)
    const profile = {
      id, name: input.name, host: input.host, port: input.port, username: input.username,
      auth: { type: 'password', secretRef: { store: 'vault', key: id } },
      ...(input.group ? { group: input.group } : {})
    }
    PROFILES = [...PROFILES.filter((p) => p.id !== id), profile]
    return { profile }
  })
  ipcMain.handle('profile:delete', (_e, { id }) => { PROFILES = PROFILES.filter((p) => p.id !== id); return { ok: true } })
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: PROFILES, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { ...UI, groups: GROUPS }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', (_e, { groups }) => { GROUPS = groups; return { ok: true } })
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))
  ipcMain.handle('session:create', () => ({ id: 'local-fake' }))
  ipcMain.handle('session:attach', () => ({ backlog: new Uint8Array() }))
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('session:resize', () => ({ ok: true }))
  ipcMain.handle('session:destroy', () => ({ ok: true }))
  ipcMain.on('session:input', () => {})
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/', entries: [] }))
}

// 다른 스크린샷 스크립트(r5r6 등)의 강제 리페인트(1px 리사이즈) 트릭은 여기선 못 쓴다 —
// 리사이즈가 Dropdown.tsx 의 "리사이즈 시 닫기" 리스너를 그대로 건드려 캡처 직전에 목록이
// 닫혀 버린다(이 회귀 가드는 실제 동작상 맞다 — 캡처 기법이 그것과 충돌할 뿐). 리사이즈 없이 캡처.
async function capture(win, name) {
  await wait(300)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(600); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  wire()
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  win.focus()
  await wait(1200)

  const r = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms))
    // Ctrl+Shift+M → 연결 관리자(회귀 가드로 smoke-boot.cjs 가 이미 검증한 진입점).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(400)
    const modalOpen = !!document.querySelector('.overlay.open .modal')

    // RDP로 전환: 인증 섹션이 사라져 그룹 필드가 폼의 마지막 행이 된다(사용자가 겪은 조건과 같은
    // 모양 — .prof-form 바닥과 그룹 드롭다운 사이에 여유 콘텐츠가 없는 최악의 경우).
    const rdpBtn = [...document.querySelectorAll('.prof-form .seg-ctl button')].find(b => b.textContent.trim() === 'RDP')
    if (rdpBtn) rdpBtn.click()
    await wait(200)

    const caret = document.querySelector('.prof-form .dd .dd-caret')
    caret?.click()
    await wait(200)

    const list = document.querySelector('.prof-form .dd .dd-list')
    const footer = document.querySelector('.modal-ft')
    const modal = document.querySelector('.overlay.open .modal')
    const lr = list?.getBoundingClientRect()
    const fr = footer?.getBoundingClientRect()
    const mr = modal?.getBoundingClientRect()
    const opts = [...document.querySelectorAll('.prof-form .dd .dd-list .dd-opt')].map(o => o.textContent)

    // 겹침 판정: 목록의 아래 경계가 푸터의 위 경계보다 위에 있어야 한다(= 푸터 뒤로 넘어가지 않음).
    const clearsFooter = !!(lr && fr) && lr.bottom <= fr.top
    // 클리핑 판정: 목록 중앙점에서 실제로 목록 자신이 히트되는지(모달의 overflow:hidden에 잘려
    // 안 보이면 다른 요소가 히트된다).
    const midX = lr ? lr.left + lr.width / 2 : 0
    const midY = lr ? lr.top + lr.height / 2 : 0
    const hit = document.elementFromPoint(midX, midY)
    const listPaints = !!list && list.contains(hit)
    // 완전히 뷰포트 안(모달 밖으로도 안 잘림)에 있는지.
    const withinViewport = !!lr && lr.top >= 0 && lr.bottom <= window.innerHeight

    return {
      modalOpen, listVisible: !!list, opts, listRect: lr, footerRect: fr, modalRect: mr,
      clearsFooter, listPaints, withinViewport,
      position: list ? getComputedStyle(list).position : null
    }
  })()`)
  console.log('FB-dropdown 실측:', JSON.stringify(r))
  await capture(win, 'FB-dropdown-after.png')

  const ok = r.modalOpen && r.listVisible && r.opts.length >= 6 &&
    r.clearsFooter && r.listPaints && r.withinViewport && r.position === 'fixed'
  console.log(ok ? 'FB-DROPDOWN SCREENSHOT OK (목록이 푸터 위 · 클리핑 없음 · fixed 배치)' : 'FB-DROPDOWN SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('FB-dropdown screenshot timeout'); app.exit(1) }, 60000)
