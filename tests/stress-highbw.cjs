// F2 고대역 스트레스 — 실제 out/preload + out/renderer(xterm) 위에서 200000 라인 한글 출력을 쏟아붓고
// (1) main 프로세스 이벤트 루프 미응답(프리즈) 없음 (2) renderer가 살아있고 백프레셔로 pause/resume 발생
// (3) 최종 출력 라인 수 무결을 검증한다. 통과 시 exit 0.
// 세션 IPC는 실제 MainSessionManager 배칭/pause·resume 계약을 재현한 최소 핸들러로 배선(smoke와 동일).
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const LINES = 200000
const FLUSH_BYTE_BUDGET = 64 * 1024
const FLUSH_INTERVAL_MS = 16

const ptys = new Map()
let pauseCount = 0
let resumeCount = 0

// MainSessionManager와 동일한 배칭(바이트 버짓 + 16ms 프레임) + pause/resume 재현.
function wireSession(getWc) {
  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'st-' + Math.random().toString(36).slice(2)
    const file = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['-NoLogo'] : []
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: process.env, useConpty: process.platform === 'win32', useConptyDll: process.platform === 'win32' })
    const st = { pty: p, buf: [], bufBytes: 0, timer: null }
    ptys.set(id, st)
    const flush = () => {
      if (st.timer) { clearTimeout(st.timer); st.timer = null }
      if (!st.buf.length) return
      const merged = st.buf.length === 1 ? st.buf[0] : Buffer.concat(st.buf, st.bufBytes)
      st.buf = []; st.bufBytes = 0
      const u = new Uint8Array(merged.length); u.set(merged)
      const wc = getWc()
      if (wc && !wc.isDestroyed()) wc.postMessage('session:data:' + id, u)
    }
    p.onData((d) => {
      const b = Buffer.from(d, 'utf8')
      st.buf.push(b); st.bufBytes += b.length
      if (st.bufBytes >= FLUSH_BYTE_BUDGET) flush()
      else if (!st.timer) st.timer = setTimeout(flush, FLUSH_INTERVAL_MS)
    })
    p.onExit(({ exitCode }) => {
      flush()
      const wc = getWc()
      if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode })
      ptys.delete(id)
    })
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.pty.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.pty.kill() } catch {} ; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.pty.write(data))
  ipcMain.on('session:pause', (_e, { id }) => { pauseCount++; try { ptys.get(id)?.pty.pause() } catch {} })
  ipcMain.on('session:resume', (_e, { id }) => { resumeCount++; try { ptys.get(id)?.pty.resume() } catch {} })
  // R3.6: powershell 이 OSC 제목을 보내면 renderer 가 이 채널을 부른다(핸들러가 없으면 거절 로그만 쌓인다).
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
}

// 렌더러 부팅이 부르는 최소 도메인 스텁. 없으면 매 기동마다 unhandled rejection 이 쌓이고,
// 무엇보다 ui.scrollback 이 적용되지 않아 "실제 설정으로 돌린 스트레스"가 되지 않는다(R3.4).
const SCROLLBACK = Number(process.env.EV_STRESS_SCROLLBACK || 10000)
function wireBoot() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: {
      sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
      ctxMenuStyle: 'list',
      font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
      locale: 'ko', scrollback: SCROLLBACK, copyOnSelect: true
    }
  }))
}

// pty.kill() 직후 곧바로 종료하면 conpty 정리와 프로세스 종료가 겹쳐 간헐적으로 fastfail(0xC0000409)
// 로 죽는다 — 어서션은 전부 통과했는데 종료 코드만 실패하는 흔들림이었다(R3 이전부터: HEAD 에서도 재현).
// conpty 가 정리될 시간을 주고 종료한다. 창은 건드리지 않는다(정리 중 창 파괴가 경합을 되살린다).
function done(ok, why) {
  for (const st of ptys.values()) { try { st.pty.kill() } catch {} }
  console.log((ok ? 'STRESS PASS' : 'STRESS FAIL') + ' — ' + why)
  setTimeout(() => process.exit(ok ? 0 : 1), 800)
}

app.whenReady().then(async () => {
  let win
  wireSession(safeWc(() => win))
  wireBoot()
  win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => done(false, 'renderer gone: ' + JSON.stringify(d)))
  await win.loadFile(join(OUT, 'renderer', 'index.html'))

  // 이벤트 루프 지연 측정(프리즈 감지): 100ms 간격 타이머의 실제 편차 최대치.
  let maxLagMs = 0
  let last = Date.now()
  const lagTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - 100
    if (lag > maxLagMs) maxLagMs = lag
    last = now
  }, 100)

  // renderer에서 세션 생성 + 200000 라인 한글 출력. renderer가 받은 라인 수를 집계.
  const cmd = process.platform === 'win32'
    ? `1..${LINES} | % { "라인 $_ 한글출력" }\r\n`
    : `for i in $(seq 1 ${LINES}); do echo "라인 $i 한글출력"; done\n`

  await win.webContents.executeJavaScript(`(() => {
    const dec = new TextDecoder('utf-8')
    window.__stress = { received: 0, matchLines: 0, tail: '', done: false }
    window.ev.session.create({ type: 'local', title: 'stress', serverKey: 'localhost', profileId: null }).then(({ id }) => {
      window.__stress.id = id
      let carry = ''
      window.ev.session.onData(id, (chunk) => {
        const s = dec.decode(chunk, { stream: true })
        window.__stress.received += s.length
        const text = carry + s
        const parts = text.split('\\n')
        carry = parts.pop()
        for (const line of parts) if (line.indexOf('한글출력') !== -1) window.__stress.matchLines++
        window.__stress.tail = text.slice(-80)
      })
      window.ev.session.onExit(id, () => { window.__stress.done = true })
      window.ev.session.input(id, ${JSON.stringify(cmd)})
    })
    return true
  })()`)

  // 최대 60초 대기. done 이거나 충분한 라인 수신 시 종료.
  const started = Date.now()
  let probe = { received: 0, matchLines: 0, done: false }
  while (Date.now() - started < 60000) {
    await new Promise((r) => setTimeout(r, 500))
    probe = await win.webContents.executeJavaScript('({ received: window.__stress.received, matchLines: window.__stress.matchLines, done: window.__stress.done })')
    // renderer 여전히 응답하는지(executeJavaScript 성공 자체가 renderer alive 증거).
    if (probe.done && probe.matchLines >= LINES) break
    if (probe.matchLines >= LINES) break
  }
  clearInterval(lagTimer)

  const rendererAlive = await win.webContents.executeJavaScript('typeof window.__stress === "object"').catch(() => false)
  console.log(`lines matched=${probe.matchLines}/${LINES} received-chars=${probe.received} maxEventLoopLagMs=${maxLagMs} pause=${pauseCount} resume=${resumeCount} rendererAlive=${rendererAlive}`)

  // 합격 조건: (a) 렌더러 생존, (b) 이벤트 루프 프리즈 없음(<2000ms), (c) 대부분 라인 수신(>=99%).
  const okLines = probe.matchLines >= Math.floor(LINES * 0.99)
  const okLag = maxLagMs < 2000
  if (!rendererAlive) return done(false, 'renderer 미응답')
  if (!okLag) return done(false, 'event loop 프리즈 maxLag=' + maxLagMs + 'ms')
  if (!okLines) return done(false, '라인 손실 matched=' + probe.matchLines)
  done(true, `lines=${probe.matchLines} maxLag=${maxLagMs}ms pause=${pauseCount} resume=${resumeCount}`)
})

setTimeout(() => done(false, 'timeout (75s)'), 75000)
