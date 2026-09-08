// 매뉴얼 캡처 하네스 — agent_talk/DOCS-manual-shots.md 의 8장(가능하면 10 포함) 중
// 합성으로 안전하게 찍을 수 있는 7장(1·2·3·4·7·13·14)을 실제 컴포넌트로 그려 찍는다.
//
// 베낀 곳: tests/screenshot.cjs(실제 out/preload+out/renderer 로 앱을 띄우고 최소 IPC 를 무는 법) +
//         tests/tip-check.cjs(🔴 show:false + offscreen:true, 창 하나 재사용) +
//         tests/fbmon-screenshot.cjs(__evAdopt 로 로컬 pty 를 SSH 로 편입 + telemetry:data 주입) +
//         tests/w1c-screenshot.cjs(sendInputEvent 로 xterm 에 진짜 타이핑 — 합성 KeyboardEvent 는 안 먹는다).
//
// 🔴 창을 안 띄운다(준영님이 지금 그 PC 를 쓰고 계신다) · 실제 서버에 접속하지 않는다.
// 화면 모양은 전부 실제 컴포넌트·실제 CSS 로 그린다 — DOM 을 손으로 조립해 흉내 내지 않는다.
//
// 안 찍은 것: 10번(RDP [옵션] 드롭다운). 해상도·키변환은 연결 전에도 뜨지만 파일 받기/보내기/
// 단축키 항목은 RdpView.rdpOptionItems 가 `s.connected` 일 때만 배열에 넣는다(2026-09-04 변경) —
// 진짜 접속 없이는 "다 보이는" 그림을 만들 수 없다. 억지로 비슷하게 만들지 않고 건너뛴다.
//
// 돌리는 법: npm run build && npx electron tests/manual-shots.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdirSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const SHOTDIR = join(ROOT, 'site', 'assets', 'shots')
mkdirSync(SHOTDIR, { recursive: true })
const shotPath = (name) => join(SHOTDIR, name)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const IS_WIN = process.platform === 'win32'

// package.json 에서 읽는다 — 하드코딩하면 다음 버전에서 또 낡는다(리뷰 지적).
const VERSION = require(join(ROOT, 'package.json')).version
const bumpPatch = (v) => { const p = v.split('.'); p[2] = String(Number(p[2]) + 1); return p.join('.') }
const NEXT_VERSION = bumpPatch(VERSION) // 업데이트 알림용 "다음 버전" — 지금 버전보다 낮으면 안 된다

// ── 합성 데이터 — 사내 서버명·IP 는 허용(사이트가 사내망 전용), 사람 이름·이메일·전화번호·
// 주민번호 모양·실제 비밀번호는 한 글자도 없다 ──
const PROFILE = { id: 'p1', name: '배포서버', host: '10.20.30.15', port: 22, username: 'deploy', group: '운영', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } }
const SRV_CWD = '/srv/배포'
const SRV_ENTRIES = [
  { name: 'releases', type: 'dir', size: 0, mtime: Date.now() },
  { name: 'logs', type: 'dir', size: 0, mtime: Date.now() },
  { name: 'docker-compose.yml', type: 'file', size: 221, mtime: Date.now() },
  { name: '.env.example', type: 'file', size: 89, mtime: Date.now() }
]
const HISTORY = {
  local: ['go build ./...', 'grep -rn TODO src/main', 'git log --oneline -10', 'git status']
}

const ptys = new Map()
let getWc = () => null
// 🔴 'available' 을 부팅 때부터 주면 켤 때 한 번 뜨는 업데이트 확인창이 곧바로 튀어나와 이후
// 모든 장을 덮는다(실측) — shot 14 를 찍기 직전에만 이 값을 바꾼다.
let updateState = { status: 'idle' }

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

function spawnLocal() {
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: ROOT, env: process.env }
  if (IS_WIN) { opts.useConpty = true; opts.useConptyDll = true }
  return pty.spawn(IS_WIN ? 'powershell.exe' : '/bin/sh', IS_WIN ? ['-NoLogo'] : [], opts)
}

function wire() {
  ipcMain.handle('app:getVersion', () => VERSION)
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [PROFILE])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p9' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3,
    savedAt: '',
    app: { version: VERSION },
    profiles: [PROFILE],
    knownHosts: {},
    layout: { type: 'pane', sessionId: null },
    sessions: [],
    tabGroups: [],
    ui: {
      sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
      ctxMenuStyle: 'list',
      font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
      locale: 'ko',
      scrollback: 10000,
      copyOnSelect: true,
      bootSplash: false, // 부팅 인사를 건너뛰어야 첫 실행 환영 모달이 곧바로 뜬다
      araWelcomeSeen: false
    }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'manual-shots: 실접속 미수행' }))
  ipcMain.handle('ssh:test', () => ({ ok: false, reason: 'network', message: 'manual-shots: 실접속 미수행' }))
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))

  ipcMain.handle('session:create', (_e, spec) => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    // fakeServer: 화면을 서버로 편입할 "배포서버" 세션(shot 2·3·7) — 실제 pty 를 안 띄운다.
    // 진짜 로컬 셸을 spawn 하면 그 셸의 배너·프롬프트가 우리가 주입할 가짜 ls 출력과 뒤섞인다 —
    // 아예 pty 없이 session:data 만 이 파일이 직접 채워 넣는 편이 결정적이다.
    if (spec && spec.fakeServer) return { id }
    const p = spawnLocal()
    ptys.set(id, p)
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
    return { id }
  })
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
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', (_e, { id }) => { try { ptys.get(id)?.pause() } catch {} })
  ipcMain.on('session:resume', (_e, { id }) => { try { ptys.get(id)?.resume() } catch {} })

  // ── F11 히스토리(shot 13) ──
  ipcMain.handle('history:load', (_e, { scope }) => ({ entries: HISTORY[scope] ?? [] }))
  ipcMain.handle('history:append', () => ({ ok: true }))

  // ── 텔레메트리(shot 3·7) — 폴링을 시작하지 않는다(no-op). 필요한 순간에 이 파일이 직접 민다 ──
  ipcMain.handle('telemetry:start', () => ({ ok: true }))
  ipcMain.handle('telemetry:stop', () => ({ ok: true }))
  ipcMain.handle('telemetry:refresh', () => ({ ok: true }))
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('forward:create', () => ({ ok: false, message: 'manual-shots: 미수행' }))
  ipcMain.handle('forward:stop', () => ({ ok: true }))
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))

  // ── MCP "AI 조종 중"(shot 3, 가능하면) ──
  ipcMain.handle('mcp:getState', () => ({
    enabled: true,
    port: 39217,
    hasToken: true,
    connected: 1,
    sessions: [{ sessionId: 'loc-demo', mode: 'autoAllow' }],
    handedBack: false
  }))
  ipcMain.handle('mcp:setEnabled', () => ({ ok: true }))

  // ── 업데이트(shot 14) — 상태는 모듈 스코프의 updateState 를 그대로 읽는다(설정 서랍을 열기
  // 직전에 이 파일이 값을 'available' 로 바꾼다 — 위 큰 주석 참고) ──
  ipcMain.handle('update:get', () => updateState)
  ipcMain.handle('update:check', () => updateState)
  ipcMain.handle('update:download', () => ({ ok: true }))
  ipcMain.handle('update:install', () => ({ ok: true }))

  // 서버 세션의 [파일] 탭(shot 2) — "빈 폴더입니다"는 빈 상태가 요점인 장이 아니면 화면이 고장
  // 나 보인다(리뷰 지적). 항목 몇 개만 채운다 — 무해한 배포 디렉터리 모양.
  ipcMain.handle('sftp:list', (_e, req) => ({
    ok: true,
    path: (req && req.path) || SRV_CWD,
    parent: '/srv',
    entries: SRV_ENTRIES
  }))
  // ── 안 쓰지만 마운트 시 호출되는 것들 — 핸들러 부재 예외만 막는다 ──
  ipcMain.handle('fs:list', () => ({ ok: true, path: '/', entries: [] }))
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
  ipcMain.handle('fs:drives', () => ({ drives: [] }))
  ipcMain.handle('agent:state', () => null)
  ipcMain.handle('aisession:save', () => ({ ok: true }))
  // hasKey:true — 안 그러면 SettingsDrawer 가 열릴 때마다 [AI] 섹션으로 튄다(설정 [일반] 을 보여줘야 한다).
  ipcMain.handle('ai:getState', () => ({ hasKey: true, provider: 'anthropic', model: '', turns: [], streaming: false, usage: { input: 0, output: 0 }, droppedTurns: 0 }))
}

// ── 키 입력(w1c-screenshot.cjs 와 같은 방식) — Chromium 입력 파이프라인을 거쳐야 xterm 이
// 진짜 타이핑으로 받는다(합성 KeyboardEvent 로는 재현되지 않는다) ──
async function typeChar(win, ch) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
  win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
}

const js = (win, code) => win.webContents.executeJavaScript(code)

async function nudgeAndCapture(win) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h)
  await wait(200)
  win.setSize(w, h)
  await wait(400)
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) {
    await wait(800)
    img = await win.webContents.capturePage()
  }
  return img
}

/** rect 는 CSS px(getBoundingClientRect 값) — devicePixelRatio 로 실제 비트맵 좌표로 환산해 자른다. */
async function captureCrop(win, name, rect) {
  const scale = await js(win, 'window.devicePixelRatio')
  const img = await nudgeAndCapture(win)
  const r = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale)
  }
  const cropped = img.crop(r)
  const png = cropped.toPNG()
  writeFileSync(shotPath(name), png)
  console.log(`SHOT ${name} bytes=${png.length} (crop ${JSON.stringify(r)})`)
  return png.length
}

async function captureFull(win, name) {
  const img = await nudgeAndCapture(win)
  const png = img.toPNG()
  writeFileSync(shotPath(name), png)
  console.log(`SHOT ${name} bytes=${png.length}`)
  return png.length
}

/**
 * 🔴 shot 13 전용 — 창 크기를 흔드는 nudge 를 쓰면 안 된다. TerminalPane 의 `term.onResize` 가
 * fit()→resize 때마다 **clearGhost()를 부른다**(실측): 나머지 장은 nudge 로 재도장을 강제해도
 * 무해하지만, 인라인 고스트만은 그 순간 지워진다(스크린샷을 찍기 직전에 그림이 사라졌었다).
 */
async function captureNoResize(win, name) {
  let img = await win.webContents.capturePage()
  let png = img.toPNG()
  if (png.length === 0) {
    await wait(500)
    img = await win.webContents.capturePage()
    png = img.toPNG()
  }
  writeFileSync(shotPath(name), png)
  console.log(`SHOT ${name} bytes=${png.length} (no-resize)`)
  return png.length
}

const results = {}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false, // 🔴 준영님 화면 위로 뜨지 않는다
    frame: false,
    backgroundColor: '#070910',
    webPreferences: {
      preload: join(OUT, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: true // 🔴 화면 밖 렌더
    }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(1500)

  // ── 1: 첫 실행 환영 모달 ──────────────────────────────────────────────
  results.shot01 = await captureFull(win, 'shot-01-welcome.png')
  // 다음 장들을 위해 건너뛴다([나중에] — 실명 대신 빈 값으로).
  await js(win, `document.querySelector('.wc-ft .btn.sec')?.click()`)
  await wait(400)

  // ── 서버 세션 하나 — 이 하나로 2·3·7번을 전부 찍는다("빈 상태가 요점인 장" 리뷰 지적 이후) ──
  // 진짜 pty 를 안 띄운다(session:create 의 fakeServer 플래그) — 로컬 셸을 spawn 하면 그 배너·
  // 프롬프트가 우리가 넣을 가짜 ls 출력과 뒤섞인다. 화면은 이 파일이 직접 채운다.
  // 🔴 __evAdopt 는 **스토어에 없는 새 id** 에서만 먹는다(store/sessions.ts 의 adopt() 가
  // `t.some(x => x.id===id) ? t : [...]` 라 있는 id 는 조용히 무시한다) — 그래서 raw
  // session:create 직후 그 자리에서 바로 편입한다. 만들면 하단 패널이 [포트 모니터] 탭으로
  // 자동으로 열린다(Shell.tsx의 "첫 세션이 생기면" 이펙트).
  const s1Id = await js(win, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const { id } = await window.ev.session.create({ type: 'local', title: '배포서버', serverKey: '배포서버', cwd: undefined, profileId: 'p1', shell: undefined, fakeServer: true })
    window.__evAdopt(id, '배포서버', '배포서버', 'ssh')
    await wait(500)
    return id
  })()`)
  // 터미널 내용 — 개인 개발 PC 경로(D:\...) 대신 서버 경로의 ls 결과 정도(리뷰 지적).
  const E = '\x1b['
  pushData(
    s1Id,
    `${E}1;36mdeploy@배포서버:${SRV_CWD}$${E}0m ls -la\r\n` +
      `합계 20\r\n` +
      `drwxr-xr-x 4 deploy deploy 4096  9월  5 09:12 .\r\n` +
      `drwxr-xr-x 3 deploy deploy 4096  9월  4 22:03 ..\r\n` +
      `drwxr-xr-x 2 deploy deploy 4096  9월  5 09:00 releases\r\n` +
      `drwxr-xr-x 2 deploy deploy 4096  9월  5 08:50 logs\r\n` +
      `-rw-r--r-- 1 deploy deploy  221  9월  5 09:12 docker-compose.yml\r\n` +
      `-rw-r--r-- 1 deploy deploy   89  9월  5 08:40 .env.example\r\n` +
      `${E}1;36mdeploy@배포서버:${SRV_CWD}$${E}0m `
  )
  getWc()?.send('telemetry:data:' + s1Id, {
    sessionId: s1Id,
    ports: [
      { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
      { proto: 'tcp', port: 443, pid: 1180, process: 'nginx' },
      { proto: 'tcp', port: 8000, pid: 2451, process: 'node' },
      { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' }
    ],
    stats: { cpuPct: 37, memUsedKb: 6_100_000, memTotalKb: 16_000_000 }
  })
  getWc()?.send('session:cwd:' + s1Id, { id: s1Id, cwd: SRV_CWD })
  await wait(700)
  await js(win, `document.querySelector('.bp-tab[data-bottom="monitor"]')?.click()`)
  await wait(500)

  // ── 2: 전체 레이아웃 — 파일 트리에 항목, 터미널에 ls 출력, 하단 패널에 실제 표 ──
  results.shot02 = await captureFull(win, 'shot-02-layout.png')

  // ── 3: 상태바(맨 아래 줄 + 오른쪽 끝 하단바 토글 아이콘) ────────────────
  const cropRect = await js(win, `(() => {
    const sb = document.querySelector('.statusbar')
    const dock = document.querySelector('.act-bottombar')
    const sbR = sb.getBoundingClientRect()
    const dockR = dock ? dock.getBoundingClientRect() : sbR
    const top = Math.max(0, Math.min(sbR.top, dockR.top) - 6)
    return { x: 0, y: top, width: window.innerWidth, height: window.innerHeight - top }
  })()`)
  results.shot03 = await captureCrop(win, 'shot-03-statusbar.png', cropRect)

  // ── 7: 하단 탭 열 개 + 포트 모니터 표 + 행의 [로그] 버튼 ────────────────
  if (s1Id) {
    getWc()?.send('telemetry:data:' + s1Id, {
      sessionId: s1Id,
      ports: [
        { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
        { proto: 'tcp', port: 443, pid: 1180, process: 'nginx' },
        { proto: 'tcp', port: 8000, pid: 2451, process: 'node' },
        { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' }
      ],
      stats: { cpuPct: 37, memUsedKb: 6_100_000, memTotalKb: 16_000_000 }
    })
  }
  await wait(400)
  await js(win, `document.querySelector('.bp-tab[data-bottom="monitor"]')?.click()`)
  await wait(500)
  // 🔴 창 전체로 찍지 마라 — 2번이 같은 시점의 같은 상태를 이미 찍는다. 첫 판이 그래서
  // **두 장이 바이트까지 똑같았다**(sha256 동일). 설명서 §2 와 §6 에 같은 그림이 두 번 실린다.
  // 이 장의 요점은 창이 아니라 **하단 패널**이다(탭 열 개 · 표 · 행의 [로그]). 거기만 자른다.
  const bpRect = await js(win, `(() => {
    const bp = document.querySelector('.bottom-panel') || document.querySelector('.bp')
    if (!bp) return null
    const r = bp.getBoundingClientRect()
    return { x: 0, y: Math.max(0, r.top - 4), width: window.innerWidth, height: Math.min(window.innerHeight - r.top + 4, r.height + 8) }
  })()`)
  results.bpRect = bpRect
  results.shot07 = bpRect
    ? await captureCrop(win, 'shot-07-bottom-tabs.png', bpRect)
    : await captureFull(win, 'shot-07-bottom-tabs.png') // 못 찾으면 전체라도 — 다만 결과에 bpRect:null 이 남는다

  // ── 13: 인라인 고스트 자동완성 + 후보 목록 + 힌트 줄 ─────────────────────
  // 새 로컬 세션(S2, 편입되지 않은 순수 local — scope='local' 이 HISTORY.local 을 문다).
  await js(win, `document.querySelector('.tterm-add')?.click()`)
  await wait(1200)
  await js(win, `document.querySelector('.term-pane .xterm-helper-textarea')?.focus()`)
  await wait(200)
  // #194: 한 글자로는 더 이상 안 뜬다(③ 두 글자 문턱). 'gi' 는 HISTORY.local 의 `git log …`·
  // `git status` 둘과 맞아 고스트 + 후보 2가 된다. 700ms 는 250ms 지연 + 에코 재시도 여유다.
  await typeChar(win, 'g')
  await typeChar(win, 'i')
  await wait(700)
  // ①: 목록은 저절로 안 뜬다 — 설명서 그림이 목록을 보여 줘야 하므로 ↓ 로 연다.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
  await wait(400)
  results.ghost = await js(win, `document.querySelector('.term-ghost')?.textContent ?? null`)
  results.compCount = await js(win, `document.querySelectorAll('.term-comp .ci').length`)
  results.shot13 = await captureNoResize(win, 'shot-13-completion.png')

  // ── 4: 연결 프로필 — [RDP] 를 고르면 포트가 3389 로 ──────────────────────
  // 왼쪽 아이콘 레일을 [연결] 로 되돌린다 — 세션이 생긴 뒤로는 [파일] 이 기본으로 뜬다
  // (Sidebar.tsx shownTab). [새 연결] 버튼은 tab==='conn' 일 때만 그려진다.
  await js(win, `document.querySelector('.lrail-item[data-tab="conn"]')?.click()`)
  await wait(300)
  await js(win, `document.querySelector('.sb-act')?.click()`)
  await wait(500)
  results.rdpPort = await js(win, `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const seg = document.querySelectorAll('.prof-form .fld')[0]?.querySelectorAll('.seg-ctl button')
    if (seg && seg[1]) seg[1].click()
    await wait(200)
    // frm-grid 안 text 입력 순서: 이름 · 호스트 · 포트 · 사용자.
    return document.querySelectorAll('.frm-grid .fld input[type=text]')[2]?.value ?? null
  })()`)
  await wait(300)
  results.shot04 = await captureFull(win, 'shot-04-connection-modal.png')
  await js(win, `document.querySelector('.modal-hd .x')?.click()`)
  await wait(300)

  // ── 14: 설정 → [일반] → 업데이트 — [업데이트 확인]·[받기] 나란히 ─────────
  // 🔴 SettingsDrawer 는 **언마운트되지 않는다**(open 클래스만 토글 — SettingsDrawer.tsx:856 주석).
  // UpdateRow 의 useEffect([]) 는 부팅 시 딱 한 번만 update:get 을 invoke 한다 — 그래서 이 값을
  // 여기서 바꿔도(pull) 이미 떠 있는 컴포넌트는 못 본다. push 채널(update:state)로 실제로 밀어야
  // onUpdateState 구독이 반응한다(실측: push 없이 두니 계속 "최신입니다"만 보였다).
  // 🔴 여기도 박아 두지 마라. 첫 판이 '0.3.0' 이었는데 제품이 1.0.0 이 되자 **현재 버전보다 낮은
  // 것을 "새 버전"이라고 알리는 그림**이 됐다. 위 VERSION 에서 파생시켜 그 짝이 안 어긋나게 한다.
  updateState = { status: 'available', version: NEXT_VERSION }
  getWc()?.send('update:state', updateState)
  await wait(400)
  // 🔴 그 push 가 "켤 때 한 번 뜨는" 확인창도 같이 깨운다(useUpdatePrompt 가 같은 push 를 구독한다) —
  // [나중에]로 넘겨야 설정 서랍이 가려지지 않는다(실측: 안 넘기면 이 확인창이 서랍을 통째로 덮는다).
  await js(win, `document.querySelector('.dlg-overlay .modal-ft .btn.sec')?.click()`)
  await wait(300)
  // 설정 진입점은 우측 액티비티 바 맨 아래 톱니(2026-08-19 재배치) — `.titlebar .tb-gear` 는
  // 그 이전 라운드(F5)의 낡은 선택자였다(지금 코드에 그 클래스가 없다).
  await js(win, `document.querySelector('[data-activity="settings"]')?.click()`)
  await wait(600)
  results.updateStatus = await js(win, `document.querySelector('[data-update-status]')?.getAttribute('data-update-status') ?? null`)
  // 🔴 창 전체로 찍지 마라 — 이 장은 순서상 **맨 끝**이라 앞 장들의 잔재를 전부 이고 있다.
  // 첫 판 실측: 13번이 띄운 자동완성 목록(`git status`·`go build ./...`)이 터미널 한가운데에
  // 그대로 떠 있었고, 하단 패널은 빈 상태 문구였고, 프롬프트에 내 개발 PC 경로가 찍혀 있었다.
  // 업데이트를 설명하는 그림에 다른 기능의 UI 가 얹히면 읽는 사람은 그게 관련 있는 줄 안다.
  // 이 장의 요점은 서랍이다 — 거기만 자르면 셋이 한꺼번에 사라진다.
  const drawerRect = await js(win, `(() => {
    const d = document.querySelector('.drawer.open')
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { x: Math.max(0, r.left - 4), y: Math.max(0, r.top - 4), width: Math.min(window.innerWidth - r.left + 4, r.width + 8), height: Math.min(window.innerHeight - r.top + 4, r.height + 8) }
  })()`)
  results.drawerRect = drawerRect
  results.shot14 = drawerRect
    ? await captureCrop(win, 'shot-14-update.png', drawerRect)
    : await captureFull(win, 'shot-14-update.png') // 못 찾으면 전체라도 — 결과에 drawerRect:null 이 남는다

  console.log('결과:', JSON.stringify(results, null, 1))

  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => {
  console.log('manual-shots timeout')
  app.exit(1)
}, 90000)
