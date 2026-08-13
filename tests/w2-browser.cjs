// W2 F8 내장 브라우저 보안 불변식 스모크 — **실제 앱 main**(out/main/index.js)을 그대로 부팅해
// 렌더러가 window.ev.browser.open 을 부른 뒤 생긴 창을 검사한다. 스텁을 다시 만들지 않는 이유:
// 여기서 증명하려는 것이 "실제 배선이 안전한가"이지 "테스트용 창이 안전한가"가 아니기 때문이다.
//
// 어서션(설계 §9 보안 체크리스트 · 브라우저 창):
//   ① preload 미주입 → 브라우저 webContents 에 window.ev 부재
//   ② sandbox / contextIsolation / nodeIntegration / nodeIntegrationInSubFrames / webviewTag /
//      webSecurity / allowRunningInsecureContent / experimentalFeatures
//   ③ 전용 파티션(앱 default 세션과 다른 Session 객체)
//   ④ file:// 진입 거부(ok:false + 창 안 생김) · 페이지 안에서의 file:// 이동도 차단
//   ⑤ 창 재사용(두 번째 open 이 새 창을 만들지 않는다)
//   ⑥ 창 제목이 현재 오리진(페이지가 정한 제목이 아니라)
//   ⑦ 권한 요청 거부 · 다운로드 차단 핸들러 등록
//   ⑧ certificate-error 핸들러 미등록(기본 거부)
//
// 원격은 없다: 127.0.0.1 임시 http 서버 한 대만 띄운다(DLP — 루프백·temp 한정).
const { app, BrowserWindow, session } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { createServer } = require('node:http')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
// 실 앱 main 이 whenReady 에서 userData 를 읽으므로 require 전에 임시 경로로 돌려 둔다
// (개발자 실제 workspace.json·vault 를 건드리지 않는다).
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ev-w2-userdata-')))

// ★ 실제 앱 배선(IPC·창 생성·보안 옵션) — 이 한 줄이 검사 대상이다.
require('../out/main/index.js')

const SHOT = join(__dirname, '..', 'agent_talk', 'W2-browser-invariants.png')
const checks = []
const check = (name, pass) => checks.push([name, pass])

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = await fn()
    if (v) return v
    await wait(80)
  }
  return null
}

// 루프백 전용 테스트 페이지. /dl 은 다운로드 차단 확인용(첨부 헤더).
function startPage() {
  const server = createServer((req, res) => {
    if (req.url === '/dl') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' })
      res.end('data')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<title>원격이 정한 제목 — 위장 시도</title><h1>미리보기 페이지 · 한글</h1>')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

app.whenReady().then(async () => {
  const { server, port } = await startPage()
  const origin = `http://127.0.0.1:${port}`

  const main = await waitFor(() => BrowserWindow.getAllWindows()[0] ?? null)
  if (!main) return finish('메인 창이 뜨지 않음')
  if (main.webContents.isLoading()) await new Promise((r) => main.webContents.once('did-finish-load', r))

  // ── file:// 은 창조차 만들지 않는다(진입점 스킴 게이트) ──
  const before = BrowserWindow.getAllWindows().length
  const denied = await main.webContents.executeJavaScript(
    `window.ev.browser.open('file:///C:/Windows/win.ini')`
  )
  check('file:// browser:open → ok:false', denied && denied.ok === false)
  check('file:// 요청으로 창이 생기지 않음', BrowserWindow.getAllWindows().length === before)

  // ── 정상 진입 ──
  const opened = await main.webContents.executeJavaScript(`window.ev.browser.open('${origin}/')`)
  check('http browser:open → ok:true', opened && opened.ok === true)
  const bw = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w !== main) ?? null)
  if (!bw) return finish('브라우저 창이 열리지 않음')
  if (bw.webContents.isLoading()) await new Promise((r) => bw.webContents.once('did-finish-load', r))

  // ── ② webPreferences 불변식 ──
  const wp = bw.webContents.getLastWebPreferences() || {}
  check('preload 미주입', wp.preload === undefined || wp.preload === null || wp.preload === '')
  check('sandbox: true', wp.sandbox === true)
  check('contextIsolation: true', wp.contextIsolation === true)
  check('nodeIntegration: false', wp.nodeIntegration !== true)
  check('nodeIntegrationInSubFrames: false', wp.nodeIntegrationInSubFrames !== true)
  check('webviewTag: false', wp.webviewTag !== true)
  check('webSecurity: true', wp.webSecurity !== false)
  check('allowRunningInsecureContent: false', wp.allowRunningInsecureContent !== true)
  check('experimentalFeatures: false', wp.experimentalFeatures !== true)

  // ── ③ 전용 파티션 ──
  const appSession = main.webContents.session
  const braSession = session.fromPartition('persist:ara-browser')
  check('전용 파티션 persist:ara-browser 사용', bw.webContents.session === braSession)
  check('앱 default 세션과 분리', bw.webContents.session !== appSession)

  // ── ① window.ev 부재 + node 부재 ──
  const inPage = await bw.webContents
    .executeJavaScript(
      `(async () => ({
        ev: typeof window.ev,
        require: typeof window.require,
        process: typeof window.process,
        title: document.title,
        geo: await navigator.permissions.query({ name: 'geolocation' }).then(p => p.state).catch(() => 'error')
      }))()`
    )
    .catch((e) => ({ error: String(e) }))
  if (inPage.error) check('브라우저 창 평가 성공', false)
  check('브라우저 창에 window.ev 없음', inPage.ev === 'undefined')
  check('브라우저 창에 window.require 없음', inPage.require === 'undefined')
  check('브라우저 창에 process 없음', inPage.process === 'undefined')
  // ── ⑦ 권한 거부 ──
  check('권한 조회가 denied(권한 핸들러 전부 거부)', inPage.geo === 'denied')
  check('will-download 차단 핸들러 등록', braSession.listenerCount('will-download') > 0)

  // ── ⑥ 창 제목 = 현재 오리진(페이지가 정한 제목이 아니다) ──
  check('창 제목에 오리진 표시', bw.getTitle().includes(origin))
  check('페이지가 정한 제목으로 위장 불가', !bw.getTitle().includes('위장 시도'))

  // ── ④ 페이지 안에서의 file:// 이동 차단 ──
  const navBefore = bw.webContents.getURL()
  await bw.webContents.executeJavaScript(`location.href = 'file:///C:/Windows/win.ini'`).catch(() => {})
  await wait(600)
  check('페이지 내 file:// 이동 차단(URL 유지)', bw.webContents.getURL() === navBefore)

  // ── ⑤ 창 재사용 ──
  const countBefore = BrowserWindow.getAllWindows().length
  await main.webContents.executeJavaScript(`window.ev.browser.open('${origin}/?second')`)
  await wait(600)
  check('두 번째 open 은 같은 창을 재사용', BrowserWindow.getAllWindows().length === countBefore)
  check('재사용 창이 새 URL 로 이동', bw.webContents.getURL().includes('second'))

  // ── ⑧ certificate-error 를 가로채는 코드가 우리 쪽에 없다(Electron 기본 = 거부) ──
  // app 레벨 listenerCount 는 Electron 이 webContents 로 넘겨 주는 내부 포워더 1개가 기본이라 세지 않는다.
  // 대신 ㉠ 창 webContents 에 우리 핸들러가 없고 ㉡ 번들 소스에 가로채기·무시 스위치가 없음을 본다.
  const mainBundle = require('node:fs').readFileSync(join(__dirname, '..', 'out', 'main', 'index.js'), 'utf8')
  check('브라우저 창 certificate-error 핸들러 미등록', bw.webContents.listenerCount('certificate-error') === 0)
  check('소스에 certificate-error 가로채기 없음', !mainBundle.includes('certificate-error'))
  check('소스에 ignore-certificate-errors 스위치 없음', !mainBundle.includes('ignore-certificate-errors'))
  check('실행 중 스위치에도 없음', !app.commandLine.hasSwitch('ignore-certificate-errors'))

  await bw.webContents.capturePage().then((img) => require('node:fs').writeFileSync(SHOT, img.toPNG()))
  console.log('screenshot: ' + SHOT)

  await new Promise((r) => server.close(r))
  finish(null)
})

function finish(fatal) {
  let ok = !fatal
  if (fatal) console.error('W2-BROWSER FAIL: ' + fatal)
  for (const [name, pass] of checks) {
    console.log((pass ? 'PASS ' : 'FAIL ') + name)
    if (!pass) ok = false
  }
  app.exit(ok ? 0 : 1)
}

const TIMEOUT_MS = 60000
setTimeout(() => finish(`timeout (${TIMEOUT_MS / 1000}s)`), TIMEOUT_MS)
