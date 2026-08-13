// W2 실기동 스크린샷 + E2E 실증 — **실제 앱 main**(out/main/index.js)을 그대로 부팅하고
// 원격 자리에만 ssh2 하네스를 세운다(실서버 접속 없음 · 루프백·temp 한정).
//
//   ① [모니터] 탭 포트 행 [↗] → `→ localhost:N` 배지          → agent_talk/W2-forward-screenshot.png
//   ② 배지 옆 [열기] → 내장 브라우저가 원격 페이지를 렌더       → agent_talk/W2-browser-screenshot.png
//   ③ 설정 [로그] 켜기 → 세션 출력이 파일로 남고 비밀은 ****     → agent_talk/W2-log-screenshot.png
//
// 포워딩 왕복은 진짜다: 브라우저 → 내 PC 127.0.0.1:N → ssh direct-tcpip → 하네스가 HTTP 로 응답한다.
const { app, BrowserWindow } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { mkdtempSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const real = require('./.w2-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
const USER_DATA = mkdtempSync(join(tmpdir(), 'ev-w2-shot-'))
app.setPath('userData', USER_DATA)

// ★ 실제 앱 배선(IPC·창·보안 옵션·세션 로그·포워딩)
require('../out/main/index.js')

const SHOT_FWD = join(__dirname, '..', 'agent_talk', 'W2-forward-screenshot.png')
const SHOT_BRW = join(__dirname, '..', 'agent_talk', 'W2-browser-screenshot.png')
const SHOT_LOG = join(__dirname, '..', 'agent_talk', 'W2-log-screenshot.png')

const checks = []
const check = (name, pass) => checks.push([name, pass])
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// 창을 앞으로 세우고 한 프레임 그린 뒤 캡처한다 — 가려진/미표시 창은 capturePage 가 빈 이미지를 준다.
async function shoot(win, path, label) {
  win.show()
  win.focus()
  await wait(500)
  const img = await win.webContents.capturePage()
  writeFileSync(path, img.toPNG())
  check(label + ' 스크린샷 저장', existsSync(path) && statSync(path).size > 1000)
}

async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await fn()
    if (v) return v
    await wait(100)
  }
  return null
}

// 원격이 리슨 중이라고 보고할 포트 목록(ss -tlnp 형식 그대로).
const REMOTE_PORT = 3000
const SS_OUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=812,fd=3))
LISTEN 0      511        127.0.0.1:${REMOTE_PORT}       0.0.0.0:*     users:(("vite",pid=2451,fd=18))
LISTEN 0      511        127.0.0.1:8765       0.0.0.0:*     users:(("claude",pid=3120,fd=7))
LISTEN 0      128          0.0.0.0:5432       0.0.0.0:*     users:(("postgres",pid=1044,fd=6))
`
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
    '__ARA_GPU__\n\n'
  )
}

// 포워딩된 소켓이 도착하면 HTTP 로 답한다 — 내장 브라우저에 실제 페이지가 뜬다.
const PAGE = Buffer.from(
  '<!doctype html><meta charset="utf-8"><title>원격 미리보기</title>' +
    '<body style="font:16px system-ui;background:#0d1119;color:#cdd6e4;padding:48px">' +
    '<h1 style="color:#7dd3fc">원격 개발 서버 미리보기</h1>' +
    `<p>이 페이지는 원격 127.0.0.1:${REMOTE_PORT} 이 SSH 터널로 내 PC 에 도착한 것입니다.</p>` +
    '<p>✔ 한글 렌더 정상 · 배포_20260804.log</p></body>',
  'utf8'
)
function serveHttp(channel) {
  channel.on('data', () => {
    channel.write(
      `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${PAGE.length}\r\nConnection: close\r\n\r\n`
    )
    channel.write(PAGE)
    channel.end()
  })
}

app.whenReady().then(async () => {
  const harness = await real.startPasswordServer({
    execHandler: (_cmd, stream) => {
      stream.write(collectOut())
      stream.exit(0)
      stream.end()
    },
    tcpipHandler: (_info, channel) => serveHttp(channel)
  })

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0] ?? null)
  if (!win) return finish('메인 창이 뜨지 않음')
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r))
  await wait(600)

  const js = (code) => win.webContents.executeJavaScript(code)

  // ── SSH 접속(실 프로필 → 실 connectSsh). 최초 접속이라 호스트키 확인 다이얼로그가 뜬다. ──
  await js(`(async () => {
    const { profile } = await window.ev.profile.save({
      name: '개발서버', host: '127.0.0.1', port: ${harness.port}, username: 'deploy',
      authType: 'password', secret: ${JSON.stringify(harness.password)}, group: '개발'
    })
    window.__w2Profile = profile.id
    window.__w2Connect = window.__evConnect(profile.id)
  })()`)
  await wait(700)
  // "신뢰하고 연결" — 실 TOFU 경로를 그대로 통과한다.
  await js(`document.querySelector('.dlg-overlay .modal .btn.pri')?.click()`)
  const connected = await waitFor(async () => await js(`document.querySelectorAll('.term-tabbar .ttab').length > 0`))
  check('실 SSH 접속(하네스) → 탭 생성', connected === true)

  // ── ① [모니터] 탭 → 포트 행 [↗] → 배지 ──
  await js(`[...document.querySelectorAll('.sb-tab')].find(b => /모니터/.test(b.textContent))?.click()`)
  const gotPorts = await waitFor(async () => await js(`document.querySelectorAll('.pmon-list .prow').length >= 3`))
  check('[모니터] 탭에 원격 리슨 포트 표시', gotPorts === true)

  await js(`(() => {
    const row = [...document.querySelectorAll('.pmon-list .prow')].find(r => r.querySelector('.pport')?.textContent === '${REMOTE_PORT}')
    row?.querySelector('[data-action="forward.create"]')?.click()
  })()`)
  // 배지는 data-local-port 로 실제 터널 입구를 들고 있다(라벨은 좁은 사이드바에 맞춘 축약형이다).
  const badge = await waitFor(async () =>
    js(`document.querySelector('.pmon-list .prow .pfwd')?.dataset.localPort || ''`)
  )
  check('[↗] → 포워딩 배지 표시', badge === String(REMOTE_PORT))
  const fwdList = await js(`window.ev.forward.list()`)
  check('forward:list 에 1건', Array.isArray(fwdList) && fwdList.length === 1)
  check(
    '요청한 포트 그대로 열렸다(exact)',
    !!fwdList[0] && fwdList[0].exact === true && fwdList[0].localPort === fwdList[0].remotePort
  )
  await shoot(win, SHOT_FWD, '[모니터] 포워딩')

  // 같은 행을 다시 눌러도 리스너는 하나(멱등).
  await js(`(() => {
    const row = [...document.querySelectorAll('.pmon-list .prow')].find(r => r.querySelector('.pport')?.textContent === '${REMOTE_PORT}')
    row?.querySelector('[data-action="forward.create"]')?.click()
  })()`)
  await wait(400)
  const again = await js(`window.ev.forward.list()`)
  check('두 번 눌러도 포워딩 1건(멱등)', again.length === 1)

  // ── ② [열기] → 내장 브라우저가 터널 너머 페이지를 렌더 ──
  const before = BrowserWindow.getAllWindows().length
  await js(`document.querySelector('.pmon-list .prow [data-action="forward.open"]')?.click()`)
  const bw = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w !== win) ?? null)
  check('[열기] → 브라우저 창 1개 추가', bw !== null && BrowserWindow.getAllWindows().length === before + 1)
  if (bw) {
    if (bw.webContents.isLoading()) await new Promise((r) => bw.webContents.once('did-finish-load', r))
    await wait(400)
    const body = await bw.webContents.executeJavaScript(`document.body.innerText`).catch(() => '')
    check('터널 왕복으로 원격 페이지가 렌더됨(한글)', body.includes('원격 개발 서버 미리보기'))
    check('브라우저 창 제목에 오리진', bw.getTitle().includes('localhost:'))
    check('브라우저 창에 window.ev 없음', (await bw.webContents.executeJavaScript(`typeof window.ev`)) === 'undefined')
    await shoot(bw, SHOT_BRW, '내장 브라우저')
    bw.close()
    await wait(300)
  }

  // ── ③ 설정 [로그] — 기본 off 확인 → 켜고 출력 → 파일·마스킹 확인 ──
  const logDir = join(USER_DATA, 'logs')
  const listLogs = () => (existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.log')) : [])
  check('기본 off — 로그 파일이 없다', listLogs().length === 0)

  await js(`document.querySelector('.titlebar .tb-gear')?.click()`)
  await wait(350)
  await js(`document.querySelector('.drawer.open .set-nav span[data-section="log"]')?.click()`)
  await wait(250)
  const logUi = await js(`({
    nav: [...document.querySelectorAll('.drawer.open .set-nav span')].map(s => s.dataset.section),
    toggle: !!document.querySelector('.drawer.open .set-toggle'),
    retention: [...document.querySelectorAll('.drawer.open .seg-ctl button')].map(b => b.textContent),
    reveal: !!document.querySelector('.drawer.open [data-action="log.reveal"]')
  })`)
  check('설정 nav 에 [로그] 섹션', logUi.nav.includes('log'))
  check('보존 기간 세그먼트 4종', logUi.retention.join(',') === '7일,30일,90일,무제한')
  check('[폴더 열기] 버튼', logUi.reveal === true)
  check('기록 토글 기본 꺼짐', (await js(`document.querySelector('.drawer.open .set-toggle')?.getAttribute('aria-checked')`)) === 'false')

  // 토글 ON → 원격에 비밀이 섞인 명령을 입력(하네스 셸이 에코 = 세션 출력).
  await js(`document.querySelector('.drawer.open .set-toggle')?.click()`)
  await wait(300)
  await shoot(win, SHOT_LOG, '설정 [로그]')
  await js(`document.querySelector('.drawer.open .drawer-hd .x')?.click()`)
  await wait(250)

  // 하네스 셸은 받은 바이트를 그대로 되돌린다(실 pty 의 ONLCR 변환이 없다). 실 셸이 내보내는
  // 줄바꿈 형태(CRLF)로 넣어야 세션 출력이 실제와 같아진다 — 단독 CR 은 진행률 덮어쓰기라
  // 로거가 마지막 상태만 남기고 앞을 지우는 것이 정상 동작이다(tests/sessionlog.test.ts 가 그쪽을 덮는다).
  await js(`(async () => {
    const [s] = await window.ev.session.list()
    if (!s) return
    window.ev.session.input(s.id, 'export TOKEN=ghp_SUPERSECRET1234\\r\\n')
    window.ev.session.input(s.id, 'mysql -uroot -pS3cr3t! 배포DB\\r\\n')
    window.ev.session.input(s.id, 'echo 배포가 완료되었습니다\\r\\n')
  })()`)
  const wrote = await waitFor(() => listLogs().length > 0, 6000)
  check('로그 켜면 파일 생성', wrote === true)
  if (wrote) {
    await wait(800)
    const file = join(logDir, listLogs()[0])
    const body = readFileSync(file, 'utf8')
    check('한글 출력이 그대로 남는다', body.includes('배포가 완료되었습니다'))
    check('TOKEN 값이 평문으로 없다', !body.includes('ghp_SUPERSECRET1234'))
    check('mysql -p 비밀이 평문으로 없다', !body.includes('S3cr3t'))
    check('마스킹 표시(****)가 있다', body.includes('****'))
    console.log('--- 로그 파일: ' + file + ' ---')
    console.log(body.split('\n').slice(0, 20).join('\n'))
    console.log('--- 끝 ---')
  }

  // ── 세션 종료 시 포워딩 정리 ──
  await js(`(async () => {
    const s = await window.ev.session.list()
    for (const x of s) await window.ev.session.destroy(x.id)
  })()`)
  const cleared = await waitFor(async () => (await js(`window.ev.forward.list()`)).length === 0, 5000)
  check('세션 종료 → 포워딩 목록 비워짐', cleared === true)

  await harness.close()
  finish(null)
})

function finish(fatal) {
  let ok = !fatal
  if (fatal) console.error('W2-SHOT FAIL: ' + fatal)
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name)
    if (!pass) ok = false
  }
  for (const p of [SHOT_FWD, SHOT_BRW, SHOT_LOG]) {
    console.log((existsSync(p) ? 'SCREENSHOT ' : 'MISSING ') + p)
  }
  app.exit(ok ? 0 : 1)
}

const TIMEOUT_MS = 120000
setTimeout(() => finish(`timeout (${TIMEOUT_MS / 1000}s)`), TIMEOUT_MS)
