// W1 트랙 B 실기동 스크린샷 + E2E 실증 — 실제 out/preload + out/renderer 창을 REAL 텔레메트리·LogTail 로 구동:
//  ① [모니터] 탭 포트 목록 + 상태바 CPU/MEM/GPU 게이지 → agent_talk/W1B-screenshot.png
//  ② [파일] 탭 우클릭 [tail로 보기] → 로그 뷰어 → agent_talk/W1B-logtail-screenshot.png
// 원격은 ssh2 하네스(실서버 접속 없음). exec 채널이 ss//proc/nvidia-smi 출력과 tail 스트림을 흉내 낸다.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const real = require('./.w1b-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT_MON = join(__dirname, '..', 'agent_talk', 'W1B-screenshot.png')
const SHOT_LOG = join(__dirname, '..', 'agent_talk', 'W1B-logtail-screenshot.png')

// ── 원격 파일시스템(트리에 보일 로그 파일) ──
const remoteRoot = mkdtempSync(join(tmpdir(), 'ev-w1b-remote-'))
mkdirSync(join(remoteRoot, '배포스크립트'))
writeFileSync(join(remoteRoot, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
writeFileSync(join(remoteRoot, 'access_20260803.log'), '요청 로그\n')
writeFileSync(join(remoteRoot, 'README_한글.md'), '# 한글 문서\n')

// ── 원격 명령 응답(실 서버 출력 형식 그대로) ──
const SS_OUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=812,fd=3))
LISTEN 0      511        127.0.0.1:8080       0.0.0.0:*     users:(("node",pid=2451,fd=18))
LISTEN 0      128          0.0.0.0:5432       0.0.0.0:*     users:(("postgres",pid=1044,fd=6))
LISTEN 0      511          0.0.0.0:443        0.0.0.0:*     users:(("nginx",pid=1180,fd=8))
LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=812,fd=4))
LISTEN 0      70         127.0.0.1:33060      0.0.0.0:*
`
// 바퀴마다 /proc/stat 누적치를 늘려 사용률이 실제로 계산되게 한다(첫 바퀴는 기준점이라 0%).
// 바퀴당 증분 user 250 + system 250 + idle 900 + iowait 50 = 34% 부하인 서버.
const cpu = { user: 120000, system: 60000, idle: 900000, iowait: 20000 }
const collectOut = () => {
  cpu.user += 250
  cpu.system += 250
  cpu.idle += 900
  cpu.iowait += 50
  return (
    SS_OUT +
    '__ARA_STAT__\n' +
    `cpu  ${cpu.user} 0 ${cpu.system} ${cpu.idle} ${cpu.iowait} 0 0 0 0 0\n` +
    'MemTotal:       32869180 kB\nMemFree:         2100340 kB\nMemAvailable:   20481024 kB\n' +
    '__ARA_GPU__\n61\n'
  )
}

const LOG_LINES = [
  '2026-08-03 14:02:11 INFO  배포 스크립트 시작 (릴리스 v2.4.1)',
  '2026-08-03 14:02:12 INFO  데이터베이스 마이그레이션 3건 적용',
  '2026-08-03 14:02:14 WARN  로그 디렉터리 용량 78% — 오래된 로그 정리 권장',
  '2026-08-03 14:02:15 INFO  워커 4개 기동 · 헬스체크 통과',
  '2026-08-03 14:02:17 INFO  요청 처리량 1,204 req/s · 오류 0건',
  '2026-08-03 14:02:19 ERROR 결제 승인 재시도 1/3 (upstream 타임아웃)',
  '2026-08-03 14:02:21 INFO  결제 승인 성공 · 큐 적체 해소'
]

let win
const getWc = safeWc(() => win)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const jsr = (code) => win.webContents.executeJavaScript(code)

function cleanup() {
  try { rmSync(remoteRoot, { recursive: true, force: true }) } catch {}
}
const fail = (m) => { console.error('W1B SHOT FAIL: ' + m); cleanup(); app.exit(1) }

function wireStubs() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', () => ({ profile: {} }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
}

// 우클릭 메뉴에서 라벨로 항목 고르기(실 메뉴 경로 — 코드로 액션을 직접 부르지 않는다).
const pickMenu = (label) => jsr(`(() => {
  const it = [...document.querySelectorAll('.ctx-menu .ci-lbl')].find(e => e.textContent.includes(${JSON.stringify(label)}))
  if (!it) return false
  it.closest('[role=menuitem], .ctx-item, div').click()
  return true
})()`)

app.whenReady().then(async () => {
  const sessions = real.registerSessionIpc(getWc)
  real.registerSftpIpc(sessions, getWc)
  real.registerTelemetryIpc(sessions, getWc)
  wireStubs()

  let tailTimer = null
  const harness = await real.startPasswordServer({
    sftpRoot: remoteRoot,
    emitOsc7OnCd: true,
    execHandler: (command, stream) => {
      if (command.startsWith('tail ')) {
        let i = 0
        stream.write(LOG_LINES.slice(0, 4).join('\r\n') + '\r\n')
        i = 4
        tailTimer = setInterval(() => {
          if (i >= LOG_LINES.length) return
          stream.write(LOG_LINES[i++] + '\r\n')
        }, 200)
        stream.on('finish', () => tailTimer && clearInterval(tailTimer))
        return
      }
      stream.write(collectOut())
      stream.exit(0)
      stream.end()
    }
  })

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('renderer gone: ' + JSON.stringify(d)))
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(600)

  // 실접속(shell 채널) → 세션 편입. 텔레메트리·tail 은 이 커넥션의 exec 채널을 쓴다.
  const outcome = await real.connectSsh(
    { id: 'p1', name: 'dev-server', host: '127.0.0.1', port: harness.port, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } },
    { knownHosts: {}, secret: harness.password, acceptHostKey: true, onHostKeyAccepted: () => {} }
  )
  if (!outcome.ok) return fail('ssh connect: ' + outcome.reason)
  const sessionId = sessions.adopt(outcome.backend, { type: 'ssh', profileId: 'p1', title: 'dev-server', serverKey: 'dev-server', cwd: undefined, shell: undefined })

  const adopted = await jsr(`(() => {
    if (!window.__evAdopt) return false
    window.__evAdopt(${JSON.stringify(sessionId)}, 'dev-server', 'dev-server')
    return true
  })()`)
  if (!adopted) return fail('__evAdopt seam 없음')
  await wait(900)

  // ── ① [모니터] 탭 — 포트 목록 + 상태바 게이지 ──
  const tabbed = await jsr(`(() => {
    const tab = [...document.querySelectorAll('.sb-tab')].find(b => /모니터/.test(b.textContent))
    if (!tab) return false
    tab.click()
    return true
  })()`)
  if (!tabbed) return fail('[모니터] 탭 없음')
  // 두 바퀴 이상 돌아야 CPU 사용률이 0 이 아닌 실값이 된다(폴링 2.5초).
  await wait(3200)

  const mon = await jsr(`(() => {
    const rows = [...document.querySelectorAll('.pmon-list .prow')].map(r => ({
      port: r.querySelector('.pport')?.textContent,
      proto: r.querySelector('.pproto')?.textContent,
      proc: r.querySelector('.pproc')?.textContent,
      pid: r.querySelector('.ppid')?.textContent
    }))
    const gauges = [...document.querySelectorAll('.statusbar .gauge-seg')].map(s => ({
      label: s.querySelector('.lbl')?.textContent,
      val: s.querySelector('.val')?.textContent,
      width: s.querySelector('.bar i')?.style.width
    }))
    return { rows, gauges }
  })()`)
  console.log('W1B 포트 행:', JSON.stringify(mon.rows))
  console.log('W1B 게이지:', JSON.stringify(mon.gauges))
  const portsOk = mon.rows.length === 6 && mon.rows.some((r) => r.port === '8080' && r.proc === 'node' && r.pid === '2451')
  const gaugeKeys = mon.gauges.map((g) => g.label).join(',')
  const cpuLive = mon.gauges[0] && mon.gauges[0].val !== '0%'
  const gaugesOk = gaugeKeys === 'CPU,MEM,GPU' && cpuLive
  if (!portsOk) return fail('포트 목록 미렌더: ' + JSON.stringify(mon.rows))
  writeFileSync(SHOT_MON, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT monitor: ' + SHOT_MON)

  // 수동 새로고침 버튼(폴링을 기다리지 않고 즉시 한 바퀴).
  const refreshed = await jsr(`(() => { const b = document.querySelector('.pmon .sb-act'); if (!b) return false; b.click(); return true })()`)
  await wait(600)
  const stillThere = await jsr(`document.querySelectorAll('.pmon-list .prow').length`)
  console.log('W1B 새로고침: ' + (refreshed && stillThere === 6 ? 'OK' : 'FAIL ' + stillThere))

  // ── ② [파일] 탭 → 로그 파일 우클릭 → [tail로 보기] ──
  await jsr(`(() => { const t = [...document.querySelectorAll('.sb-tab')].find(b => /파일/.test(b.textContent)); if (t) t.click() })()`)
  await wait(1200)
  const rowFound = await jsr(`(() => {
    const row = [...document.querySelectorAll('.ftree .frow')].find(r => /access_/.test(r.querySelector('.fn')?.textContent || ''))
    if (!row) return false
    const b = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 8 }))
    return true
  })()`)
  if (!rowFound) return fail('로그 파일 행 없음')
  await wait(350)
  const picked = await pickMenu('tail로 보기')
  if (!picked) return fail('[tail로 보기] 메뉴 항목 없음')
  await wait(1400)

  const lv = await jsr(`(() => {
    const el = document.querySelector('.logview')
    if (!el) return null
    return {
      path: el.querySelector('.lv-path')?.textContent,
      live: el.querySelector('.lv-live')?.textContent,
      lines: (el.querySelector('.lv-body')?.textContent || '').split('\\n').filter(Boolean).length,
      korean: /배포 스크립트 시작/.test(el.querySelector('.lv-body')?.textContent || '')
    }
  })()`)
  console.log('W1B 로그 뷰어:', JSON.stringify(lv))
  if (!lv || !lv.korean) return fail('로그 뷰어 미렌더/한글 깨짐: ' + JSON.stringify(lv))
  writeFileSync(SHOT_LOG, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT logtail: ' + SHOT_LOG)

  // 일시정지 → 라벨이 바뀌는지(스트림은 계속 받되 화면만 멈춘다).
  const paused = await jsr(`(() => {
    const btn = [...document.querySelectorAll('.lv-head .ts-btn')].find(b => /일시정지/.test(b.textContent))
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await wait(300)
  const pausedState = await jsr(`(() => ({ live: document.querySelector('.lv-live')?.textContent, dot: !!document.querySelector('.lv-dot.paused') }))()`)
  console.log('W1B 일시정지: ' + (paused && pausedState.dot ? 'OK ' + pausedState.live : 'FAIL ' + JSON.stringify(pausedState)))

  // 닫기 → 뷰어가 사라지고 tail 스트림도 정리된다.
  await jsr(`(() => { const b = [...document.querySelectorAll('.lv-head .ts-btn')].pop(); if (b) b.click() })()`)
  await wait(500)
  const closedUi = await jsr(`!document.querySelector('.logview')`)
  console.log('W1B 뷰어 닫기: ' + (closedUi ? 'OK' : 'FAIL'))

  const allOk = portsOk && gaugesOk && lv.korean && pausedState.dot && closedUi
  console.log(
    'W1B E2E 요약: 포트목록=' + (portsOk ? 'OK' : 'FAIL') +
    ' 게이지=' + (gaugesOk ? 'OK' : 'FAIL(' + gaugeKeys + ')') +
    ' 로그뷰어=' + (lv.korean ? 'OK' : 'FAIL') +
    ' 일시정지=' + (pausedState.dot ? 'OK' : 'FAIL') +
    ' 닫기=' + (closedUi ? 'OK' : 'FAIL')
  )

  if (tailTimer) clearInterval(tailTimer)
  harness.close().catch(() => {})
  cleanup()
  app.exit(allOk ? 0 : 1)
})

setTimeout(() => fail('timeout (60s)'), 60000)
