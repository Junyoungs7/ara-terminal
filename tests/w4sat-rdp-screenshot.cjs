// W4sat F21 실기동 스크린샷 — 연결 관리자 폼에서 실제로 SSH→RDP 세그먼트를 눌러 인증 섹션이 사라지고
// 호스트·포트·사용자·표시이름·그룹만 남는 폼을 채워 저장하고, 저장 직후 사이드바 트리에 RDP 라벨(SSH와
// 구분되는 배지)로 나타나는 것까지 실제 UI 클릭·입력으로 실증한다.
// 2026-08-09: mstsc 외부 실행(rdp:launch)은 앱에서 제거됐다(A-40) — 저장 후 접속은 내장 뷰로 간다.
// 여기서는 붙을 서버가 없으므로 rdp:relay 를 실패로 스텁해 접속 시도가 밖으로 나가지 않게 한다(DLP).
// 산출물: agent_talk/W4sat-rdp-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = join(__dirname, '..', 'agent_talk', 'W4sat-rdp-screenshot.png')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 기존 SSH 프로필 하나를 미리 심어 두어 스크린샷에서 SSH 행(배지 없음)과 새로 만들 RDP 행(배지 있음)이
// 나란히 보이게 한다.
const profiles = [
  { id: 'p-ssh', type: 'ssh', name: 'prod-web', host: '10.20.30.40', port: 22, username: 'deploy', auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' }, group: '운영' }
]

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => profiles)
  ipcMain.handle('profile:save', (_e, input) => {
    const id = input.id || 'p-' + Math.random().toString(36).slice(2)
    const idx = profiles.findIndex((p) => p.id === id)
    const profile =
      input.type === 'rdp'
        ? { id, type: 'rdp', name: input.name, host: input.host, port: input.port, username: input.username, group: input.group }
        : { id, type: 'ssh', name: input.name, host: input.host, port: input.port, username: input.username, auth: { type: 'key', keyPath: input.keyPath || '' }, group: input.group }
    if (idx >= 0) profiles[idx] = profile
    else profiles.push(profile)
    return { profile }
  })
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  // 내장 RDP 릴레이는 열지 않는다 — 이 스크린샷은 폼·트리만 본다(실접속 시도 금지, DLP).
  ipcMain.handle('rdp:relay', () => ({ ok: false, message: 'rdp 스크린샷: 릴레이 미사용' }))
  ipcMain.handle('rdp:relayStop', () => ({ ok: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'rdp 스크린샷: ssh 미사용' }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: false }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 4, savedAt: '', app: { version: '0.1.0' }, profiles, knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
}

async function capture(win, path) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(200)
  win.setSize(w, h)
  await wait(350)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(700); img = await win.webContents.capturePage() }
  writeFileSync(path, img.toPNG())
  console.log('SCREENSHOT ' + path + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  wire()
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => { console.error('renderer gone: ' + JSON.stringify(d)); app.exit(1) })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(1000)

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const setVal = (el, v) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // 사이드바 [연결] 탭 ＋(새 연결) → 연결 관리자 모달.
    document.querySelector('.sb-tabs .sb-act')?.click()
    await wait(400)
    const modalOpen1 = !!document.querySelector('.overlay.open .modal')

    // SSH/RDP 세그먼트에서 RDP 선택 — 인증 섹션이 사라져야 한다.
    const rdpBtn = [...document.querySelectorAll('.modal .seg-ctl button')].find(b => b.textContent.trim() === 'RDP')
    rdpBtn?.click()
    await wait(200)
    const authSectionGone = !document.querySelector('.modal .pf-sec-t + .fld .seg-ctl') || ![...document.querySelectorAll('.modal .pf-sec-t')].some(el => el.textContent.includes('인증'))

    // 폼 채우기: 이름·호스트·포트·사용자(그룹은 비워 "기타").
    const inputs = [...document.querySelectorAll('.frm-grid input[type="text"]')]
    setVal(inputs[0], 'win-업무PC')
    setVal(inputs[1], '10.0.5.10')
    setVal(inputs[2], '13389')
    setVal(inputs[3], 'jun')
    await wait(150)

    // 저장 후 접속 — 모달이 닫히고 내장 뷰로 간다(릴레이는 스텁 실패라 화면엔 오류만 뜬다).
    document.querySelector('.modal-ft .btn.pri')?.click()
    await wait(700)
    const modalClosedAfterSave = !document.querySelector('.overlay.open .modal')

    // 트리에서 RDP 배지 확인(SSH 행에는 없어야 한다) — [연결] 탭이 이미 활성 상태.
    const rows = [...document.querySelectorAll('.srv-node')]
    const rdpRow = rows.find(r => /win-업무PC/.test(r.querySelector('.sname')?.textContent || ''))
    const sshRow = rows.find(r => /prod-web/.test(r.querySelector('.sname')?.textContent || ''))
    const rdpBadge = !!rdpRow?.querySelector('.srv-type.rdp')
    const sshNoBadge = !sshRow?.querySelector('.srv-type')

    return { modalOpen1, authSectionGone, modalClosedAfterSave, rdpBadge, sshNoBadge, rowCount: rows.length }
  })()`)

  console.log('W4sat RDP 검증:', JSON.stringify(result))
  await capture(win, shotPath)

  const ok = result.modalOpen1 && result.authSectionGone && result.modalClosedAfterSave && result.rdpBadge && result.sshNoBadge
  console.log(ok ? 'W4sat RDP SCREENSHOT OK' : 'W4sat RDP SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('W4sat RDP screenshot timeout'); app.exit(1) }, 45000)
