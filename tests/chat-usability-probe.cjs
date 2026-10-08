// 아라 채팅 — 가로 스크롤 되감김·선택 끊김 **계측** 하네스(CHAT-usability ②③).
//
// 이 파일은 고치는 물건이 아니라 **재는 물건**이다. 제보는 *"가로 스크롤이 생길 때 계속 처음으로
// 돌아간다"* 였고, 지시서는 "주기를 재라 — 2.5초면 텔레메트리 리렌더이고 #190 과 같은 뿌리다"였다.
// 그래서 여기서 보는 것은 세 값뿐이다:
//   ① 코드블록(`.md-pre`)의 scrollLeft 가 틱을 넘겨 살아남는가
//   ② 그 `<pre>` **DOM 노드 자체가 같은 객체인가**(expando 로 확인 — 바뀌었으면 리마운트다)
//   ③ 드래그 선택(`getSelection()`)이 틱을 넘겨 살아남는가
//
// ②가 핵심이다. scrollLeft 는 "누가 0으로 되돌렸다"의 증거가 아니라 **노드가 새로 태어났다**의
// 증거일 수 있고, 둘은 고치는 자리가 다르다(전자는 스크롤 코드, 후자는 렌더 코드).
//
// 베낀 곳: tests/manual-shots.cjs(offscreen + 최소 IPC + __evAdopt 로 세션 편입 + telemetry:data 주입).
// 🔴 창을 안 띄운다(준영님이 그 PC 를 쓰고 계신다) · 실제 서버·실제 claude 를 띄우지 않는다.
//
// 돌리는 법: npm run build && npx electron tests/chat-usability-probe.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let getWc = () => null
/** 마지막으로 클립보드에 쓰인 글자(아래 clipboard:writeText 핸들러가 채운다). */
let lastClip = null

const PROFILE = {
  id: 'p1',
  name: '배포서버',
  host: '192.0.2.15',
  port: 22,
  username: 'deploy',
  group: '운영',
  auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
}

function wire() {
  ipcMain.handle('app:getVersion', () => require(join(ROOT, 'package.json')).version)
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [PROFILE])
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
      // 🔴 true — 환영 모달이 뜨면 아라 패널을 통째로 덮어 계측할 것이 안 보인다.
      araWelcomeSeen: true
    }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  for (const ch of ['ui:setPrefs', 'ui:setGroups', 'ui:setFont', 'ui:setSidebar']) ipcMain.handle(ch, () => ({ ok: true }))
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))

  // 세션은 **화면만** 필요하다(telemetry 구독이 붙을 activeId 하나). pty 를 띄우지 않는다.
  ipcMain.handle('session:create', () => ({ id: 'loc-probe' }))
  ipcMain.handle('session:attach', () => ({ backlog: new Uint8Array(0) }))
  for (const ch of ['session:rename', 'session:resize', 'session:destroy']) ipcMain.handle(ch, () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:list', () => [])
  for (const ch of ['session:input', 'session:pause', 'session:resume']) ipcMain.on(ch, () => {})

  ipcMain.handle('history:load', () => ({ entries: [] }))
  ipcMain.handle('history:append', () => ({ ok: true }))
  // 폴링은 안 돈다 — 틱은 이 파일이 **원하는 순간에** 직접 민다(주기를 재려면 우리가 시계를 쥐어야 한다).
  for (const ch of ['telemetry:start', 'telemetry:stop', 'telemetry:refresh']) ipcMain.handle(ch, () => ({ ok: true }))
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))
  ipcMain.handle('mcp:getState', () => ({ enabled: false, port: 0, hasToken: false, connected: 0, sessions: [], handedBack: false }))
  ipcMain.handle('mcp:pending', () => ({ items: [] }))
  ipcMain.handle('update:get', () => ({ status: 'idle' }))
  ipcMain.handle('update:check', () => ({ status: 'idle' }))
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/', parent: null, entries: [] }))
  ipcMain.handle('fs:list', () => ({ ok: true, path: '/', entries: [] }))
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
  ipcMain.handle('fs:drives', () => ({ drives: [] }))
  ipcMain.handle('agent:state', () => null)
  ipcMain.handle('aisession:save', () => ({ ok: true }))
  ipcMain.handle('ai:getState', () => ({ hasKey: true, provider: 'anthropic', model: '', turns: [], streaming: false, usage: { input: 0, output: 0 }, droppedTurns: 0 }))

  // ── 아라 — 진짜 claude 를 안 띄운다. 사건은 이 파일이 밀어 넣는다 ──
  ipcMain.handle('ara:open', () => ({ ok: true }))
  ipcMain.handle('ara:chats', () => ({ items: [] }))
  for (const ch of ['ara:send', 'ara:planMode', 'ara:model', 'ara:interrupt', 'ara:close', 'ara:approvePlan']) ipcMain.handle(ch, () => ({ ok: true }))
  ipcMain.handle('ara:state', () => ({ open: false }))
  // 🔴 복사된 글자는 **여기서** 잡는다. 렌더러에서 `window.ev.clipboard.writeText` 를 갈아 끼우려
  // 했더니 값이 안 잡혔다 — contextBridge 가 노출한 객체는 얼어 있어 대입이 조용히 실패한다.
  // 클립보드 쓰기는 어차피 main 을 거치게 되어 있으니(store/clipboardWrite.ts) 그 끝에서 받는다.
  ipcMain.handle('clipboard:writeText', (_e, text) => {
    lastClip = text
    return { ok: true }
  })
  ipcMain.handle('clipboard:readText', () => '')
}

const js = (win, code) => win.webContents.executeJavaScript(code)
const araEvent = (e) => getWc()?.send('ara:event', e)
const tick = (n) =>
  getWc()?.send('telemetry:data:loc-probe', {
    sessionId: 'loc-probe',
    ports: [{ proto: 'tcp', port: 22, pid: 800 + n, process: 'sshd' }],
    stats: { cpuPct: 30 + (n % 7), memUsedKb: 6_100_000, memTotalKb: 16_000_000 }
  })

// 좁은 레일에서 반드시 가로로 넘치는 한 줄 — 실제 제보 상황(긴 명령)과 같은 모양.
const LONG_CMD =
  'docker run --rm -it -v /srv/배포/releases:/data -e NODE_OPTIONS=--max-old-space-size=4096 --network host ghcr.io/verygood/deploy-runner:2026.09 bash -lc "npm ci && npm run build && rsync -az --delete dist/ deploy@192.0.2.15:/srv/배포/current/"'

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
    backgroundColor: '#171618',
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

  // 세션 하나 — telemetry 구독이 붙을 activeId 를 만든다(SSH 로 편입해야 Shell 이 그 경로를 탄다).
  await js(
    win,
    `(async () => {
      const { id } = await window.ev.session.create({ type: 'local', title: '배포서버', serverKey: '배포서버', profileId: 'p1' })
      window.__evAdopt(id, '배포서버', '배포서버', 'ssh')
      return id
    })()`
  )
  await wait(600)

  // 아라 레일을 연다 → 'opened' 를 밀어 넣어 idle 로 만든다.
  await js(win, `document.querySelector('.activity-bar .act-item[data-activity="ai"]')?.click()`)
  await wait(400)
  araEvent({ t: 'opened', cwd: 'D:\\AI\\OFA', withMcp: false, engine: 'cli' })
  await wait(300)
  araEvent({ t: 'text', text: '배포는 이렇게 돌리시면 됩니다.\n\n```bash\n' + LONG_CMD + '\n```\n\n끝나면 로그를 확인하세요.' })
  araEvent({ t: 'turn', costUsd: 0.01, ms: 100, turns: 1, text: '' })
  await wait(600)

  results.panel = await js(win, `!!document.querySelector('.ara-panel')`)
  results.pre = await js(win, `!!document.querySelector('.ara-panel .md-pre')`)
  if (!results.pre) {
    console.log('결과:', JSON.stringify(results, null, 1))
    app.exit(1)
    return
  }

  // ── 계측 ①②: 스크롤을 오른쪽 끝으로 밀고, 그 <pre> 노드에 도장을 찍는다 ──────────────
  const setup = await js(
    win,
    `(() => {
      const pre = document.querySelector('.ara-panel .md-pre')
      pre.scrollLeft = 9999
      pre.__probeStamp = 'A'
      window.__probeSeen = 0
      return { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, scrollLeft: pre.scrollLeft }
    })()`
  )
  results.setup = setup
  if (setup.scrollWidth <= setup.clientWidth) {
    results.note = '가로로 안 넘쳤다 — 패널 폭이 넓거나 줄이 짧다. 계측이 공허하다.'
    console.log('결과:', JSON.stringify(results, null, 1))
    app.exit(1)
    return
  }

  // ── 계측 ③: 그 코드블록 안 글자를 드래그 선택한 것과 같은 상태로 만든다 ──────────────
  await js(
    win,
    `(() => {
      const code = document.querySelector('.ara-panel .md-pre code') || document.querySelector('.ara-panel .md-pre')
      const node = code.firstChild
      const r = document.createRange()
      r.setStart(node, 0)
      r.setEnd(node, Math.min(40, node.length))
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      return s.toString().length
    })()`
  )
  results.selBefore = await js(win, `window.getSelection().toString().length`)

  // `<p>` 에도 같은 도장을 찍는다 — **무엇이 살아남고 무엇이 죽는지**를 갈라야 고칠 자리가 정해진다.
  // md.tsx 가 재정의하는 것은 code·pre·table·a·blockquote·hr·img 뿐이고 `p` 는 기본(문자열 타입)이다.
  // p 는 살고 pre 만 죽으면 범인은 **컴포넌트 함수의 정체성**이지 트리 전체의 언마운트가 아니다.
  await js(win, `(() => { const p = document.querySelector('.ara-panel .ara-ai .md p'); if (p) p.__probeStamp = 'P'; return !!p })()`)

  const read = () =>
    js(
      win,
      `(() => {
        const pre = document.querySelector('.ara-panel .md-pre')
        const p = document.querySelector('.ara-panel .ara-ai .md p')
        return {
          scrollLeft: pre ? pre.scrollLeft : -1,
          stamp: pre ? (pre.__probeStamp ?? null) : null,
          pStamp: p ? (p.__probeStamp ?? null) : null,
          sel: window.getSelection().toString().length
        }
      })()`
    )

  results.beforeTick = await read()

  // 텔레메트리 틱 **한 번**. 폴링 주기(2.5초)와 같은 사건이지만 우리가 시계를 쥐고 한 번만 민다 —
  // 시간을 기다려서 재면 "무엇이 되감았는지"가 아니라 "언젠가 되감겼다"만 남는다.
  tick(1)
  await wait(250)
  results.afterOneTick = await read()

  // 아무 일도 안 하고 같은 시간을 흘려보낸다 — 되감김이 **틱 때문**이라는 대조군이다.
  await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); p.scrollLeft = 9999; p.__probeStamp = 'B'; return p.scrollLeft })()`)
  await wait(1200)
  results.afterIdle = await read()

  // 틱 세 번을 2.5초 간격으로 — 실제 폴링과 같은 박자에서 몇 번 되감기는지.
  await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); p.scrollLeft = 9999; p.__probeStamp = 'C'; window.__rewinds = 0; p.addEventListener('scroll', () => { if (p.scrollLeft === 0) window.__rewinds++ }); return p.scrollLeft })()`)
  const marks = []
  for (let i = 0; i < 3; i++) {
    tick(10 + i)
    await wait(250)
    marks.push(await read())
    await wait(2250)
  }
  results.perTick = marks
  results.rewinds = await js(win, `window.__rewinds ?? null`)

  // ── ③ 갈라 보기 C: 가장자리 자동 스크롤이 있는가 ────────────────────────────
  // 준영님: *"드래그할때 우측을 끌면 스크롤도 자동으로 갔으면 좋겠어. 자동으로 안가니까 내가
  // 쉬프트 누르고 휠내리면서 드래그했어."*
  //
  // 🔴 **먼저 크로미움이 이미 해 주는지 본다.** 텍스트 선택 중 가장자리 자동 스크롤은 브라우저
  // 기본 기능이라, 되는데 우리가 또 만들면 두 벌이 서로 밀며 튄다. 그래서 진짜 마우스 사건으로
  // 끈다 — `sendInputEvent` 는 크로미움 입력 파이프라인을 거치므로 기본 동작이 걸리면 걸린다
  // (합성 MouseEvent 로는 선택 드래그 자체가 재현되지 않는다 — w1c-screenshot.cjs 가 키에서 같은 이유).
  const drag = await (async () => {
    await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); p.scrollLeft = 0; window.getSelection().removeAllRanges(); return 0 })()`)
    const r = await js(
      win,
      `(() => { const b = document.querySelector('.ara-panel .md-pre').getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, height: b.height } })()`
    )
    const y = Math.round(r.top + r.height / 2)
    const move = (x) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y, button: 'left', buttons: 1 })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.left + 20), y, button: 'left', clickCount: 1 })
    // 상자 안에서 오른쪽 끝까지 — 여기까지는 자동 스크롤 없이도 선택이 는다.
    for (let x = r.left + 40; x < r.right - 8; x += 40) move(x)
    await wait(120)
    const atEdge = await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); return { scrollLeft: p.scrollLeft, sel: window.getSelection().toString().length } })()`)

    // ① 가장자리 **밖**으로 나가서 가만히 있는다 — 크로미움 자동 스크롤 타이머가 있으면 여기서 흐른다.
    move(r.right + 60)
    await wait(700)
    const held = await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); return { scrollLeft: p.scrollLeft, sel: window.getSelection().toString().length } })()`)

    // ② 밖에서 계속 흔든다 — 타이머가 아니라 "사건이 올 때만" 도는 구현이면 여기서 흐른다.
    for (let i = 0; i < 12; i++) {
      move(r.right + 60 + (i % 2))
      await wait(50)
    }
    const jiggled = await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); return { scrollLeft: p.scrollLeft, sel: window.getSelection().toString().length } })()`)

    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.right + 60), y, button: 'left', clickCount: 1 })
    await wait(150)
    const afterUp = await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); return { scrollLeft: p.scrollLeft, sel: window.getSelection().toString().length } })()`)
    return { maxScroll: await js(win, `(() => { const p = document.querySelector('.ara-panel .md-pre'); return p.scrollWidth - p.clientWidth })()`), atEdge, held, jiggled, afterUp }
  })()
  results.edgeAutoScroll = drag

  // ── ③ 갈라 보기 A: `user-select` 문제인가 ──────────────────────────────────
  // 지시서는 `.sidebar { user-select:none }`(shell.css:396)을 의심하라고 했다. 아라 패널이 그
  // 아래 있으면 본문이 애초에 안 잡힌다 — 그러면 고칠 자리가 CSS 다. **계산된 값**으로 확인한다
  // (선택자를 눈으로 좇으면 상속·특이도에서 틀린다).
  // 본문 네 갈래를 **전부** 화면에 올려 놓고 잰다(제보 ③: 사람 말·아라 말·코드·도구 줄).
  // 하나라도 없으면 그 줄의 판정이 null 이 되는데, null 은 "선택된다"도 "안 된다"도 아니다.
  araEvent({ t: 'tool', id: 'p1', name: 'Bash', brief: 'docker ps' })
  araEvent({ t: 'toolResult', id: 'p1', ok: true, brief: '컨테이너 3개' })
  araEvent({ t: 'error', message: '안내 줄(.ara-note)을 만들기 위한 가짜 오류' })
  // 🔴 'tool' 은 phase 를 working 으로 올린다 → 보내기 버튼이 꺼져 사람 말(.ara-me)이 안 생긴다.
  // 'turn' 으로 idle 로 되돌린 뒤에 친다(첫 판에 me 가 null 이었던 이유가 정확히 이것이다).
  araEvent({ t: 'turn', costUsd: 0.002, ms: 50, turns: 1, text: '' })
  await wait(200)
  await js(
    win,
    `(() => {
      const ta = document.querySelector('.ara-panel .ara-input')
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '서버 상태 좀 봐 줘')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.ara-panel .ara-send').click()
      return true
    })()`
  )
  await wait(300)
  await js(win, `document.querySelector('.ara-panel .ara-fold .hd')?.click()`)
  await wait(200)

  results.userSelect = await js(
    win,
    `(() => {
      const of = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).userSelect : null }
      return {
        inSidebar: !!document.querySelector('.sidebar .ara-panel'),
        toolLine: of('.ara-panel .ara-fold .in .l'),
        cost: of('.ara-panel .ara-bar .c'),
        panel: of('.ara-panel'),
        ai: of('.ara-panel .ara-ai'),
        me: of('.ara-panel .ara-me'),
        pre: of('.ara-panel .md-pre'),
        note: of('.ara-panel .ara-note'),
        copyBtn: of('.ara-panel .md-copy'),
        headBtn: of('.ara-panel .ara-hd .ara-hist'),
        chip: of('.ara-panel .ara-chip')
      }
    })()`
  )

  // ── ③ 갈라 보기 B: 자동 스크롤이 선택을 깨는가 ─────────────────────────────
  // 끝난 앞 메시지를 잡아 둔 채 **뒤 메시지로 답이 흘러들어오게** 한다(스트리밍). AraChatPanel:246
  // 의 `stick` 이펙트가 매 델타마다 scrollTop 을 바닥으로 끄는데, 그것이 앞선 선택을 지우는지 본다.
  araEvent({ t: 'text', text: '두 번째 답입니다.' })
  await wait(200)
  await js(
    win,
    `(() => {
      const first = document.querySelector('.ara-panel .ara-ai .md p')
      const r = document.createRange()
      r.setStart(first.firstChild, 0)
      r.setEnd(first.firstChild, Math.min(10, first.firstChild.length))
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      return s.toString()
    })()`
  )
  results.streamSelBefore = await js(win, `window.getSelection().toString().length`)
  for (const chunk of [' 이어서', ' 계속', ' 더', ' 끝']) {
    araEvent({ t: 'text', text: chunk })
    await wait(120)
  }
  results.streamScrolledToBottom = await js(
    win,
    `(() => { const b = document.querySelector('.ara-body'); return b.scrollHeight - b.scrollTop - b.clientHeight < 4 })()`
  )
  results.streamSelAfter = await js(win, `window.getSelection().toString().length`)

  // ── ① 복사 버튼 — 있는가 · 무엇을 클립보드로 보내는가(꼬리 개행 포함) ────────
  // ⚠️ 이 검사의 요점은 "버튼이 있다"가 아니라 **끝의 개행을 떼고 보내는가**다. 개행까지 붙여넣으면
  // 터미널이 그 자리에서 실행한다 — 명령을 복사하는 자리라 이게 안전 요구사항이다(insertText 규약).
  lastClip = null
  const rawPre = await js(win, `document.querySelector('.ara-panel .md-pre').textContent`)
  await js(win, `document.querySelector('.ara-panel .md-copy').click()`)
  await wait(300)
  results.copy = {
    btn: true,
    label: await js(win, `document.querySelector('.ara-panel .md-copy').textContent`),
    rawEndsWithNewline: /\n$/.test(rawPre),
    copied: lastClip === null ? null : lastClip.length,
    copiedEndsWithNewline: lastClip === null ? null : /\n$/.test(lastClip),
    copiedIsCommand: lastClip === rawPre.replace(/\n+$/, '')
  }

  // ── ④ 선택 표시 — **살아 있는 토큰 값에서** 대비를 잰다 ─────────────────────
  // 손으로 재서 주석에 적으면 배경 토큰이 하나 늘어난 날 그 수가 조용히 낡는다(scan:magic 이
  // 램프 × 배경 전 조합을 매번 계산하는 것과 같은 이유). ⚠️ 선택 배경은 **합성색**이라
  // scan:magic 의 24조합에 안 든다 — 그 사각지대를 이 하네스가 대신 본다.
  results.selection = await js(
    win,
    `(() => {
      const cs = getComputedStyle(document.documentElement)
      const v = (n) => cs.getPropertyValue(n).trim()
      const num = (s) => s.match(/[\\d.]+/g).map(Number)
      const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
      const lum = ([r, g, b]) =>
        [r, g, b]
          .map((c) => c / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((s, c, i) => s + [0.2126, 0.7152, 0.0722][i] * c, 0)
      const ratio = (a, b) => { const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05) }
      const [sr, sg, sb, sa] = num(v('--sel-bg'))
      const over = (bg) => hex(bg).map((c, i) => Math.round([sr, sg, sb][i] * sa + c * (1 - sa)))
      const fg = hex(v('--text-hi'))
      const out = {}
      for (const name of ['--bg-abyss', '--bg-canvas', '--bg-surface', '--bg-raised', '--bg-overlay', '--bg-terminal']) {
        out[name] = Number(ratio(fg, over(v(name))).toFixed(2))
      }
      const worst = Math.min(...Object.values(out))
      return { selBg: v('--sel-bg'), fg: v('--text-hi'), perSurface: out, worst, passes3_5: worst >= 3.5 }
    })()`
  )
  // 터미널(xterm)과 같은 값을 쓰는가 — 한 앱 안에서 선택이 두 가지로 보이면 안 된다.
  results.selectionMatchesTerminal = await js(
    win,
    `(() => {
      const cs = getComputedStyle(document.documentElement)
      // TerminalPane 은 selectionBackground=--sel-bg · selectionForeground=--text-hi 로 xterm 테마를 만든다.
      const rule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules] } catch { return [] } })
        .find((r) => r.selectorText === '::selection')
      return rule ? rule.style.background + ' / ' + rule.style.color : null
    })()`
  )

  // ── 눈으로도 한 번 — 패널만 잘라 찍는다(🔴 창은 여전히 안 뜬다: show:false + offscreen) ──
  const rect = await js(
    win,
    `(() => { const r = document.querySelector('.ara-panel').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`
  )
  const scale = await js(win, `window.devicePixelRatio`)
  const img = await win.webContents.capturePage()
  const png = img
    .crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) })
    .toPNG()
  require('node:fs').writeFileSync(join(ROOT, 'agent_talk', 'CHAT-usability-screenshot.png'), png)
  results.shotBytes = png.length

  console.log('결과:', JSON.stringify(results, null, 1))
  app.exit(0)
})

setTimeout(() => {
  console.log('chat-usability-probe timeout')
  app.exit(1)
}, 90000)
