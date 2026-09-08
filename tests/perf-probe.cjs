// #190 3라운드 — **재기만 한다.** 무엇이 느린지를 숫자로 남긴다(고치지 않는다).
//
// 제보: "타이핑시 약간 딜레이" · "백스페이스로 지울때 뚝뚝 거리는 느낌".
// 이 라운드의 핵심 질문 하나: **롱태스크가 2.5초 텔레메트리 틱과 시각이 겹치는가.**
//
// 그래서 이 하네스는 앞선 하네스들과 달리 텔레메트리를 **진짜 2.5초 간격으로** 민다
// (manual-shots.cjs 는 필요한 순간 한 번씩만 밀었다 — 그걸로는 겹침을 볼 수 없다).
//
// 베낀 곳: tests/manual-shots.cjs(실제 out/ 을 offscreen 으로 띄우고 IPC·pty·sendInputEvent 타이핑),
//         tests/tip-check.cjs(🔴 show:false + offscreen:true · 창 하나 재사용 · probe.toString() 직렬화).
//
// 🔴 창을 안 띄운다(준영님이 그 PC 를 쓰고 계신다) · 실제 서버 접속 없음 · 제품 코드를 안 고친다.
//
// 무엇을 재나
//   ① 롱태스크        PerformanceObserver({entryTypes:['longtask']}) — 50ms 넘게 막힌 구간
//   ①' CPU 프로파일   CDP Profiler(0.5ms 표본). 롱태스크의 50ms 문턱 **아래**를 보는 자다.
//                     "뚝뚝"은 50ms 미만의 20~40ms 끊김일 수도 있어 문턱 없는 자가 따로 필요하다.
//                     🔴 표본 시각을 틱 기준 상대시간으로 접으면 **겹침 질문에 직접 답한다**.
//   ①'' 블로킹 샘플러 5ms 자기호출 setTimeout 의 지각량. offscreen 에서는 프레임(≈15.6ms)에
//                     정렬돼 늘 10.5ms 씩 늦는다(실측) — 그 **기준선을 빼고** 읽는 보조 자다.
//   ② 리렌더          React DevTools 훅 껍데기 + react-dom/profiling 빌드로 컴포넌트별 actualDuration
//   ③ 키→에코         sendInputEvent 시각 → 렌더러 keydown → session:input IPC → pty 에코 → 캔버스 draw
//
// 돌리는 법
//   npm run build && npx electron tests/perf-probe.cjs --tag=idle-t1 --sessions=1 --telemetry=on
//   node tests/perf-run.cjs        ← 아래 7종을 순서대로 다 돌린다(권장)
//
// 인자
//   --tag=<이름>        산출물 이름(agent_talk/perf/<tag>.json)
//   --sessions=N        만들 세션 수(1 이 기본. 첫 세션은 SSH 로 편입 — 실사용 최악값이다)
//   --telemetry=on|off  2.5초 텔레메트리 푸시. off 가 대조군이다
//   --typing=on|off       타이핑 구간 포함
//   --dur=<ms>          측정 창 길이(기본 30000)
//   --profile=on|off    out-perf/ (react-dom/profiling · 비압축) 를 띄우고 컴포넌트별로 잰다
//   --tabs=on|off       하단 탭 넷을 측정 전에 열어 둔다(마운트가 쌓인 실사용 상태)
//
// 🔴 --profile=on 은 **절대값을 부풀린다**(ProfileMode 의 now() 계측 + 커밋마다 파이버 트리 순회 +
//   비압축 번들). 그 판의 숫자는 **컴포넌트 사이의 비율**로만 읽어라. 절대 ms 는 --profile=off 판이 낸다.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, appendFileSync, mkdirSync, existsSync } = require('node:fs')
const pty = require('node-pty')

const ROOT = join(__dirname, '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const IS_WIN = process.platform === 'win32'

// ── 인자 ────────────────────────────────────────────────────────────────────
const ARGV = {}
for (const a of process.argv.slice(2)) {
  const m = /^--([\w-]+)=(.*)$/.exec(a)
  if (m) ARGV[m[1]] = m[2]
}
const CFG = {
  tag: ARGV.tag || 'run',
  sessions: Math.max(1, Number(ARGV.sessions || 1)),
  telemetry: (ARGV.telemetry || 'on') === 'on',
  typing: (ARGV.typing || 'off') === 'on',
  dur: Number(ARGV.dur || 30000),
  profile: (ARGV.profile || 'off') === 'on',
  // 하단 탭 넷을 **측정 창 전에** 열어 둔다. #87 ⑤ 는 한 번 연 탭의 마운트를 유지하므로
  // 실사용은 하루가 갈수록 이 상태에 가까워진다 — 감사가 "갈수록 나빠진다"고 적은 그 자리다.
  tabs: (ARGV.tabs || 'off') === 'on'
}
const OUTDIR = join(ROOT, CFG.profile ? 'out-perf' : 'out')
const REPORTDIR = join(ROOT, 'agent_talk', 'perf')
mkdirSync(REPORTDIR, { recursive: true })
const REPORT = join(REPORTDIR, CFG.tag + '.json')

if (!existsSync(join(OUTDIR, 'renderer', 'index.html'))) {
  console.error(`빌드가 없다: ${OUTDIR}. ` + (CFG.profile ? 'npx electron-vite build --config tests/perf.vite.config.ts' : 'npm run build'))
  process.exit(2)
}

const TELEMETRY_MS = 2500 // 제품과 같은 값(LocalTelemetry/RemoteTelemetry/HostStats 셋 다 POLL_MS=2500)

// ── 합성 데이터 ─────────────────────────────────────────────────────────────
const PROFILE = {
  id: 'p1', name: '배포서버', host: '10.20.30.15', port: 22, username: 'deploy', group: '운영',
  auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
}
// 실사용 최악값에 가깝게 — 유휴 서버도 리슨 포트가 이 정도는 된다.
const PORTS = [
  { proto: 'tcp', port: 22, pid: 812, process: 'sshd' },
  { proto: 'tcp', port: 80, pid: 1180, process: 'nginx' },
  { proto: 'tcp', port: 443, pid: 1181, process: 'nginx' },
  { proto: 'tcp', port: 3000, pid: 2210, process: 'node' },
  { proto: 'tcp', port: 5432, pid: 1044, process: 'postgres' },
  { proto: 'tcp', port: 6379, pid: 1490, process: 'redis-server' },
  { proto: 'tcp', port: 8080, pid: 2451, process: 'java' },
  { proto: 'tcp', port: 9090, pid: 3310, process: 'prometheus' }
]

const ptys = new Map()
let getWc = () => null

// ── 시각 기록(node 쪽 · epoch ms) ───────────────────────────────────────────
const LOG = {
  ticks: [], // 텔레메트리를 민 시각
  sent: [], // sendInputEvent 를 부른 시각 {ch, t}
  ipcIn: [], // session:input 이 main 에 닿은 시각 {t, data}
  ptyOut: [], // pty 가 에코를 뱉은 시각 {t, len}
  paints: [] // offscreen 이 프레임을 내놓은 시각(webContents 'paint')
}

const BACKLOG = new Map()
const backlogOf = (id) => {
  let st = BACKLOG.get(id)
  if (!st) BACKLOG.set(id, (st = { chunks: [], attached: false }))
  return st
}
function pushData(id, u8) {
  const st = backlogOf(id)
  st.chunks.push(u8)
  if (!st.attached) return
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.postMessage('session:data:' + id, u8)
}

function spawnLocal() {
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: ROOT, env: process.env }
  if (IS_WIN) { opts.useConpty = true; opts.useConptyDll = true }
  return pty.spawn(IS_WIN ? 'powershell.exe' : '/bin/sh', IS_WIN ? ['-NoLogo'] : [], opts)
}

function wire() {
  const ok = () => ({ ok: true })
  ipcMain.handle('app:getVersion', () => require(join(ROOT, 'package.json')).version)
  ipcMain.handle('app:openExternal', ok)
  ipcMain.handle('profile:list', () => [PROFILE])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p9' } }))
  ipcMain.handle('profile:delete', ok)
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3,
    savedAt: '',
    app: { version: '0.0.0' },
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
      bootSplash: false,
      araWelcomeSeen: true // 부팅 인사·환영 모달을 건너뛴다(측정 창을 덮으면 안 된다)
    }
  }))
  ipcMain.handle('workspace:save', ok)
  ipcMain.handle('ui:setPrefs', ok)
  ipcMain.handle('ui:setGroups', ok)
  ipcMain.handle('ui:setFont', ok)
  ipcMain.handle('ui:setSidebar', ok)
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'perf-probe: 실접속 미수행' }))
  ipcMain.handle('ssh:test', () => ({ ok: false, reason: 'network', message: 'perf-probe: 실접속 미수행' }))
  ipcMain.handle('window:minimize', ok)
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', ok)

  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const p = spawnLocal()
    ptys.set(id, p)
    p.onData((d) => {
      const b = Buffer.from(d, 'utf8')
      const u = new Uint8Array(b.length)
      u.set(b)
      LOG.ptyOut.push({ t: Date.now(), id, len: u.length })
      pushData(id, u)
    })
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
  ipcMain.handle('session:rename', ok)
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {} ; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {} ; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => {
    LOG.ipcIn.push({ t: Date.now(), id, data })
    ptys.get(id)?.write(data)
  })
  ipcMain.on('session:pause', (_e, { id }) => { try { ptys.get(id)?.pause() } catch {} })
  ipcMain.on('session:resume', (_e, { id }) => { try { ptys.get(id)?.resume() } catch {} })

  ipcMain.handle('history:load', () => ({ entries: [] }))
  ipcMain.handle('history:append', ok)

  // 🔴 폴링은 시작하지 않는다(no-op) — 이 파일이 아래에서 **직접 2.5초마다** 민다.
  ipcMain.handle('telemetry:start', ok)
  ipcMain.handle('telemetry:stop', ok)
  ipcMain.handle('telemetry:refresh', ok)
  // 제품과 같은 모양: 매번 **새 배열**을 만든다(참조가 매번 바뀌므로 setForwards 가 리렌더를 부른다).
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('forward:create', () => ({ ok: false, message: 'perf-probe: 미수행' }))
  ipcMain.handle('forward:stop', ok)
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))
  ipcMain.handle('sys:start', ok)
  ipcMain.handle('sys:stop', ok)

  ipcMain.handle('mcp:getState', () => ({ enabled: false, port: 0, hasToken: false, connected: 0, sessions: [], handedBack: false }))
  ipcMain.handle('mcp:setEnabled', ok)
  ipcMain.handle('update:get', () => ({ status: 'idle' }))
  ipcMain.handle('update:check', () => ({ status: 'idle' }))
  ipcMain.handle('update:download', ok)
  ipcMain.handle('update:install', ok)

  ipcMain.handle('sftp:list', (_e, req) => ({ ok: true, path: (req && req.path) || '/srv/배포', parent: '/srv', entries: [] }))
  ipcMain.handle('fs:list', () => ({ ok: true, path: '/', entries: [] }))
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
  ipcMain.handle('fs:drives', () => ({ drives: [] }))
  ipcMain.handle('agent:state', () => null)
  ipcMain.handle('aisession:save', ok)
  ipcMain.handle('ai:getState', () => ({ hasKey: true, provider: 'anthropic', model: '', turns: [], streaming: false, usage: { input: 0, output: 0 }, droppedTurns: 0 }))
  ipcMain.handle('remote:run', () => ({ ok: false, out: '', err: 'perf-probe' }))
  ipcMain.handle('remote:watch', ok)
  ipcMain.handle('remote:unwatch', ok)
}

// ── 렌더러에서 도는 탐침 ────────────────────────────────────────────────────
// node 에서 호출되지 않는다. probe.toString() 으로 직렬화해 넣는다 — 문자열 템플릿에 코드를
// 적으면 이스케이프 사고가 난다(2026-08 하네스 교훈, tip-check.cjs 와 같은 규율).
function probe(opt) {
  const P = {
    origin: performance.timeOrigin,
    vis: document.visibilityState,
    longtasks: [],
    blocks: [], // [지각이 시작된 epoch, 지각 ms]
    commits: [], // {t, dur, n}  dur 은 profile 판에서만 의미 있다
    comps: Object.create(null), // 이름 → {r: 렌더 횟수, self: 자기시간 합, act: actualDuration 합}
    keys: [], // 렌더러가 keydown 을 받은 시각
    draws: [], // 캔버스에 실제로 그린 시각(중복 2ms 로 솎음)
    drawKind: Object.create(null),
    sampler: { iter: 0, on: false, step: 5 },
    hook: { installed: false, commits: 0, walked: false, profileMode: null },
    err: []
  }
  window.__perf = P
  const now = () => performance.now()
  const ep = (t) => Math.round((performance.timeOrigin + t) * 10) / 10

  // ── ① 롱태스크 ──
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        P.longtasks.push({
          s: ep(e.startTime),
          d: Math.round(e.duration * 10) / 10,
          name: e.name,
          att: (e.attribution || []).map((a) => a.name + '/' + a.containerType).join(',')
        })
      }
    })
    po.observe({ entryTypes: ['longtask'] })
  } catch (err) {
    P.err.push('longtask: ' + String(err))
  }

  // ── ①' 블로킹 샘플러 ──
  // 5ms 자기호출 setTimeout. 예정보다 늦게 오면 그 사이 메인 스레드가 막혀 있었다.
  // 롱태스크(50ms 문턱)가 못 보는 20~40ms 끊김을 보려고 문턱 없는 자를 하나 더 든다.
  // 🔴 이 루프 자체가 초당 200회 깨어난다 — 그 비용은 telemetry on/off 두 판에 **똑같이** 실린다.
  const STEP = P.sampler.step
  let last = now()
  function loop() {
    const t = now()
    P.sampler.iter += 1
    const late = t - last - STEP
    if (late >= 2) P.blocks.push([ep(last + STEP), Math.round(late * 10) / 10])
    last = t
    if (P.sampler.on) setTimeout(loop, STEP)
  }
  P.startSampler = () => {
    if (P.sampler.on) return
    P.sampler.on = true
    last = now()
    setTimeout(loop, STEP)
  }
  P.stopSampler = () => { P.sampler.on = false }

  // ── ③ 키·그리기 ──
  // 캡처 리스너에서 **다음 매크로태스크**를 예약해 그 사이를 잰다 = 이 keydown 태스크가 통째로
  // 끝난 시각. 처음엔 버블 리스너로 쟀는데 xterm 이 처리한 키는 버블이 안 올라와 n=0 이었다(실측).
  // MessageChannel 은 setTimeout 과 달리 클램프가 없어 태스크 경계를 정확히 짚는다.
  const mc = new MessageChannel()
  let pending = null
  mc.port1.onmessage = () => { if (pending) { pending.out = ep(now()); pending = null } }
  addEventListener('keydown', (e) => {
    const rec = { k: e.key, t: ep(now()), out: null }
    P.keys.push(rec)
    pending = rec
    mc.port2.postMessage(0)
  }, true)

  let lastDraw = -99
  const hookDraw = (proto, fn, kind) => {
    try {
      if (!proto || typeof proto[fn] !== 'function') return
      const orig = proto[fn]
      proto[fn] = function hooked() {
        if (P.sampler.on) {
          const t = now()
          if (t - lastDraw > 2) {
            lastDraw = t
            if (P.draws.length < 20000) P.draws.push(ep(t))
            P.drawKind[kind] = (P.drawKind[kind] || 0) + 1
          }
        }
        return orig.apply(this, arguments)
      }
    } catch (err) {
      P.err.push('draw hook ' + fn + ': ' + String(err))
    }
  }
  // 🔴 xterm 의 WebGL 렌더러는 `drawArrays` 가 아니라 **instanced** 그리기를 쓴다. 첫 판에서
  // drawArrays 만 걸었더니 잡힌 것이 glyph 아틀라스의 fillText 26회뿐이었다 — 그건 새 글자를
  // 래스터할 때만 도는 것이라 "프레임을 그렸다"의 신호가 아니다.
  // @xterm/addon-webgl 이 실제로 부르는 것은 **drawElementsInstanced** 다(lib/addon-webgl.js 에서
  // 확인 — drawArrays 계열은 한 번도 안 부른다). 첫 판이 이걸 빼먹어 그리기 신호가 0 이었다.
  hookDraw(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, 'drawElementsInstanced', 'webgl2-elem-inst')
  hookDraw(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, 'drawArraysInstanced', 'webgl2-inst')
  hookDraw(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, 'drawArrays', 'webgl2')
  hookDraw(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, 'drawArrays', 'webgl')
  hookDraw(window.ANGLE_instanced_arrays && window.ANGLE_instanced_arrays.prototype, 'drawArraysInstancedANGLE', 'angle-inst')
  hookDraw(window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype, 'fillText', 'canvas2d')

  // ── ② React 커밋 ──
  // React DevTools 훅 껍데기. React 18 은 `typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined'`
  // 하나로 ProfileMode 를 켠다(ReactFiberDevToolsHook 의 isDevToolsPresent) — 그래서 이 껍데기만
  // 있으면 profiling 빌드가 파이버마다 actualDuration 을 적는다. 제품 코드에 <Profiler> 를 넣지
  // 않아도 되는 이유가 이것이다.
  // 🔴 이 훅은 **페이지 스크립트보다 먼저** 깔려야 한다 → CDP Page.addScriptToEvaluateOnNewDocument.
  if (opt.installHook) {
    const TAGS = { 0: 'fn', 1: 'class', 11: 'forwardRef', 14: 'memo', 15: 'memo' }
    const nameOf = (f) => {
      const t = f.type
      if (typeof t === 'function') return t.displayName || t.name || 'Anon'
      if (t && typeof t === 'object') {
        if (t.displayName) return t.displayName
        if (t.render) return (t.render.displayName || t.render.name || 'Anon') + '~fwd'
        if (typeof t.type === 'function') return (t.type.displayName || t.type.name || 'Anon') + '~memo'
      }
      return 'tag' + f.tag
    }
    const childSum = (f) => {
      let s = 0
      let c = f.child
      while (c) { s += c.actualDuration || 0; c = c.sibling }
      return s
    }
    let rid = 0
    const hook = {
      renderers: new Map(),
      supportsFiber: true,
      isDisabled: false,
      checkDCE() {},
      inject(r) { rid += 1; hook.renderers.set(rid, r); return rid },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      on() {}, off() {}, emit() {}, sub() { return () => {} },
      getFiberRoots() { return new Set() },
      setStrictMode() {},
      onCommitFiberRoot(_id, root) {
        P.hook.commits += 1
        if (!P.sampler.on) return // 측정 창 밖(부팅·준비)은 세지 않는다
        const t = ep(now())
        let n = 0
        let total = 0
        try {
          const top = root.current
          total = top ? top.actualDuration || 0 : 0
          const stack = [top]
          while (stack.length) {
            const f = stack.pop()
            if (!f) continue
            if (f.child) stack.push(f.child)
            if (f !== top && f.sibling) stack.push(f.sibling)
            const kind = TAGS[f.tag]
            if (!kind) continue
            if ((f.flags & 1) !== 1) continue // PerformedWork — 컴포넌트 함수가 실제로 돌았나
            n += 1
            const nm = nameOf(f)
            const act = f.actualDuration || 0
            const self = act - childSum(f)
            const e = P.comps[nm] || (P.comps[nm] = { r: 0, self: 0, act: 0 })
            e.r += 1
            e.self += self
            e.act += act
            if (P.hook.profileMode === null) P.hook.profileMode = act > 0
          }
          P.hook.walked = true
        } catch (err) {
          if (P.err.length < 5) P.err.push('walk: ' + String(err))
        }
        P.commits.push({ t, dur: Math.round(total * 100) / 100, n })
      }
    }
    try {
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true, writable: false })
      P.hook.installed = true
    } catch (err) {
      P.err.push('hook: ' + String(err))
    }
  }

  P.reset = () => {
    P.longtasks.length = 0
    P.blocks.length = 0
    P.commits.length = 0
    P.keys.length = 0
    P.draws.length = 0
    P.sampler.iter = 0
    for (const k of Object.keys(P.comps)) delete P.comps[k]
  }
  P.dump = () => ({
    origin: P.origin,
    vis: document.visibilityState,
    longtasks: P.longtasks,
    blocks: P.blocks,
    commits: P.commits,
    comps: P.comps,
    keys: P.keys,
    draws: P.draws,
    drawKind: P.drawKind,
    sampler: P.sampler,
    hook: P.hook,
    err: P.err
  })
  return 'perf-probe installed'
}

// ── 렌더러 상태 조사(판정 아님 — 원자료) ────────────────────────────────────
function census() {
  const q = (s) => document.querySelector(s)
  const all = (s) => Array.from(document.querySelectorAll(s))
  return {
    // xterm 이 어느 렌더러를 골랐나 — offscreen 이면 실기와 다를 수 있다(보고서에 그대로 적는다).
    // 🔴 캔버스 **개수**로는 못 가른다. 이미 만들어진 컨텍스트를 되물어(같은 타입이면 그것을 돌려준다)
    // webgl2 인지 2d 인지 직접 확인한다 — 준영님 PC 는 webgl 이 확정이라(renderer.kind: webgl)
    // 여기서 2d 가 나오면 이 하네스의 그리기 숫자는 실기와 **다른 경로**를 잰 것이다.
    xtermCanvas: all('.xterm-screen canvas').length,
    xtermCanvasCtx: all('.xterm-screen canvas').map((c) => {
      for (const k of ['webgl2', 'webgl', '2d']) { try { if (c.getContext(k)) return k } catch {} }
      return '?'
    }),
    xtermRows: all('.xterm-rows').length,
    termPanes: all('.term-pane').length,
    // #87 ⑤ "한 번 연 탭은 마운트를 유지한다" — 감사가 지적한 자리. 남은 pane 수를 센다.
    bpPanes: all('.bp-pane').length,
    bpPaneTabs: all('.bp-pane').map((p) => {
      const c = p.firstElementChild
      return c ? c.className : '(빈칸)'
    }),
    bpTabs: all('.bp-tab').length,
    bottomOpen: !!q('.bottom-panel'),
    domNodes: document.getElementsByTagName('*').length,
    dpr: window.devicePixelRatio,
    vw: window.innerWidth,
    vh: window.innerHeight
  }
}

// ── 분석(node 쪽) — 재는 것과 판정하는 것을 가른다 ─────────────────────────
const WIN_AFTER = 400 // 틱 뒤 이 창 안에 들어오면 "겹친다"로 본다(2.5초 주기의 16%)

function sum(a) { return a.reduce((x, y) => x + y, 0) }
function pct(a, p) {
  if (a.length === 0) return null
  const s = [...a].sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] * 10) / 10
}

/**
 * CDP V8 표본 프로파일 → ① 시간대별 CPU 사용 ② **틱 기준 상대시간 히스토그램** ③ 함수별 자기시간.
 *
 * 🔴 ②가 이 라운드의 핵심 계기다. 표본 하나하나의 시각을 "직전 텔레메트리 틱으로부터 몇 ms 뒤인가"로
 * 접어서 2.5초 한 주기 위에 쌓는다. 텔레메트리가 범인이면 0~400ms 구간에 산이 생기고, 무죄면 평평하다.
 * 롱태스크(50ms 문턱)와 달리 문턱이 없어 20ms 짜리 끊김도 보인다.
 *
 * 시각 맞추기: Profiler 의 startTime 은 µs 단위 모노토닉이라 epoch 과 원점이 다르다. 그래서 측정 창
 * 앞뒤에 **이름 있는 30ms 바쁜 루프**(ARA_PERF_SYNC)를 한 번씩 돌리고, 프로파일에서 그 함수의 첫
 * 표본을 찾아 node 가 잰 epoch 에 맞춘다 — 추정이 아니라 같은 사건을 양쪽에서 본 값이다.
 */
const SYNC_FN = 'ARA_PERF_SYNC'
const IDLE = new Set(['(idle)'])
const NONJS = new Set(['(program)', '(garbage collector)'])
const BIN = 50 // 틱 상대 히스토그램의 칸 크기(ms)

function analyzeProfile(profile, sync, ticks, t0, windowMs) {
  if (!profile || !profile.samples || profile.samples.length === 0) return { ok: false, why: '표본이 없다' }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const nameOf = (id) => {
    const n = byId.get(id)
    if (!n) return '(?)'
    const f = n.callFrame || {}
    const fn = f.functionName || '(anonymous)'
    const url = (f.url || '').split('/').pop() || ''
    return NONJS.has(fn) || IDLE.has(fn) ? fn : `${fn} @${url}:${f.lineNumber ?? '?'}`
  }

  // ── 시각 맞추기 ──
  const times = []
  let tUs = profile.startTime
  for (let i = 0; i < profile.samples.length; i += 1) {
    tUs += profile.timeDeltas[i] || 0
    times.push(tUs)
  }
  const syncIdx = profile.samples
    .map((id, i) => ((byId.get(id)?.callFrame?.functionName === SYNC_FN) ? i : -1))
    .filter((i) => i >= 0)
  // 마커는 창 앞뒤로 **두 번** 돈다. 표본 사이 간격이 벌어지는 자리에서 두 무리로 가른다.
  // 🔴 두 무리 모두 **첫 표본**을 쓴다(끝 표본을 쓰면 루프 길이 30ms 가 그대로 드리프트로 잡힌다 —
  // 첫 판에서 27ms 가 나왔던 것이 그 착시였다).
  const groups = []
  for (const i of syncIdx) {
    const g = groups[groups.length - 1]
    if (g && times[i] - times[g[g.length - 1]] < 100000) g.push(i)
    else groups.push([i])
  }
  let offsetMs = null
  let calib = null
  if (groups.length > 0 && sync.startEpoch) {
    offsetMs = sync.startEpoch - times[groups[0][0]] / 1000
    const lastFirstUs = groups.length > 1 ? times[groups[groups.length - 1][0]] : null
    calib = {
      syncSamples: syncIdx.length,
      groups: groups.length,
      startEpoch: sync.startEpoch,
      endEpoch: sync.endEpoch,
      // 끝 마커를 시작 기준으로 환산했을 때 node 가 잰 값과 얼마나 어긋나나(= 시계 오차 상한).
      driftMs: lastFirstUs && sync.endEpoch ? Math.round(lastFirstUs / 1000 + offsetMs - sync.endEpoch) : null
    }
  }
  if (offsetMs === null) return { ok: false, why: `시각을 맞출 수 없다(${SYNC_FN} 표본 ${syncIdx.length}개)`, samples: profile.samples.length }

  const epochOf = (i) => times[i] / 1000 + offsetMs
  const prevTick = (t) => {
    let best = null
    for (const k of ticks) if (k <= t && (best === null || k > best)) best = k
    return best
  }

  const self = new Map()
  // 틱 **하나하나**의 비용. 합만 보면 "첫 틱이 34ms, 나머지 0" 과 "매 틱 11ms" 를 구별 못 한다.
  const perTick = ticks.map(() => 0)
  const relBins = new Array(Math.ceil(TELEMETRY_MS / BIN)).fill(0)
  const relBinsSampled = new Array(Math.ceil(TELEMETRY_MS / BIN)).fill(0)
  let busyUs = 0
  let idleUs = 0
  let nonjsUs = 0
  let inWindowUs = 0
  const busyRuns = [] // 연속으로 바쁜 구간 {s, ms}
  let runStart = null
  let runLast = null

  for (let i = 0; i < profile.samples.length; i += 1) {
    const e = epochOf(i)
    if (e < t0 || e > t0 + windowMs) continue
    const dUs = profile.timeDeltas[i] || 0
    if (dUs > 200000) continue // 프로파일러가 멈춘 구간(비정상) — 버린다
    inWindowUs += dUs
    const fn = byId.get(profile.samples[i])?.callFrame?.functionName || ''
    const isIdle = IDLE.has(fn)
    if (isIdle) {
      idleUs += dUs
      if (runStart !== null) {
        if (runLast - runStart >= 8) busyRuns.push({ s: Math.round(runStart), ms: Math.round((runLast - runStart) * 10) / 10 })
        runStart = null
      }
      continue
    }
    if (NONJS.has(fn)) nonjsUs += dUs
    busyUs += dUs
    if (runStart === null) runStart = e - dUs / 1000
    runLast = e
    const k = prevTick(e)
    if (k !== null) {
      const rel = e - k
      if (rel >= 0 && rel < TELEMETRY_MS) {
        const b = Math.floor(rel / BIN)
        relBins[b] += dUs / 1000
        relBinsSampled[b] += 1
        if (rel < WIN_AFTER) perTick[ticks.indexOf(k)] += dUs / 1000
      }
    }
    const nm = nameOf(profile.samples[i])
    self.set(nm, (self.get(nm) || 0) + dUs)
  }
  if (runStart !== null && runLast - runStart >= 8) busyRuns.push({ s: Math.round(runStart), ms: Math.round((runLast - runStart) * 10) / 10 })

  const top = [...self.entries()]
    .filter(([n]) => !IDLE.has(n))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([name, us]) => ({ name, ms: Math.round(us / 1000) }))

  // 틱 창(0~400ms) 대 나머지의 **밀도**. 1 이면 텔레메트리 무죄, 크면 유죄.
  const winBins = Math.ceil(WIN_AFTER / BIN)
  const inWin = sum(relBins.slice(0, winBins))
  const outWin = sum(relBins.slice(winBins))
  const density = outWin > 0 ? Math.round(((inWin / winBins) / (outWin / (relBins.length - winBins))) * 100) / 100 : null

  return {
    ok: true,
    calib,
    samples: profile.samples.length,
    intervalUs: sync.intervalUs,
    coveragePct: Math.round((inWindowUs / 1000 / windowMs) * 1000) / 10,
    cpuBusyMs: Math.round(busyUs / 1000),
    cpuBusyPct: Math.round((busyUs / 1000 / windowMs) * 1000) / 10,
    nonJsMs: Math.round(nonjsUs / 1000),
    idleMs: Math.round(idleUs / 1000),
    busyRuns: { count: busyRuns.length, maxMs: busyRuns.length ? Math.max(...busyRuns.map((r) => r.ms)) : 0, p95: pct(busyRuns.map((r) => r.ms), 95), over20: busyRuns.filter((r) => r.ms >= 20).length, over50: busyRuns.filter((r) => r.ms >= 50).length, top: busyRuns.sort((a, b) => b.ms - a.ms).slice(0, 20) },
    tickRelHistogramMs: relBins.map((v, i) => ({ from: i * BIN, ms: Math.round(v) })),
    perTickBusyMs: perTick.map((v) => Math.round(v * 10) / 10),
    tickWindow: { inMs: Math.round(inWin), outMs: Math.round(outWin), densityRatio: density },
    topSelf: top
  }
}

function analyze(raw, ticks, windowMs) {
  const lt = raw.longtasks
  const blocked = sum(raw.blocks.map((b) => b[1]))
  // 틱과의 겹침: 롱태스크가 어느 틱의 [t, t+WIN_AFTER] 안에서 시작했나.
  const near = (t) => {
    for (const k of ticks) if (t >= k - 30 && t <= k + WIN_AFTER) return Math.round(t - k)
    return null
  }
  const ltNear = lt.map((e) => ({ ...e, dt: near(e.s) }))
  const hit = ltNear.filter((e) => e.dt !== null)
  // 🔴 offscreen 에서는 setTimeout 이 프레임(≈15.6ms)에 정렬돼 **늘** 10.5ms 씩 늦는다(실측:
  // 530회 중 526회가 10~11ms). 그 상수를 안 빼면 "창의 64%가 막혔다"는 거짓 결론이 나온다.
  // 중앙값을 기준선으로 잡고 그 위로 솟은 것만 진짜 끊김으로 센다.
  const lateAll = raw.blocks.map((b) => b[1])
  const baseline = pct(lateAll, 50) ?? 0
  const real = raw.blocks.map(([t, ms]) => [t, ms - baseline]).filter(([, ms]) => ms >= 5)
  const blockedReal = sum(real.map((b) => b[1]))
  // 틱 뒤 400ms 창의 블로킹 합 대 나머지 시간의 블로킹 합 — 창의 길이로 나눠 밀도로 비교한다.
  let inWin = 0
  let outWin = 0
  for (const [t, ms] of real) (near(t) === null ? (outWin += ms) : (inWin += ms))
  const winTotal = ticks.length * (WIN_AFTER + 30)
  const restTotal = Math.max(1, windowMs - winTotal)
  return {
    windowMs,
    ticks: ticks.length,
    longtask: {
      count: lt.length,
      totalMs: Math.round(sum(lt.map((e) => e.d))),
      maxMs: lt.length ? Math.max(...lt.map((e) => e.d)) : 0,
      p50: pct(lt.map((e) => e.d), 50),
      nearTick: hit.length,
      nearTickOffsetsMs: hit.map((e) => e.dt),
      entries: ltNear.slice(0, 60)
    },
    blocking: {
      baselineMs: baseline, // offscreen 프레임 정렬 상수 — 아래 숫자는 전부 이걸 뺀 값이다
      rawTotalMs: Math.round(blocked),
      totalMs: Math.round(blockedReal),
      pctOfWindow: Math.round((blockedReal / windowMs) * 1000) / 10,
      count: real.length,
      maxMs: real.length ? Math.round(Math.max(...real.map((b) => b[1])) * 10) / 10 : 0,
      p95: pct(real.map((b) => b[1]), 95),
      inTickWindowMs: Math.round(inWin),
      outTickWindowMs: Math.round(outWin),
      // 밀도비 — 1 이면 틱 창이 나머지 시간과 똑같이 한가하다는 뜻(= 텔레메트리 무죄).
      densityRatio: Math.round(((inWin / winTotal) / (outWin / restTotal || 1e-9)) * 100) / 100
    },
    sampler: {
      iterations: raw.sampler.iter,
      // 5ms×횟수가 창 길이에 못 미치면 타이머가 조여진 것이다 — 그러면 위 숫자를 믿으면 안 된다.
      coveragePct: Math.round(((raw.sampler.iter * raw.sampler.step) / windowMs) * 1000) / 10
    },
    commits: {
      count: raw.commits.length,
      totalActualMs: Math.round(sum(raw.commits.map((c) => c.dur)) * 10) / 10,
      perTick: ticks.length ? Math.round((raw.commits.length / ticks.length) * 100) / 100 : null,
      nearTick: raw.commits.filter((c) => near(c.t) !== null).length,
      hookCommitsTotal: raw.hook.commits
    },
    components: Object.entries(raw.comps)
      .map(([name, v]) => ({ name, renders: v.r, selfMs: Math.round(v.self * 100) / 100, actualMs: Math.round(v.act * 100) / 100 }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 40)
  }
}

/** 키 하나의 왕복. sent → 렌더러 keydown → session:input(main) → pty 에코. */
function analyzeKeys(raw) {
  const out = []
  const keys = raw.keys
  for (let i = 0; i < LOG.sent.length; i += 1) {
    const s = LOG.sent[i]
    const nextSent = LOG.sent[i + 1] ? LOG.sent[i + 1].t : Infinity
    const kd = keys.find((k) => k.t >= s.t - 2 && k.t < nextSent)
    const ipc = LOG.ipcIn.find((x) => x.t >= s.t - 2 && x.t < nextSent)
    const echo = ipc ? LOG.ptyOut.find((x) => x.t >= ipc.t) : null
    const draw = echo ? raw.draws.find((d) => d >= echo.t) : null
    const paint = echo ? LOG.paints.find((d) => d >= echo.t) : null
    out.push({
      ch: s.ch,
      burst: s.burst,
      sent: s.t,
      toKeydownMs: kd ? Math.round((kd.t - s.t) * 10) / 10 : null,
      // 캡처→버블 = 앱(xterm 포함)이 이 keydown 을 처리하는 데 쓴 시간.
      handleMs: kd && kd.out ? Math.round((kd.out - kd.t) * 10) / 10 : null,
      toIpcMs: ipc ? ipc.t - s.t : null,
      toEchoMs: echo ? echo.t - s.t : null,
      toDrawMs: draw ? Math.round((draw - s.t) * 10) / 10 : null,
      toPaintMs: paint ? paint - s.t : null
    })
  }
  const g = (f) => out.map(f).filter((v) => typeof v === 'number')
  return {
    n: out.length,
    matched: { keydown: g((o) => o.toKeydownMs).length, ipc: g((o) => o.toIpcMs).length, echo: g((o) => o.toEchoMs).length, draw: g((o) => o.toDrawMs).length, paint: g((o) => o.toPaintMs).length },
    keydown: { p50: pct(g((o) => o.toKeydownMs), 50), p95: pct(g((o) => o.toKeydownMs), 95), max: Math.max(0, ...g((o) => o.toKeydownMs)) },
    handle: { n: g((o) => o.handleMs).length, p50: pct(g((o) => o.handleMs), 50), p95: pct(g((o) => o.handleMs), 95), max: Math.max(0, ...g((o) => o.handleMs)) },
    ipc: { p50: pct(g((o) => o.toIpcMs), 50), p95: pct(g((o) => o.toIpcMs), 95), max: Math.max(0, ...g((o) => o.toIpcMs)) },
    echo: { p50: pct(g((o) => o.toEchoMs), 50), p95: pct(g((o) => o.toEchoMs), 95), max: Math.max(0, ...g((o) => o.toEchoMs)) },
    draw: { p50: pct(g((o) => o.toDrawMs), 50), p95: pct(g((o) => o.toDrawMs), 95), max: Math.max(0, ...g((o) => o.toDrawMs)) },
    paint: { p50: pct(g((o) => o.toPaintMs), 50), p95: pct(g((o) => o.toPaintMs), 95), max: Math.max(0, ...g((o) => o.toPaintMs)) },
    perBurst: ['slow', 'fast', 'bs'].map((b) => {
      const r = out.filter((o) => o.burst === b)
      const e = r.map((o) => o.toEchoMs).filter((v) => typeof v === 'number')
      const d = r.map((o) => o.toDrawMs).filter((v) => typeof v === 'number')
      return { burst: b, n: r.length, echoP50: pct(e, 50), echoP95: pct(e, 95), echoMax: Math.max(0, ...e), drawP50: pct(d, 50), drawP95: pct(d, 95) }
    }),
    rows: out
  }
}

// ── 타이핑 ──────────────────────────────────────────────────────────────────
// w1c-screenshot.cjs 와 같은 방식 — Chromium 입력 파이프라인을 거쳐야 xterm 이 진짜 타이핑으로
// 받는다(합성 KeyboardEvent 로는 재현되지 않는다).
function sendChar(win, ch, burst) {
  LOG.sent.push({ ch, t: Date.now(), burst })
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
  win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
}
function sendBackspace(win) {
  LOG.sent.push({ ch: 'BS', t: Date.now(), burst: 'bs' })
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
}

async function typingPhase(win, stage) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  // ① 사람 속도(120ms 간격 ≈ 8타/초) 20자
  stage('typing: slow x20')
  for (let i = 0; i < 20; i += 1) { sendChar(win, letters[i % 26], 'slow'); await wait(120) }
  await wait(1200)
  // ② 빠른 연타(간격 15ms) 30자
  stage('typing: fast x30')
  for (let i = 0; i < 30; i += 1) { sendChar(win, letters[i % 26], 'fast'); await wait(15) }
  await wait(1500)
  // ③ 백스페이스 연타 — 제보의 "뚝뚝". 위에서 50자를 넣었으니 지울 것이 있다.
  stage('typing: backspace x40')
  for (let i = 0; i < 40; i += 1) { sendBackspace(win); await wait(45) }
  await wait(1200)
  stage('typing: done')
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const js = (win, code) => win.webContents.executeJavaScript(code)
const T_BOOT = Date.now()
// 🔴 파일에도 **동기로** 적는다. 파이프로 리다이렉트하면 stdout 이 블록 버퍼링이라 프로세스가
// 비정상 종료하면 그때까지 찍은 것이 통째로 사라진다(실측: 타이핑 판이 exit 3 으로 죽는데
// 로그가 0바이트였다 — 어디서 죽었는지 알 길이 없었다).
const TRACE = join(REPORTDIR, CFG.tag + '.trace.log')
try { writeFileSync(TRACE, '') } catch {}
const stage = (s) => {
  const line = `  [${String(Date.now() - T_BOOT).padStart(6)}ms] ${s}`
  console.log(line)
  try { appendFileSync(TRACE, line + '\n') } catch {}
}

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
      preload: join(OUTDIR, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: true, // 🔴 화면 밖 렌더
      // 숨은 창의 타이머가 조여지면 5ms 샘플러가 거짓말을 한다. 실기(보이는 창)와 같게 맞춘다.
      backgroundThrottling: false
    }
  })

  // offscreen 이 프레임을 실제로 내놓은 시각. 렌더러 안에서 GL 호출을 훔쳐보는 것보다 이쪽이
  // **합성까지 끝난** 신호다. ⚠️ offscreen 의 합성 경로는 실기와 다르다 — 절대값을 사람이 느끼는
  // 지연으로 읽으면 안 된다(보고서 "못 보는 것"에 적는다).
  win.webContents.on('paint', () => { if (LOG.paints.length < 20000) LOG.paints.push(Date.now()) })

  const src = '(' + probe.toString() + ')(' + JSON.stringify({ installHook: CFG.profile }) + ')'
  // 🔴 CDP 는 **모든 판에 똑같이** 붙인다. 붙이고 안 붙이고를 판마다 다르게 하면 판끼리 비교가 안 된다
  //   (그 오버헤드는 모든 판에 같은 크기로 실린다 — 비교는 성립하고 절대값만 조금 크다).
  // 🔴 렌더러 프로세스가 **생긴 뒤에** 붙여야 한다. 첫 항해 전에 Page.enable 을 부르면 영영
  // 안 돌아온다(실측: 180초 타임아웃까지 그대로 매달렸다) — 대상 프로세스가 아직 없기 때문이다.
  // about:blank 를 한 번 띄워 프로세스를 만들고, 그다음에 붙인다.
  // addScriptToEvaluateOnNewDocument 는 **대상 단위** 설정이라 이후 항해에도 그대로 산다.
  await win.loadURL('about:blank')
  const dbg = win.webContents.debugger
  stage('debugger.attach')
  dbg.attach('1.3')
  const cdp = true
  await dbg.sendCommand('Page.enable')
  stage('Page.enable')
  if (CFG.profile) {
    // 훅은 페이지 스크립트보다 먼저 깔려야 한다 — CDP 로만 가능하다(preload 는 isolated world 라
    // contextBridge 로 파이버 트리를 못 건넨다).
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: src })
  }
  await dbg.sendCommand('Profiler.enable')
  const SAMPLE_US = 500
  await dbg.sendCommand('Profiler.setSamplingInterval', { interval: SAMPLE_US })
  stage('Profiler ready')

  await win.loadFile(join(OUTDIR, 'renderer', 'index.html'))
  stage('loadFile done')
  await wait(2500)
  if (!CFG.profile) await js(win, src)
  stage('probe injected') // 롱태스크·샘플러는 로드 뒤에 깔아도 된다(훅과 달리)

  // 환영 모달이 어쩌다 떠 있으면 닫는다(araWelcomeSeen:true 라 보통은 없다).
  await js(win, `document.querySelector('.modal.welcome .wc-ft button')?.click(); document.querySelector('.wc-ft .btn.sec')?.click(); 1`)
  await wait(400)

  // ── 세션 만들기. 첫 세션은 SSH 로 편입한다 ──
  // 🔴 왜 SSH 인가: Shell.tsx:445 `useTelemetry(activeId, activeSession?.type==='ssh')` — isSsh 가
  // true 여야 틱마다 refreshForwards() 까지 돈다(setPorts·setStats·setForwards = 한 틱에 setState 셋).
  // 로컬 세션으로 재면 실사용 최악값을 못 본다.
  const ids = []
  for (let i = 0; i < CFG.sessions; i += 1) {
    const id = await js(win, `(async () => {
      const { id } = await window.ev.session.create({ type: 'local', title: '서버${i + 1}', serverKey: '서버${i + 1}', profileId: 'p1' })
      window.__evAdopt(id, '서버${i + 1}', '서버${i + 1}', 'ssh')
      await new Promise(r => setTimeout(r, 400))
      return id
    })()`)
    ids.push(id)
    await wait(900)
  }
  await wait(2500) // 셸 배너·프롬프트가 다 흐르고 조용해질 때까지

  stage('sessions ready')
  const before = await js(win, `(${census.toString()})()`)

  // 하단 패널을 [포트 모니터] 로 — 첫 세션이 생기면 앱이 저절로 연다. 확인만 하고 없으면 연다.
  if (!before.bottomOpen) {
    await js(win, `document.querySelector('[data-activity="bottombar"]')?.click(); 1`)
    await wait(600)
  }
  if (CFG.tabs) {
    for (const id of ['sys', 'ps', 'svc']) {
      await js(win, `document.querySelector('.bp-tab[data-bottom="${id}"]')?.click(); 1`)
      await wait(600)
    }
  }
  await js(win, `document.querySelector('.bp-tab[data-bottom="monitor"]')?.click(); 1`)
  await wait(600)

  // 터미널에 포커스를 준다(타이핑 판에서 필요).
  await js(win, `document.querySelector('.term-pane .xterm-helper-textarea')?.focus(); 1`)
  await wait(300)

  // ── 측정 창 ────────────────────────────────────────────────────────────
  const activeId = ids[ids.length - 1] // 마지막으로 만든 세션이 활성이다

  // 시각 맞추기 마커. **이름 있는** 30ms 바쁜 루프라 프로파일에서 그 함수를 찾을 수 있다.
  await js(win, `window.__perfSync = function ${SYNC_FN}(){ const t = performance.now(); while (performance.now() - t < 30) {} }; 1`)
  stage('Profiler.start')
  await dbg.sendCommand('Profiler.start')
  const sync = { intervalUs: SAMPLE_US, startEpoch: 0, endEpoch: 0 }
  // 마커 루프가 **실제로 시작한** 시각을 IPC 왕복 밖에서 조인다: 보내기 직전 t 와
  // (돌아온 t − 루프 30ms) 의 중간을 쓴다. 둘의 차이가 이 시각 맞추기의 오차 상한이다.
  const MARK_MS = 30
  const markAt = async () => {
    const a = Date.now()
    await js(win, `window.__perfSync(); 1`)
    const b = Date.now() - MARK_MS
    return { at: Math.round((a + b) / 2), spreadMs: b - a }
  }
  const m0 = await markAt()
  sync.startEpoch = m0.at
  sync.startSpreadMs = m0.spreadMs

  // 마커가 만든 롱태스크는 측정 대상이 아니다 — 여기서 지운다.
  await js(win, `window.__perf.reset(); window.__perf.startSampler(); 1`)
  const t0 = Date.now()
  stage('measurement window open')

  let timer = null
  if (CFG.telemetry) {
    const tick = () => {
      const wc = getWc()
      if (!wc) return
      LOG.ticks.push(Date.now())
      wc.send('telemetry:data:' + activeId, {
        sessionId: activeId,
        // 매번 새 배열·새 객체 — 제품의 IPC 직렬화가 하는 그대로다(참조가 늘 바뀐다).
        ports: PORTS.map((p) => ({ ...p })),
        stats: {
          cpuPct: 20 + Math.round(Math.random() * 30),
          memUsedKb: 6_000_000 + Math.round(Math.random() * 500_000),
          memTotalKb: 16_000_000
        }
      })
    }
    tick()
    timer = setInterval(tick, TELEMETRY_MS)
  }

  if (CFG.typing) {
    await wait(2000)
    await typingPhase(win, stage)
    const left = CFG.dur - (Date.now() - t0)
    if (left > 0) await wait(left)
  } else {
    await wait(CFG.dur)
  }

  if (timer) clearInterval(timer)
  await js(win, `window.__perf.stopSampler(); 1`)
  await wait(300)
  const windowMs = Date.now() - t0
  const raw = await js(win, `window.__perf.dump()`)

  // 끝 마커 → 프로파일러 정지. 순서가 중요하다: dump 를 먼저 해야 마커가 롱태스크에 안 섞인다.
  const m1 = await markAt()
  sync.endEpoch = m1.at
  sync.endSpreadMs = m1.spreadMs
  stage('Profiler.stop')
  const prof = await dbg.sendCommand('Profiler.stop')
  stage('Profiler.stop done')
  const cpu = analyzeProfile(prof.profile, sync, LOG.ticks, t0, windowMs)

  // ── 측정 창 밖: 하단 탭 마운트 유지 확인(감사 지적 ②) ────────────────────
  const tabsTried = ['sys', 'ps', 'svc']
  for (const id of tabsTried) {
    await js(win, `document.querySelector('.bp-tab[data-bottom="${id}"]')?.click(); 1`)
    await wait(500)
  }
  await js(win, `document.querySelector('.bp-tab[data-bottom="monitor"]')?.click(); 1`)
  await wait(500)
  const afterTabs = await js(win, `(${census.toString()})()`)
  await js(win, `document.querySelector('.bottom-panel .bp-close')?.click(); 1`)
  await wait(600)
  const afterClose = await js(win, `(${census.toString()})()`)

  const report = {
    at: new Date().toISOString(),
    cfg: CFG,
    build: OUTDIR.endsWith('out-perf') ? 'out-perf (react-dom/profiling · 비압축)' : 'out (제품 빌드)',
    cdp,
    sessions: ids.length,
    census: { before, afterTabs, afterClose, tabsTried },
    cpu,
    analysis: analyze(raw, LOG.ticks, windowMs),
    keys: CFG.typing ? analyzeKeys(raw) : null,
    ticks: LOG.ticks,
    paints: { n: LOG.paints.length, perSec: Math.round((LOG.paints.length / (windowMs / 1000)) * 10) / 10 },
    raw: { longtasks: raw.longtasks, commits: raw.commits.slice(0, 400), comps: raw.comps, blocks: raw.blocks.slice(0, 3000), drawKind: raw.drawKind, err: raw.err, hook: raw.hook, vis: raw.vis }
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 1))

  const A = report.analysis
  const L = (s) => console.log(s)
  L('─'.repeat(78))
  L(`[${CFG.tag}] 세션 ${ids.length} · 텔레메트리 ${CFG.telemetry ? 'ON(2.5s)' : 'OFF'} · 타이핑 ${CFG.typing ? 'ON' : 'OFF'} · ${report.build}`)
  L(`창 ${A.windowMs}ms · 틱 ${A.ticks}회 · 샘플러 커버리지 ${A.sampler.coveragePct}% (${A.sampler.iterations}회) · 문서 ${raw.vis}`)
  L(`① 롱태스크  ${A.longtask.count}회 · 합 ${A.longtask.totalMs}ms · 최장 ${A.longtask.maxMs}ms · 중앙 ${A.longtask.p50}ms · 틱과 겹침 ${A.longtask.nearTick}/${A.longtask.count}`)
  if (cpu.ok) {
    L(`①' CPU     바쁨 ${cpu.cpuBusyMs}ms (창의 ${cpu.cpuBusyPct}%) · 표본 ${cpu.samples} · 커버리지 ${cpu.coveragePct}% · 시각오차 ${cpu.calib && cpu.calib.driftMs}ms`)
    L(`   연속 바쁜 구간 ${cpu.busyRuns.count}개 · 최장 ${cpu.busyRuns.maxMs}ms · p95 ${cpu.busyRuns.p95}ms · 20ms↑ ${cpu.busyRuns.over20}개 · 50ms↑ ${cpu.busyRuns.over50}개`)
    L(`   🔴 틱 상대 CPU(ms/50ms칸): ${cpu.tickRelHistogramMs.map((b) => b.ms).join(' ')}`)
    L(`      틱창(0~${WIN_AFTER}ms) ${cpu.tickWindow.inMs}ms / 나머지 ${cpu.tickWindow.outMs}ms · **밀도비 ${cpu.tickWindow.densityRatio}배**`)
    L(`      틱 하나하나(ms): ${cpu.perTickBusyMs.join(' ')}`)
    L('   자기시간 상위:')
    for (const s of cpu.topSelf.slice(0, 12)) L(`     ${String(s.ms).padStart(6)}ms  ${s.name}`)
  } else {
    L(`①' CPU     ⚪ 못 쟀다: ${cpu.why}`)
  }
  L(`①'' 샘플러  기준선 ${A.blocking.baselineMs}ms(프레임 정렬) 뺀 뒤: 합 ${A.blocking.totalMs}ms (창의 ${A.blocking.pctOfWindow}%) · ${A.blocking.count}회 · 최장 ${A.blocking.maxMs}ms · p95 ${A.blocking.p95}ms`)
  L(`   틱창 안 ${A.blocking.inTickWindowMs}ms / 밖 ${A.blocking.outTickWindowMs}ms · 밀도비 ${A.blocking.densityRatio}배`)
  L(`② 커밋      ${A.commits.count}회 (훅 총 ${A.commits.hookCommitsTotal}) · 틱당 ${A.commits.perTick} · 틱과 겹침 ${A.commits.nearTick} · actualDuration 합 ${A.commits.totalActualMs}ms`)
  if (A.components.length) {
    L('   컴포넌트 상위(자기시간 ms · 렌더 횟수):')
    for (const c of A.components.slice(0, 15)) L(`     ${String(c.selfMs).padStart(8)}  ${String(c.renders).padStart(5)}회  ${c.name}`)
  }
  if (report.keys) {
    const K = report.keys
    L(`③ 키→…      n=${K.n} · 맞춘 것 keydown ${K.matched.keydown} / ipc ${K.matched.ipc} / echo ${K.matched.echo} / draw ${K.matched.draw}`)
    L(`   keydown p50 ${K.keydown.p50} p95 ${K.keydown.p95} max ${K.keydown.max} ms   (sendInputEvent → 렌더러가 키를 받음)`)
    L(`   handle  p50 ${K.handle.p50} p95 ${K.handle.p95} max ${K.handle.max} ms   (캡처→버블 = 앱이 그 키를 처리한 시간, n=${K.handle.n})`)
    L(`   ipc     p50 ${K.ipc.p50} p95 ${K.ipc.p95} max ${K.ipc.max} ms`)
    L(`   echo    p50 ${K.echo.p50} p95 ${K.echo.p95} max ${K.echo.max} ms`)
    L(`   draw    p50 ${K.draw.p50} p95 ${K.draw.p95} max ${K.draw.max} ms   (렌더러가 그리기 호출을 한 시각)`)
    L(`   paint   p50 ${K.paint.p50} p95 ${K.paint.p95} max ${K.paint.max} ms   (offscreen 이 프레임을 내놓은 시각 · n=${K.matched.paint} · ⚠️ 실기 합성과 다르다)`)
    for (const b of K.perBurst) L(`   [${b.burst}] n=${b.n} echo p50 ${b.echoP50} p95 ${b.echoP95} max ${b.echoMax} · draw p50 ${b.drawP50}`)
  }
  L(`   그리기 경로: ${JSON.stringify(raw.drawKind)} · xterm 캔버스 ${JSON.stringify(before.xtermCanvasCtx)} / dom rows ${before.xtermRows} · offscreen paint ${report.paints.n}회(${report.paints.perSec}/초)`)
  L(`   하단 pane: 측정전 ${before.bpPanes} → 탭 넷 순회 후 ${afterTabs.bpPanes} → 닫은 뒤 ${afterClose.bpPanes} · DOM 노드 ${before.domNodes}→${afterTabs.domNodes}`)
  if (raw.err.length) L('   ⚠ 탐침 오류: ' + JSON.stringify(raw.err))
  L('원자료: ' + REPORT)
  L('─'.repeat(78))

  if (cdp) { try { win.webContents.debugger.detach() } catch {} }
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => {
  console.log('perf-probe timeout')
  app.exit(1)
}, 180000)
