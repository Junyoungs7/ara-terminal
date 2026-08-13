// F23 MCP 조종 모드 실기동 스크린샷. session/workspace 배선은 다른 하네스(w3-screenshot.cjs)와 같은
// 최소 패턴 — mcp:* 는 여기서 직접 흉내낸다(실 McpApprovalManager/McpServer 는 vitest 가 프로토콜
// 레벨로 이미 검증했다 — 이 하네스의 목적은 렌더러가 그 상태를 올바로 그리는지 눈으로 보는 것).
//
// 산출물: ① agent_talk/F23-settings-screenshot.png (설정 [MCP] — 서버 on + 토큰 발급 1회 표시)
//         ② agent_talk/F23-approval-screenshot.png (승인 다이얼로그 + "AI 조종 중" 인디케이터)
//         ③ agent_talk/F23-audit-screenshot.png    (감사 로그 — A.R.A 터미널로 실제 jsonl 파일을 연다)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let getWc = () => null

// ── 세션 IPC(w3-screenshot.cjs 와 동일 최소 배선) ──
const ptys = new Map()
const BACKLOG = new Map()
const backlogOf = (id) => { let st = BACKLOG.get(id); if (!st) BACKLOG.set(id, (st = { chunks: [], attached: false })); return st }
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
function attachBacklog(id) {
  const st = backlogOf(id)
  st.attached = true
  const total = st.chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of st.chunks) { out.set(c, off); off += c.length }
  return out
}
let sessionTitle = null
function wireLocal() {
  ipcMain.handle('session:attach', (_e, { id }) => ({ backlog: attachBacklog(id) }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
    sessionTitle = sessionTitle ?? id
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, aiModel: 'claude-sonnet-5', logRetentionDays: 30 }
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko', aiModel: UI.aiModel, logRetentionDays: UI.logRetentionDays }
  }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
  ipcMain.handle('sessionlog:reveal', () => ({ ok: true }))
}

// ── mcp:* IPC 가짜 배선 — 실 계약(shared/ipc.ts)과 같은 모양. 상태 머신 자체는 vitest 가 증명했으니
// 여기선 렌더러가 이 상태를 올바로 그리는지만 본다. ──
const McpState = { enabled: false, port: 39217, hasToken: false, connected: 0, sessions: [] }
function pushMcpState() {
  const wc = getWc()
  if (wc && !wc.isDestroyed()) wc.send('mcp:stateChanged', JSON.parse(JSON.stringify(McpState)))
}
function wireMcp() {
  ipcMain.handle('mcp:getState', () => JSON.parse(JSON.stringify(McpState)))
  ipcMain.handle('mcp:setEnabled', (_e, { enabled }) => {
    McpState.enabled = enabled
    if (!enabled) { McpState.connected = 0; McpState.sessions = [] }
    return enabled ? { ok: true, port: McpState.port } : { ok: true }
  })
  ipcMain.handle('mcp:issueToken', () => {
    McpState.hasToken = true
    return { token: 'ara_' + Array.from({ length: 43 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[Math.floor(Math.random() * 64)]).join('') }
  })
  ipcMain.handle('mcp:disconnectClient', () => { McpState.connected = 0; pushMcpState(); return { ok: true } })
  ipcMain.handle('mcp:setSessionMode', (_e, { sessionId, mode, minutes }) => {
    const s = McpState.sessions.find((s) => s.sessionId === sessionId)
    if (s) { s.mode = mode; if (mode === 'autoAllow') s.autoAllowUntil = Date.now() + (minutes || 10) * 60000 }
    pushMcpState()
    return { ok: true }
  })
  ipcMain.handle('mcp:handback', (_e, { kill }) => {
    for (const s of McpState.sessions) s.mode = 'readOnly'
    if (kill) { McpState.connected = 0; McpState.enabled = false }
    pushMcpState()
    return { ok: true }
  })
  ipcMain.handle('mcp:approvalRespond', () => ({ ok: true }))
}

// w3-screenshot.cjs 의 "직전 프레임" 방지 트릭을 가져왔지만, 그 트릭은 lastBytes 와 비교해 "바뀌었으면
// 확정"하는 방식이라 **이 프로세스에서 처음 찍는 스크린샷**은 비교 기준(lastBytes=-1)이 없어 최초
// 프레임(드로어가 아직 안 열린 상태 등)을 검증 없이 그대로 확정해 버렸다(실측: 재실행마다 같은
// 바이트 수로 고정 실패). 매 호출마다 강제 리페인트를 최소 2회 무조건 거치고, 그 두 번째 결과를
// 쓴다 — 비교 대상 없이도 "충분히 정착된 프레임"을 보장한다.
async function capture(win, name) {
  let png = Buffer.alloc(0)
  for (let i = 0; i < 2; i++) {
    // 실측: document.visibilityState 가 'hidden' 이면(창이 다른 창에 가려짐/포커스를 잃음 — 이 샌드박스
    // 에서 연속 실행 시 실제로 관찰됨) capturePage() 가 가려지기 전의 오래된 프레임을 반복해서 돌려준다.
    // 리사이즈만으론 못 고친다 — 강제로 앞으로 올리고 포커스를 줘야 실제로 다시 합성된다.
    win.show()
    win.focus()
    win.moveTop()
    const [w, h] = win.getSize()
    win.setSize(w - 1, h)
    await wait(300)
    win.setSize(w, h)
    await wait(500)
    const img = await win.webContents.capturePage()
    png = img.toPNG()
  }
  if (png.length === 0) {
    await wait(800)
    png = (await win.webContents.capturePage()).toPNG()
  }
  writeFileSync(shotPath(name), png)
  console.log('SCREENSHOT ' + name + ' bytes=' + png.length)
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()
  wireMcp()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(700)

  // 로컬 세션 하나(승인 다이얼로그·인디케이터가 가리킬 실제 세션 + 감사 로그 캣용).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(700)
    return true
  })()`)
  await wait(500)
  const sessionId = [...ptys.keys()][0]

  // ── ① 설정 [MCP] — 서버 켜기 + 토큰 발급 1회 표시 ──
  // 드로어 트랜지션(.22s)·리렌더 타이밍이 픽스드 sleep 보다 느릴 수 있어(연속 재실행에서 실측),
  // 각 단계마다 실제 DOM 등장을 폴링한다(고정 대기 → 조건 대기로).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const waitFor = async (sel, ms = 4000) => {
      const start = Date.now()
      while (!document.querySelector(sel) && Date.now() - start < ms) await wait(30)
      return document.querySelector(sel)
    }
    document.querySelector('.titlebar .tb-gear')?.click()
    await waitFor('.drawer.open')
    ;(await waitFor('.drawer.open .set-nav span[data-section="mcp"]'))?.click()
    await wait(200)
    ;(await waitFor('[role="switch"][aria-label="MCP 서버"]'))?.click()
    await wait(300)
    ;(await waitFor('[data-action="mcp.token.issue"]'))?.click()
    await waitFor('[data-field="mcp.token"]')
    await wait(300)
    return document.querySelector('[data-field="mcp.token"]')?.value ?? ''
  })()`)
  await wait(400)
  await capture(win, 'F23-settings-screenshot.png')

  // ── ② 승인 다이얼로그 + "AI 조종 중" 인디케이터 ──
  // 설정 드로어 닫고, MCP 상태를 "클라이언트 1개 접속 + 세션 승인 모드"로 만든 뒤 승인 요청을 push.
  McpState.connected = 1
  McpState.sessions = [{ sessionId, mode: 'approval' }]
  pushMcpState()
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const waitFor = async (sel, ms = 3000) => {
      const start = Date.now()
      while (!document.querySelector(sel) && Date.now() - start < ms) await wait(30)
      return document.querySelector(sel)
    }
    document.querySelector('.drawer .x')?.click()
    await wait(400)
    return !!(await waitFor('.sb-seg.mcp'))
  })()`)
  await wait(300)
  // 참고 스크린샷(4번째, 필수 3장 외 보너스) — 다이얼로그의 전역 오버레이(.overlay, 앱 전체 공용
  // window.confirm 대체 컴포넌트)가 배경 전체를 어둡게 깔기 때문에(기존 동작 — 이 태스크에서 바꾸지
  // 않는다) 인디케이터가 다이얼로그 밑에서는 옅게 보인다. 인디케이터 자체가 정상 렌더되는 증거를
  // 남기기 위해 다이얼로그를 띄우기 직전 상태를 한 장 더 남긴다.
  await capture(win, 'F23-indicator-screenshot.png')
  getWc()?.send('mcp:approvalRequest', {
    requestId: 'demo-req-1',
    sessionId,
    tool: 'session_input',
    argsSummary: '{"sessionId":"' + sessionId + '","data":"export TOKEN=****"}',
    expiresAt: Date.now() + 120000
  })
  await wait(700)
  await capture(win, 'F23-approval-screenshot.png')
  // 다이얼로그를 닫아 다음 화면(터미널)이 가려지지 않게 한다.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const btns = [...document.querySelectorAll('.dlg-overlay .modal-ft .btn')]
    btns.find(b => b.textContent.includes('거부'))?.click()
    await wait(300)
    return true
  })()`)

  // ── ③ 감사 로그 — 실제 스키마의 jsonl 을 만들고 A.R.A 자신의 터미널로 열어 보인다 ──
  const logDir = mkdtempSync(join(tmpdir(), 'ara-f23-audit-'))
  const logPath = join(logDir, 'mcp-actions_20260804.jsonl')
  const now = Date.now()
  const rows = [
    { seq: 41, at: now - 60000, sessionId, tool: 'session_list', args: '{}', mode: 'approval', outcome: 'auto', resultSummary: '실행: session_list' },
    { seq: 42, at: now - 45000, sessionId, tool: 'session_read', args: '{"sessionId":"' + sessionId + '"}', mode: 'approval', outcome: 'auto', resultSummary: '실행: session_read' },
    { seq: 43, at: now - 30000, sessionId, tool: 'session_input', args: '{"sessionId":"' + sessionId + '","data":"export TOKEN=****"}', mode: 'approval', outcome: 'approved', resultSummary: '실행: session_input' },
    { seq: 44, at: now - 15000, sessionId, tool: 'session_destroy', args: '{"sessionId":"' + sessionId + '"}', mode: 'readOnly', outcome: 'denied', resultSummary: '요청이 거부되었습니다.' },
    { seq: 45, at: now, sessionId: '(new)', tool: 'session_create', args: '{"type":"ssh","profileId":"p1"}', mode: 'approval', outcome: 'rateLimited', resultSummary: '요청이 너무 많아 제한되었습니다. 잠시 후 다시 시도하세요.' }
  ]
  writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  // 실측: PowerShell 의 콘솔 출력은 ConPTY 파이프 위에서 [Console]::OutputEncoding/chcp 를 둘 다
  // 무시하고 레거시 코드페이지로 다시 인코딩한다(.NET 이 "진짜 콘솔"이 아니라고 판단해 우회 경로를
  // 탄다 — 알려진 PowerShell/ConPTY 특성). 파일 자체는 UTF-8 이 맞으므로(auditLog.ts 그대로) 화면
  // 표시만 이 경로를 우회한다 — node 로 stdout 에 raw 바이트를 직접 쓴다(콘솔 재인코딩 없음).
  // process.execPath 는 이 프로세스(electron.exe) 자신을 가리켜 -e 를 스크립트 eval 로 안 받는다 —
  // PATH 의 plain node 를 쓴다(개발 환경엔 항상 있다).
  const rawLogPath = logPath.replace(/\\/g, '\\\\')
  const catCmd =
    process.platform === 'win32'
      ? `node -e "process.stdout.write(require('fs').readFileSync('${rawLogPath}','utf8'))"\r`
      : `cat '${logPath}'\n`
  ptys.get(sessionId)?.write(catCmd)
  await wait(900)
  await capture(win, 'F23-audit-screenshot.png')

  console.log('F23 screenshots done (settings / approval / audit)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 30000)
