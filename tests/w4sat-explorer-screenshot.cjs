// W4sat F20 실기동 스크린샷 — 탐색기 전체화면 2패널(좌:로컬 / 우:SSH 원격, 실 ssh2 하네스) 을 실제로
// 열고, 좌측에서 큰 파일을 선택해 우측(원격)으로 "복사 →" 를 실제로 눌러 sftp:upload 진행률이 뜨는
// 순간을 캡처한다. F7 패턴(tests/f7-screenshot.cjs) 재사용 — SFTP 는 shell 과 같은 커넥션 재사용.
// DLP: 실서버 접속 없음(로컬 ssh2 루프백 하네스) · 데모 파일은 무해한 채움 바이트뿐.
// 산출물: agent_talk/W4sat-explorer-screenshot.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const real = require('./.w4sat-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT = join(__dirname, '..', 'agent_talk', 'W4sat-explorer-screenshot.png')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 원격(하네스) 쪽 — 둘러볼 폴더 몇 개(전송 대상 아님, 화면 채우기용).
const remoteRoot = mkdtempSync(join(tmpdir(), 'w4sat-remote-'))
mkdirSync(join(remoteRoot, '배포'))
writeFileSync(join(remoteRoot, '배포', 'release_note.md'), '# 릴리스\n')
writeFileSync(join(remoteRoot, 'README.txt'), '데모용 원격 루트\n')

// 로컬 쪽 — LocalFs 의 '.' 가 homedir() 고정이라 그 아래 임시 폴더를 만든다(스크린샷 뒤 정리).
// ponytail: 홈 하위 임시 폴더 — LocalFs 경로를 우회할 방법이 없어 홈 자체는 손대지 않고 하위 1개 폴더만 쓴다.
const localFixture = join(homedir(), '.w4sat-explorer-demo')
rmSync(localFixture, { recursive: true, force: true })
mkdirSync(localFixture)
const BIG_NAME = '대용량_전송데모.bin'
writeFileSync(join(localFixture, BIG_NAME), Buffer.alloc(40 * 1024 * 1024, 0x41)) // 40MB — 진행률 캡처용
writeFileSync(join(localFixture, '메모.txt'), '탐색기 데모\n')

function cleanup() {
  try { rmSync(localFixture, { recursive: true, force: true }) } catch {}
  try { rmSync(remoteRoot, { recursive: true, force: true }) } catch {}
}
const fail = (m) => { console.error('W4sat EXPLORER SHOT FAIL: ' + m); cleanup(); app.exit(1) }

let win
const getWc = safeWc(() => win)
const jsr = (code) => win.webContents.executeJavaScript(code)

function wireStubs() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 4, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', () => ({ profile: {} }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
}

async function capture(path) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(150)
  win.setSize(w, h)
  await wait(250)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await wait(600); img = await win.webContents.capturePage() }
  writeFileSync(path, img.toPNG())
  console.log('SCREENSHOT ' + path + ' bytes=' + img.toPNG().length)
}

app.whenReady().then(async () => {
  const sessions = real.registerSessionIpc(getWc)
  real.registerSftpIpc(sessions, getWc)
  real.registerFsIpc()
  wireStubs()

  const harness = await real.startPasswordServer({ sftpRoot: remoteRoot })

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('renderer gone: ' + JSON.stringify(d)))
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(700)

  const outcome = await real.connectSsh(
    { id: 'p1', type: 'ssh', name: 'harness', host: '127.0.0.1', port: harness.port, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } },
    { knownHosts: {}, secret: harness.password, acceptHostKey: true, onHostKeyAccepted: () => {} }
  )
  if (!outcome.ok) return fail('ssh connect: ' + outcome.reason)
  const sessionId = sessions.adopt(outcome.backend, { type: 'ssh', profileId: 'p1', title: 'harness', serverKey: 'harness', cwd: undefined, shell: undefined })

  const adopted = await jsr(`(() => window.__evAdopt ? (window.__evAdopt(${JSON.stringify(sessionId)}, 'harness', 'harness', 'ssh'), true) : false)()`)
  if (!adopted) return fail('__evAdopt seam 없음')
  await wait(300)

  // 탐색기 모드 진입(Ctrl+Shift+O — keymap.ts 단일 소스와 같은 조합).
  await jsr(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true, bubbles: true }))`)
  await wait(500)
  const opened = await jsr(`(() => document.querySelectorAll('.explorer-panel').length)()`)
  if (opened !== 2) return fail('탐색기 2패널 미렌더: panels=' + opened)

  // 우측 패널을 원격(harness SSH) 으로 전환.
  const switched = await jsr(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const panels = document.querySelectorAll('.explorer-panel')
    const right = panels[1]
    right.querySelector('.dd-btn')?.click()
    await wait(200)
    const opt = [...right.querySelectorAll('.dd-opt')].find(o => /harness/.test(o.textContent))
    if (!opt) return false
    opt.click()
    return true
  })()`)
  if (!switched) return fail('우측 패널 SSH 세션 전환 실패')
  await wait(1000)

  const rightLoaded = await jsr(`(() => {
    const right = document.querySelectorAll('.explorer-panel')[1]
    const names = [...right.querySelectorAll('.ftree .frow .fn')].map(n => n.textContent)
    return { names, korean: names.some(n => /배포|README/.test(n)) }
  })()`)
  console.log('W4sat 우측(원격) 로드:', JSON.stringify(rightLoaded))
  if (!rightLoaded.korean) return fail('우측 원격 목록 미렌더: ' + JSON.stringify(rightLoaded))

  // 좌측(로컬, 홈 디렉토리)에서 데모 폴더로 진입.
  const enteredLeft = await jsr(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const left = document.querySelectorAll('.explorer-panel')[0]
    const row = [...left.querySelectorAll('.ftree .frow.dir')].find(r => /w4sat-explorer-demo/.test(r.querySelector('.fn')?.textContent || ''))
    if (!row) return { ok: false, names: [...left.querySelectorAll('.ftree .frow .fn')].map(n => n.textContent) }
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(500)
    return { ok: true }
  })()`)
  console.log('W4sat 좌측(로컬) 데모 폴더 진입:', JSON.stringify(enteredLeft))
  if (!enteredLeft.ok) return fail('좌측 데모 폴더 없음: ' + JSON.stringify(enteredLeft))

  // 큰 파일을 선택 → 우클릭 → "복사 →" (다른 패널로 복사, F20 신규 컨텍스트 메뉴 항목).
  const sent = await jsr(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const left = document.querySelectorAll('.explorer-panel')[0]
    const row = [...left.querySelectorAll('.ftree .frow')].find(r => r.querySelector('.fn')?.textContent === ${JSON.stringify(BIG_NAME)})
    if (!row) return { ok: false }
    row.click()
    await wait(150)
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
    await wait(250)
    const item = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(el => el.textContent.includes('복사 →'))
    if (!item) return { ok: false, menu: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(e => e.textContent) }
    item.click()
    return { ok: true }
  })()`)
  console.log('W4sat 복사 → 실행:', JSON.stringify(sent))
  if (!sent.ok) return fail('컨텍스트 메뉴 "복사 →" 없음: ' + JSON.stringify(sent))

  // 진행률 UI(.xfer-fill)가 뜰 때까지 짧게 폴링 → 뜬 순간 캡처(전송 완료 전).
  let xferShown = false
  for (let i = 0; i < 40; i++) {
    xferShown = await jsr(`!!document.querySelector('.explorer-xfer .xfer-fill')`)
    if (xferShown) break
    await wait(80)
  }
  const xferState = await jsr(`(() => {
    const el = document.querySelector('.explorer-xfer')
    return el ? { label: document.querySelector('.explorer-xfer .xfer-label')?.textContent, pct: document.querySelector('.explorer-xfer .xfer-pct')?.textContent } : null
  })()`)
  console.log('W4sat 진행 UI:', JSON.stringify(xferState))
  if (!xferShown) return fail('전송 진행 UI(.xfer-fill) 미노출')
  await capture(SHOT)

  // 전송 완료까지 대기 후 최종 상태 확인(원격에 파일 도착 + 좌측 원본은 그대로 — copy 모드).
  for (let i = 0; i < 60; i++) {
    const done = await jsr(`!document.querySelector('.explorer-xfer')`)
    if (done) break
    await wait(200)
  }
  const arrived = existsSync(join(remoteRoot, BIG_NAME))
  const originalKept = existsSync(join(localFixture, BIG_NAME))
  console.log('W4sat 전송 결과: 원격도착=' + arrived + ' 원본유지(copy)=' + originalKept)

  harness.close().catch(() => {})
  cleanup()
  const ok = opened === 2 && rightLoaded.korean && enteredLeft.ok && sent.ok && xferShown && arrived && originalKept
  console.log(ok ? 'W4sat EXPLORER SCREENSHOT OK' : 'W4sat EXPLORER SCREENSHOT FAIL')
  app.exit(ok ? 0 : 1)
})

setTimeout(() => fail('timeout (60s)'), 60000)
