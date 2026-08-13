// FB-sync 실기동 스크린샷 — 실제 out/preload + out/renderer 창을 REAL SshBackend·MainSessionManager·
// registerTelemetryIpc 로 구동해 두 수정을 눈으로 확인한다.
//  ① FB-0007①: SSH 세션에서 cd → OSC7 주입(SshBackend) → 파일 트리 경로 자동 이동 → agent_talk/FB-sync-cd.png
//     ssh-harness 의 simulateBashPrompt 로 "실제 bash PROMPT_COMMAND 훅"을 흉내낸다(emitOsc7OnCd 처럼
//     cd 만 특수취급하지 않음 — SshBackend 의 주입이 실제로 셸을 깨웠을 때만 OSC7 이 나온다).
//  ② FB-0008: 로컬 셸 탭을 열면 하단 상태바에 CPU/MEM 게이지가 뜬다 → agent_talk/FB-sync-local-gauge.png
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const real = require('./.fb-sync-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT_CD = join(__dirname, '..', 'agent_talk', 'FB-sync-cd.png')
const SHOT_GAUGE = join(__dirname, '..', 'agent_talk', 'FB-sync-local-gauge.png')

// 원격 파일시스템(SFTP 루트) — cd 대상 디렉토리가 실제로 존재해야 트리가 뭔가를 보여준다.
const remoteRoot = mkdtempSync(join(tmpdir(), 'ev-fbsync-remote-'))
mkdirSync(join(remoteRoot, 'nginx'))
writeFileSync(join(remoteRoot, 'nginx', 'nginx.conf'), 'server { listen 80; }\n')
writeFileSync(join(remoteRoot, 'README.md'), '# dev-server\n')

let win
const getWc = safeWc(() => win)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const jsr = (code) => win.webContents.executeJavaScript(code)

function cleanup() {
  try { rmSync(remoteRoot, { recursive: true, force: true }) } catch {}
}
const fail = (m) => { console.error('FB-SYNC SHOT FAIL: ' + m); cleanup(); app.exit(1) }

function wireStubs() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'file', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', () => ({ profile: {} }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
}

app.whenReady().then(async () => {
  const sessions = real.registerSessionIpc(getWc)
  real.registerSftpIpc(sessions, getWc)
  real.registerTelemetryIpc(sessions, getWc)
  wireStubs()

  // FB-0007①: cd 여부와 무관하게 매 줄마다 OSC7 을 내는(실제 bash PROMPT_COMMAND 흉내) 원격 셸.
  // SshBackend 가 접속 직후 주입을 하기 *전에는* injected=false 라 OSC7 이 전혀 안 나간다(수정 전 버그 상태).
  const harness = await real.startPasswordServer({ sftpRoot: remoteRoot, simulateBashPrompt: true })

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('renderer gone: ' + JSON.stringify(d)))
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(600)

  // ── ① SSH 접속 → cd → OSC7 → 파일 트리 자동 이동 ──
  const outcome = await real.connectSsh(
    { id: 'p1', name: 'dev-server', host: '127.0.0.1', port: harness.port, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } },
    { knownHosts: {}, secret: harness.password, acceptHostKey: true, onHostKeyAccepted: () => {} }
  )
  if (!outcome.ok) return fail('ssh connect: ' + outcome.reason)
  const sessionId = sessions.adopt(outcome.backend, { type: 'ssh', profileId: 'p1', title: 'dev-server', serverKey: 'dev-server', cwd: undefined, shell: undefined })

  const adopted = await jsr(`(() => {
    const fileTab = [...document.querySelectorAll('.sb-tab')].find(b => /파일/.test(b.textContent))
    if (fileTab) fileTab.click()
    if (window.__evAdopt) { window.__evAdopt(${JSON.stringify(sessionId)}, 'dev-server', 'dev-server'); return true }
    return false
  })()`)
  if (!adopted) return fail('__evAdopt seam 없음')
  await wait(1000)

  const beforeCd = await jsr(`(() => document.querySelector('.fcrumb')?.getAttribute('title') || '')()`)
  console.log('FB-SYNC 접속 직후 트리 경로: ' + beforeCd)

  // SSH_OSC7_INJECT_DELAY_MS(400ms) 를 넉넉히 통과한 뒤 cd — SshBackend 의 주입이 이미 셸에 꽂혔을 시점.
  await wait(700)
  await jsr(`window.ev.session.input(${JSON.stringify(sessionId)}, 'cd /nginx\\n')`)
  await wait(1300)
  const afterCd = await jsr(`(() => ({
    path: document.querySelector('.fcrumb')?.getAttribute('title') || '',
    names: [...document.querySelectorAll('.ftree .frow .fn')].map(n => n.textContent)
  }))()`)
  const cdSynced = /nginx/.test(afterCd.path) && afterCd.names.some((n) => /nginx\.conf/.test(n))
  console.log('FB-SYNC cd → 트리 자동 이동(SshBackend OSC7 주입): ' + (cdSynced ? 'OK ' + afterCd.path : 'MISS ' + JSON.stringify(afterCd)))
  if (!cdSynced) return fail('cd 후 트리가 안 따라감 — ' + JSON.stringify(afterCd))
  writeFileSync(SHOT_CD, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT cd: ' + SHOT_CD)

  // ── ② 로컬 셸 → 상태바 CPU/MEM 게이지 ──
  await jsr(`(() => { const b = document.querySelector('.tterm-add'); if (b) b.click() })()`)
  await wait(1500) // 로컬 셸 스폰 + 첫 텔레메트리 틱.
  const gauge = await jsr(`(() => {
    const segs = [...document.querySelectorAll('.statusbar .sb-seg.gauge-seg')]
    return { count: segs.length, labels: segs.map((s) => s.querySelector('.lbl')?.textContent) }
  })()`)
  console.log('FB-SYNC 로컬 게이지: ' + JSON.stringify(gauge))
  const gaugeOk = gauge.count >= 2 && gauge.labels.includes('CPU') && gauge.labels.includes('MEM')
  if (!gaugeOk) return fail('로컬 게이지 미표시 — ' + JSON.stringify(gauge))
  writeFileSync(SHOT_GAUGE, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT gauge: ' + SHOT_GAUGE)

  console.log('FB-SYNC E2E 요약: cd동기=' + (cdSynced ? 'OK' : 'FAIL') + ' 로컬게이지=' + (gaugeOk ? 'OK' : 'FAIL'))

  harness.close().catch(() => {})
  cleanup()
  app.exit(0)
})

setTimeout(() => fail('timeout (45s)'), 45000)
