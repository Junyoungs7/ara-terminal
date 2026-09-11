// AISESS 하네스 — "세션을 만들었는데 화면에 안 보인다" 부류를 재는 자리 (1.0.8, #196)
//
// 🔴 이 하네스가 못 잡는 것 — **먼저 읽어라. 이게 없으면 통과가 틀린 안심이 된다.**
//  ① **pty 를 안 띄운다. 가짜 세션이다.** `session:create` 가 id 만 돌려준다 — 터미널 내용·xterm·
//     스크롤백·입력·리사이즈를 **한 글자도 검증하지 않는다.** 이 통과가 말하는 것은
//     **"어느 세션이 어느 칸에 붙었나"까지**다. **실기 확인을 대체하지 못한다.**
//  ② **실 main 이 아니다** — `out/main/index.js` 를 안 쓰고 IPC 를 이 파일이 흉내 낸다.
//     세션 매니저·IPC 등록 쪽 회귀는 안 잡힌다.
//  ③ **한 창만 본다** — 떼어낸 창 경로를 안 탄다.
//  ④ **RDP·SSH 실접속을 안 탄다**(`ssh:connect` 는 늘 실패를 돌려준다).
//  ⑤ 세션 id 가 `new-N` 고정 순번이다 — 픽스처를 바꾸면 기대값이 통째로 밀린다.
//
// 왜 vitest 로 못 하나: 이 부류의 위험은 **순서와 타이밍**이다. `layout.ts` 리듀서는 내내 옳았고
// 버그는 그 함수를 **안 부르는** 것이었다 — 케이스를 더해도 안 잡힌다. Playwright e2e 는 창을
// 띄워서 준영님이 그 PC 를 쓰시는 동안 못 돌린다. 그 사이의 구멍을 이것만 본다.
//
// 실적(2026-09-10): 부트 복원 순서에서 **읽기로 낸 결론을 뒤집었고**, 넷이 통과한 빌드에서
// 배경 탭 소멸 회귀를 혼자 잡았고, **1회 통과가 경합이었음**을 3회 반복이 드러냈다.
//
// 언제 돌리나: **수동.** 배포 전, 그리고 세션·부팅·복원을 건드린 라운드. `npm run probe:aisess`.
//
// 베낀 곳: tests/manual-shots.cjs (실 out/preload + out/renderer 를 show:false + offscreen:true 로
// 띄우고 최소 IPC 를 무는 배선). 🔴 창을 띄우지 않는다.
//
// 재현하는 상태: **재시작 직후**.
//  · workspace 스냅샷에 로컬 세션 2개 + 1칸 레이아웃(칸에는 A) + 작업대(aiSessions) 1개.
//  · 렌더러의 F30 실행 기록(aiRuns)은 모듈 변수라 재시작이면 비어 있다 → 작업대 줄의
//    sessionId 는 null 이다(= 준영님이 클릭한 그 상태).
//
// 재는 것: 작업대 줄을 클릭한 뒤 (a) 탭바의 활성 탭 (b) `.pane` 이 들고 있는 세션 id.
// 양성 대조: 탭바 ＋(새 로컬 셸, MainArea.openLocal 경로)를 눌렀을 때 같은 관찰로 칸이 바뀌는가.
//
// 돌리는 법: npm run probe:aisess (다섯 변형을 러너가 돈다) · 하나만: npx electron tests/aisess-probe.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const { join, sep } = require('node:path')
const { safeWc } = require('./_harnessGuard.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const VERSION = require(join(ROOT, 'package.json')).version

const BENCH_CWD = ROOT.split(sep).join('/') // 경로 구분자는 node:path 에서 받는다(리터럴 금지 — 위 주석)

// 저장된 스냅샷 — 재시작 직후에 렌더러가 읽는 것.
const SNAP = {
  schemaVersion: 3,
  savedAt: '',
  app: { version: VERSION },
  profiles: [],
  knownHosts: {},
  // 칸 하나, 그 칸에 old-A. (사용자가 "이전에 보던 그 세션".)
  // SPLIT=1 이면 좌·우 2분할로 — 분할 여부가 관계있나(Q4)를 같은 하네스로 잰다.
  layout:
    process.env.SPLIT === '1'
      ? {
          type: 'split',
          direction: 'row',
          ratio: [0.5, 0.5],
          children: [
            { type: 'pane', sessionId: 'old-A' },
            { type: 'pane', sessionId: 'old-B' }
          ]
        }
      : {
          type: 'pane',
          // ⑥ 은 **두 번째**(old-B)를 칸에 둔다 — 마지막으로 만들어지는 것(old-C)과 달라야
          //    "restore 가 이겼나 opened 가 이겼나"를 가를 수 있다.
          sessionId:
            process.env.RESTORE3 === '1' ? 'old-B' : process.env.NOSESS === '1' ? null : 'old-A'
        },
  sessions: process.env.RESTORE3 === '1' ? [
    { id: 'old-A', title: '셸 A', serverKey: 'localhost', type: 'local', cwd: BENCH_CWD },
    { id: 'old-B', title: '셸 B(저장된 칸)', serverKey: 'localhost', type: 'local', cwd: BENCH_CWD },
    { id: 'old-C', title: '셸 C(마지막 생성)', serverKey: 'localhost', type: 'local', cwd: BENCH_CWD }
  ] : process.env.NOSESS === '1' ? [] : [
    { id: 'old-A', title: '셸 A', serverKey: 'localhost', type: 'local', cwd: BENCH_CWD },
    // 1.0.8 ②(aisess-resume): 이 필드가 있으면 복원이 세션 대신 **끊김 카드**를 세운다.
    // AICLI=0 으로 끄면 그 기능 이전의 기준선(=1~5라운드에서 잰 것)으로 돌아간다.
    {
      id: 'old-B',
      title: 'claude · OFA(재시작 뒤 로컬 셸)',
      serverKey: 'localhost',
      type: 'local',
      cwd: BENCH_CWD,
      ...(process.env.AICLI === '0' ? {} : { aiCli: 'claude' })
    }
  ],
  tabGroups: [],
  windows: [],
  // #129 작업대 — 재시작해도 남는다. 이것이 [AI] 목록의 줄이 된다.
  aiSessions: [
    {
      id: 'bench-1',
      kind: 'local',
      cwd: BENCH_CWD,
      engine: 'claude',
      skipPerms: false,
      title: 'OFA',
      lastUsedAt: Date.now() - 60_000
    }
  ],
  ui: {
    sidebar: { collapsed: false, activeTab: 'ai', width: 264 },
    ctxMenuStyle: 'list',
    font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
    locale: 'ko',
    scrollback: 10000,
    copyOnSelect: true,
    bootSplash: false,
    araWelcomeSeen: true
  }
}

let seq = 0
const created = [] // 이 하네스가 만든 세션 spec 기록(무엇이 왜 생겼나)
const order = [] // main 쪽 순서 기록 — opened 가 create 응답보다 먼저인가(⑥)

function wire() {
  ipcMain.handle('app:getVersion', () => VERSION)
  ipcMain.handle('app:openExternal', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', (_e, input) => ({ profile: { ...input, id: input.id || 'p9' } }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  ipcMain.handle('workspace:load', () => SNAP)
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('ui:setSidebar', () => ({ ok: true }))
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => ({ ok: false, reason: 'network', message: 'probe: 실접속 미수행' }))
  ipcMain.handle('ssh:test', () => ({ ok: false, reason: 'network', message: 'probe: 실접속 미수행' }))
  ipcMain.handle('window:minimize', () => ({ ok: true }))
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', () => ({ ok: true }))

  // pty 를 띄우지 않는다 — 우리가 재는 것은 "새 세션이 어느 칸에 올라가나"뿐이다.
  ipcMain.handle('session:create', (_e, spec) => {
    seq += 1
    const id = 'new-' + seq
    created.push({ id, title: spec && spec.title, command: spec && spec.command })
    // 🔴 실앱과 **같은 순서**로 민다: MainSessionManager.register() 가 create() 안에서
    // sink.opened 를 부르므로 `session:opened` 는 **session:create 응답보다 먼저** 도착한다.
    // (harness-must-match-real-ordering — 순서가 다른 재현은 반증이 아니다.)
    order.push('opened:' + id)
    _e.sender.send('session:opened', {
      id,
      title: (spec && spec.title) || id,
      serverKey: (spec && spec.serverKey) || 'localhost',
      type: 'local',
      cwd: (spec && spec.cwd) || ''
    })
    order.push('createReturn:' + id)
    return { id }
  })
  ipcMain.handle('session:attach', () => ({ backlog: new Uint8Array(0) }))
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:resize', () => ({ ok: true }))
  ipcMain.handle('session:destroy', () => ({ ok: true }))
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', () => {})
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})

  ipcMain.handle('history:load', () => ({ entries: [] }))
  ipcMain.handle('history:append', () => ({ ok: true }))
  ipcMain.handle('telemetry:start', () => ({ ok: true }))
  ipcMain.handle('telemetry:stop', () => ({ ok: true }))
  ipcMain.handle('telemetry:refresh', () => ({ ok: true }))
  ipcMain.handle('forward:list', () => [])
  ipcMain.handle('forward:create', () => ({ ok: false, message: 'probe' }))
  ipcMain.handle('forward:stop', () => ({ ok: true }))
  ipcMain.handle('tmux:listSessions', () => ({ status: 'noServer', sessions: [] }))
  ipcMain.handle('mcp:getState', () => ({ enabled: false, port: 0, hasToken: false, connected: 0, sessions: [], handedBack: false }))
  ipcMain.handle('mcp:setEnabled', () => ({ ok: true }))
  ipcMain.handle('update:get', () => ({ status: 'idle' }))
  ipcMain.handle('update:check', () => ({ status: 'idle' }))
  ipcMain.handle('update:download', () => ({ ok: true }))
  ipcMain.handle('update:install', () => ({ ok: true }))
  ipcMain.handle('sftp:list', () => ({ ok: false, message: 'probe' }))
  // 작업대의 폴더가 살아 있어야 줄이 `dead` 가 아니다(dead 면 버튼이 disabled 라 클릭이 안 먹는다).
  ipcMain.handle('fs:list', (_e, req) => ({ ok: true, path: (req && req.path) || '/', entries: [] }))
  ipcMain.handle('fs:downloadsDir', () => ({ dir: app.getPath('userData') }))
  ipcMain.handle('fs:drives', () => ({ drives: [] }))
  ipcMain.handle('agent:state', () => null)
  ipcMain.handle('aisession:save', () => ({ ok: true }))
  ipcMain.handle('ai:getState', () => ({ hasKey: true, provider: 'anthropic', model: '', turns: [], streaming: false, usage: { input: 0, output: 0 }, droppedTurns: 0 }))
}

const js = (win, code) => safeWc(() => win)()?.executeJavaScript(code)

const PROBE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  return {
    panes: q('.pane').map((e) => e.dataset.sessionId),
    stash: q('.pane-stash').map((e) => e.dataset.sessionId),
    tabs: q('.ttab').map((e) => ({
      id: e.dataset.sessionId,
      active: e.classList.contains('active'),
      label: (e.querySelector('.tlabel') || {}).textContent
    })),
    activeTab: (q('.ttab.active')[0] || {}).dataset ? q('.ttab.active')[0].dataset.sessionId : null,
    bench: q('.bench-row').map((e) => ({
      bench: e.dataset.bench,
      status: e.dataset.status,
      state: e.dataset.state,
      on: e.classList.contains('on'),
      dead: e.classList.contains('dead'),
      title: (e.querySelector('.t') || {}).textContent
    })),
    sidebarTab: (q('.lrail-item.active')[0] || {}).dataset ? q('.lrail-item.active')[0].dataset.tab : null
  }
})()`

const show = (label, p) => {
  console.log('\\n===== ' + label + ' =====')
  console.log('  panes     :', JSON.stringify(p.panes))
  console.log('  stash     :', JSON.stringify(p.stash))
  console.log('  activeTab :', p.activeTab)
  console.log('  tabs      :', JSON.stringify(p.tabs))
  console.log('  bench     :', JSON.stringify(p.bench))
  console.log('  sidebarTab:', p.sidebarTab)
}

app.whenReady().then(async () => {
  wire()
  const win = new BrowserWindow({
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
  safeWc(() => win)()?.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) console.log('  [renderer]', msg)
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(3000)

  // 사이드바 [AI] 로.
  await js(win, `document.querySelector('.lrail-item[data-tab="ai"]')?.click()`)
  await wait(600)

  const before = await js(win, PROBE)
  show('① 부팅 복원 직후(재시작 직후 상태)', before)

  // ⑥ 부트 복원 순서 기준선. 저장된 칸은 old-B(두 번째)인데 마지막으로 만들어지는 것은 old-C 다.
  //    칸이 B 면 layout.restore 가 이긴 것, C 면 opened 가 마지막에 민 것이다.
  if (process.env.RESTORE3 === '1') {
    console.log('\n===== ⑥ 부트 복원 순서 =====')
    console.log('  main 순서   :', JSON.stringify(order))
    console.log('  칸          :', JSON.stringify(before.panes), '(new-2 = 저장된 칸 old-B / new-3 = 마지막 old-C)')
    console.log('  판정        :', before.panes[0] === 'new-2' ? 'layout.restore 가 이긴다 ✅' : '⚠️ opened 가 마지막에 밀었다')
    win.destroy()
    app.quit()
    return
  }

  // ── 본 시험: 작업대 줄 클릭 ────────────────────────────────────────────
  const clicked = await js(win, `(() => {
    const b = document.querySelector('.bench-row .bench-name')
    if (!b) return 'NO-ROW'
    if (b.disabled) return 'DISABLED'
    b.click()
    return 'CLICKED'
  })()`)
  console.log('\\n  bench row click →', clicked)
  await wait(2500)
  const after = await js(win, PROBE)
  show('② 작업대 줄을 클릭한 뒤', after)

  console.log('\\n  하네스가 만든 세션:', JSON.stringify(created))

  // ── 양성 대조: 탭바 ＋(= MainArea.openLocal) ──────────────────────────
  // 같은 관찰(.pane 의 data-session-id)이 "칸이 바뀌는 것"을 실제로 볼 수 있는지 확인한다.
  const added = await js(win, `(() => {
    const b = document.querySelector('.tterm-add')
    if (!b) return 'NO-BUTTON'
    b.click()
    return 'CLICKED'
  })()`)
  console.log('\\n  [양성 대조] 탭바 ＋ →', added)
  await wait(2000)
  const ctrl = await js(win, PROBE)
  show('③ [양성 대조] 새 로컬 셸(openLocal) 뒤', ctrl)

  // ── ④ 같은 줄을 **다시** 클릭한다. 이제는 registerAiRun 덕에 그 줄이 sessionId(new-3)를 든다
  //    → openBench 의 `if (sessionId) selectSession(...)` 갈래. 이쪽은 되는가?
  const again = await js(win, `(() => {
    const b = document.querySelector('.bench-row .bench-name')
    if (!b) return 'NO-ROW'
    if (b.disabled) return 'DISABLED'
    b.click()
    return 'CLICKED'
  })()`)
  console.log('\\n  [갈래 비교] 살아 있는 줄 다시 클릭 →', again)
  await wait(1500)
  const revisit = await js(win, PROBE)
  show('④ sessionId 가 있는 줄을 클릭한 뒤', revisit)

  console.log('\\n  하네스가 만든 세션(최종):', JSON.stringify(created))

  // ── ⑤ main 이 스스로 연 세션(아라 MCP ssh_connect 길) — store/sessions.ts:321 의 `session:opened`.
  //    adopt 만 지나고 showSession 은 아무도 안 부른다. 같은 구멍인가?
  safeWc(() => win)()?.send('session:opened', {
    id: 'mcp-1',
    title: 'mcp 가 연 세션',
    serverKey: 'mcp-srv',
    type: 'ssh',
    winId: null,
    profileId: null,
    cwd: ''
  })
  await wait(1200)
  const mcp = await js(win, PROBE)
  show('⑤ main 이 session:opened 를 밀었을 때(MCP 경로)', mcp)

  const verdict = {
    '②에서 칸이 바뀌었나': JSON.stringify(before.panes) !== JSON.stringify(after.panes),
    '②에서 활성 탭이 바뀌었나': before.activeTab !== after.activeTab,
    '③(양성 대조)에서 칸이 바뀌었나': JSON.stringify(after.panes) !== JSON.stringify(ctrl.panes),
    '④(sessionId 있는 갈래)에서 칸이 바뀌었나': JSON.stringify(ctrl.panes) !== JSON.stringify(revisit.panes),
    '④에서 칸이 그 AI 세션인가': JSON.stringify(revisit.panes),
    '⑤(MCP session:opened)에서 칸이 바뀌었나': JSON.stringify(revisit.panes) !== JSON.stringify(mcp.panes),
    '⑤에서 활성 탭이 바뀌었나': revisit.activeTab !== mcp.activeTab
  }
  console.log('\\n===== 판정 =====')
  console.log(JSON.stringify(verdict, null, 2))

  win.destroy()
  app.quit()
})
