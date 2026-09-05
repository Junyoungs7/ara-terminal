// #181 진단 탐침 — `.modal.sm.ai-bootstrap` 이 900×700·배율 크게에서 세로로 141px 넘치는 자리.
//
// 왜 별도 하네스인가: `tests/overflow-check.cjs` 는 "누가 넘쳤다"까지만 말한다. 여기는 그 하나를
// 열어 놓고 **격자 트랙의 사용값**(getComputedStyle(...).gridTemplateRows 는 px 로 나온다)과
// 자식들의 clientHeight/scrollHeight 를 잰다. 그리고 후보 CSS 를 한 벌씩 얹어 다시 재서
// **왜 어떤 후보는 안 먹는지**를 추측이 아니라 실측으로 가른다(#181 은 두 번 실패한 자리다).
//
// 🔴 창을 띄우지 않는다: show:false + offscreen:true (overflow-check.cjs 와 같은 규율).
//
// 돌리는 법:  npm run build && npx electron tests/modal-clip-probe.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const pty = require('node-pty')

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PROFILES = [
  {
    id: 'mc-p1',
    name: '결제서버',
    host: '10.20.30.40',
    port: 22,
    username: 'deploy',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'mc-p1' } },
    group: '운영'
  }
]
const ptys = new Map()
const SESSIONS = []
let getWc = () => null

function spawnPty() {
  const w = process.platform === 'win32'
  const opts = { name: 'xterm-256color', cols: 110, rows: 30, cwd: ROOT, env: process.env }
  if (w) {
    opts.useConpty = true
    opts.useConptyDll = true
  }
  return pty.spawn(w ? 'powershell.exe' : '/bin/sh', w ? ['-NoLogo'] : [], opts)
}

function makeSession(type, title, serverKey, profileId) {
  const id = type + '-' + Math.random().toString(36).slice(2)
  const p = spawnPty()
  ptys.set(id, p)
  SESSIONS.push({ id, type, profileId: profileId ?? null, cwd: undefined, title, serverKey })
  p.onData((d) => {
    const b = Buffer.from(d, 'utf8')
    const u = new Uint8Array(b.length)
    u.set(b)
    const wc = getWc()
    if (wc) wc.postMessage('session:data:' + id, u)
  })
  p.onExit(() => ptys.delete(id))
  return id
}

function wire() {
  const ok = () => ({ ok: true })
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('app:openExternal', ok)
  ipcMain.handle('profile:list', () => PROFILES)
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 3,
    savedAt: '',
    app: { version: '0.1.0' },
    profiles: PROFILES,
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
      bootSplash: false
    }
  }))
  ipcMain.handle('workspace:save', ok)
  ipcMain.handle('ui:setPrefs', ok)
  ipcMain.handle('ui:setGroups', ok)
  ipcMain.handle('ui:setFont', ok)
  ipcMain.handle('ui:setSidebar', ok)
  ipcMain.handle('window:minimize', ok)
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', ok)
  ipcMain.handle('session:create', (_e, spec) => ({ id: makeSession('local', spec?.title, spec?.serverKey, null) }))
  ipcMain.handle('session:attach', () => ({ backlog: new Uint8Array(0) }))
  ipcMain.handle('session:rename', ok)
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => {
    try {
      ptys.get(id)?.resize(cols, rows)
    } catch {}
    return { ok: true }
  })
  ipcMain.handle('session:destroy', (_e, { id }) => {
    try {
      ptys.get(id)?.kill()
    } catch {}
    ptys.delete(id)
    return { ok: true }
  })
  ipcMain.handle('session:list', () => SESSIONS.filter((s) => ptys.has(s.id)))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

// ── 렌더러 탐침 ─────────────────────────────────────────────────────────────
// 문자열 템플릿에 코드를 적지 않는다 — `fn.toString()` 으로 직렬화한다(하네스 규율).
function openBootstrap() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    document.querySelector('.modal.welcome .wc-ft button')?.click()
    await sleep(500)
    document.querySelector('.tterm-add')?.click()
    await sleep(300)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click()
    await sleep(1200)
    const m = [...document.querySelectorAll('.tb-menu span')].find((s) => s.textContent.trim() === '파일')
    if (!m) return 'no-menu'
    m.click()
    await sleep(200)
    const it = document.querySelector('.ctx-menu .ctx-item[data-action="ai.bootstrap"]')
    if (!it) return 'no-item'
    it.click()
    await sleep(400)
    return document.querySelector('.modal.ai-bootstrap') ? 'ok' : 'no-modal'
  })()
}

// 🔴 배율은 **모달을 연 뒤에** 걸어야 한다. `--ui-scale` 은 인라인 스타일이고, 앱의
// `applyUiPrefs()`(terminal/termPrefs.ts:104)가 같은 자리에 쓴다 — 환영 모달 닫기·세션 만들기가
// prefs 를 다시 얹으면 미리 걸어 둔 1.12 가 1 로 되돌아간다. 처음엔 그걸 모르고 부팅 직후에
// 걸었다가 dy141(배율 크게)이 아니라 dy61(기본 배율)을 재고 있었다.
function setScale(v) {
  document.documentElement.style.setProperty('--ui-scale', String(v))
  return getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
}

function measure() {
  const modal = document.querySelector('.modal.ai-bootstrap')
  if (!modal) return { err: 'no-modal' }
  const box = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      sel: el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '').trim().split(/\s+/).join('.'),
      client: el.clientHeight,
      scroll: el.scrollHeight,
      offset: el.offsetHeight,
      rectH: Math.round(r.height * 10) / 10,
      dy: el.scrollHeight - el.clientHeight,
      display: cs.display,
      rows: cs.gridTemplateRows,
      minH: cs.minHeight,
      maxH: cs.maxHeight,
      ovY: cs.overflowY
    }
  }
  const mr = modal.getBoundingClientRect()
  const ft = modal.querySelector('.modal-ft')
  const fr = ft ? ft.getBoundingClientRect() : null
  return {
    vh: window.innerHeight,
    modal: box(modal),
    // 격자 트랙의 **사용값**. 여기가 이 진단의 핵심 증거다.
    tracks: getComputedStyle(modal).gridTemplateRows,
    children: [...modal.children].map(box),
    rows: [...modal.querySelectorAll('.dlg-body > *')].map((el) => ({
      cls: (el.getAttribute('class') || '').trim(),
      h: Math.round(el.getBoundingClientRect().height * 10) / 10
    })),
    // 버튼에 닿을 수 있나 — 이게 실제 목표다. 바닥줄이 모달 밑변 안에 있는지.
    footBottom: fr ? Math.round(fr.bottom * 10) / 10 : null,
    modalBottom: Math.round(mr.bottom * 10) / 10,
    footClipped: fr ? Math.round((fr.bottom - mr.bottom) * 10) / 10 : null,
    footInViewport: fr ? fr.bottom <= window.innerHeight + 0.5 : null
  }
}

function inject(css) {
  let s = document.getElementById('mc-cand')
  if (!s) {
    s = document.createElement('style')
    s.id = 'mc-cand'
    document.head.appendChild(s)
  }
  s.textContent = css
  return true
}

// 후보들. 앞의 둘은 **되돌린 시도 재현**이다 — 왜 안 먹었는지 실측으로 답하기 위해 넣는다.
const CANDIDATES = [
  ['C0 있는 그대로', ''],
  ['C1 시도① .dlg-body{min-height:0;overflow-y:auto}', '.dlg-body { min-height: 0; overflow-y: auto; }'],
  ['C2 시도② .modal.sm{rows: auto minmax(0,auto) auto}', '.modal.sm { grid-template-rows: auto minmax(0, auto) auto; }'],
  ['C3 트랙만 1fr', '.modal.sm { grid-template-rows: auto minmax(0, 1fr) auto; }'],
  [
    'C4 트랙 1fr + 본문 스크롤',
    '.modal.sm { grid-template-rows: auto minmax(0, 1fr) auto; } .modal.sm .dlg-body { overflow-y: auto; }'
  ],
  [
    'C5 트랙 auto유지 + 본문만 스크롤(min-height:0 없이)',
    '.modal.sm .dlg-body { overflow-y: auto; }'
  ],
  // C6 = `.modal.sm` 의 트랙 재정의를 **지우고** .modal 의 `auto 1fr auto` 를 그대로 쓰는 안.
  // 선언을 더하지 않고 지우는 쪽이라 이게 되면 이걸 고른다. `1fr` = `minmax(auto, 1fr)` 이라
  // 최소값이 auto 인데, 자식이 스크롤 컨테이너면 그 자동 최소 크기가 0 이 되어 트랙이 줄 수 있다.
  [
    'C6 재정의 삭제(=.modal 의 auto 1fr auto) + 본문 스크롤',
    '.modal.sm { grid-template-rows: auto 1fr auto; } .modal.sm .dlg-body { overflow-y: auto; }'
  ],
  ['C7 재정의 삭제만(본문 스크롤 없이)', '.modal.sm { grid-template-rows: auto 1fr auto; }']
]

// 고치기 전 상태를 그대로 되살리는 CSS — 2부에서 "옛 판"으로 얹는다.
// (지운 재정의를 되돌리고, 새 본문 스크롤을 끈다)
const OLD_CSS = '.modal.sm { grid-template-rows: auto auto auto; } .modal.sm .dlg-body { overflow-y: visible; }'

// 열린 확인 다이얼로그의 본문에 행을 밀어 넣어 길게 만든 뒤, 옛 판 / 새 판을 나란히 잰다.
function tallDialog(oldCss) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return (async () => {
    // ai-bootstrap 을 닫고 서버 삭제 확인창을 연다(overflow-check 의 `dialog` 화면과 같은 길).
    document.querySelector('.modal.ai-bootstrap .modal-hd .x')?.click()
    await sleep(300)
    document.getElementById('mc-cand')?.remove()
    const cc = document.querySelector('.tree .rowact .cc-b')
    if (!cc) return { err: '.tree .rowact .cc-b 없음' }
    cc.click()
    await sleep(250)
    const del = document.querySelector('.ctx-menu .ctx-item[data-action="server.delete"]')
    if (!del) return { err: 'server.delete 항목 없음' }
    del.click()
    await sleep(350)
    const body = document.querySelector('.dlg-overlay .modal.sm .dlg-body')
    if (!body) return { err: '.dlg-overlay .modal.sm .dlg-body 없음' }

    // 종료 확인창의 상세 행과 같은 마크업으로 30줄.
    const det = document.createElement('div')
    det.className = 'dlg-detail'
    for (let i = 0; i < 30; i++) {
      const row = document.createElement('div')
      row.className = 'dlg-row'
      row.innerHTML = '<span class="dlg-k">결제서버</span><span class="dlg-v">세션 ' + (i + 1) + '</span>'
      det.appendChild(row)
    }
    body.appendChild(det)

    let s = document.createElement('style')
    s.id = 'mc-old'
    document.head.appendChild(s)
    const rows = []
    for (const [label, css] of [
      ['옛 판', oldCss],
      ['고친 판', '']
    ]) {
      s.textContent = css
      document.documentElement.style.setProperty('--ui-scale', '1.12')
      await sleep(350)
      const modal = document.querySelector('.dlg-overlay .modal.sm')
      const ft = modal.querySelector('.modal-ft')
      const mr = modal.getBoundingClientRect()
      const fr = ft.getBoundingClientRect()
      rows.push({
        label,
        mc: modal.clientHeight,
        ms: modal.scrollHeight,
        mdy: modal.scrollHeight - modal.clientHeight,
        bc: body.clientHeight,
        bs: body.scrollHeight,
        bov: getComputedStyle(body).overflowY,
        clip: Math.round((fr.bottom - mr.bottom) * 10) / 10,
        inVp: fr.bottom <= window.innerHeight + 0.5
      })
    }
    return { rows }
  })()
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 900,
    height: 700,
    useContentSize: true,
    show: false, // 🔴 준영님 화면 위로 뜨지 않는다
    frame: false,
    backgroundColor: '#0d1119',
    webPreferences: {
      preload: join(OUT, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      offscreen: true
    }
  })

  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(2500)
  win.setContentSize(900, 700)
  await wait(300)

  const opened = await win.webContents.executeJavaScript(`(${openBootstrap.toString()})()`)
  console.log('부트스트랩 열기: ' + opened)
  if (opened !== 'ok') {
    for (const p of ptys.values()) {
      try {
        p.kill()
      } catch {}
    }
    return app.exit(1)
  }

  for (const [label, css] of CANDIDATES) {
    await win.webContents.executeJavaScript(`(${inject.toString()})(${JSON.stringify(css)})`)
    // 배율은 매 회 다시 걸고 **읽어서 확인한다** — 걸었다고 걸린 것이 아니다(위 setScale 주석).
    const scale = await win.webContents.executeJavaScript(`(${setScale.toString()})(1.12)`)
    await wait(350)
    const m = await win.webContents.executeJavaScript(`(${measure.toString()})()`)
    console.log('\n══ ' + label + ' ══')
    console.log('  창 높이 vh=' + m.vh + ' · --ui-scale=' + scale + ' · 트랙 사용값 = ' + m.tracks)
    const b = m.modal
    console.log(
      `  .modal            client=${b.client} scroll=${b.scroll} dy=${b.dy} maxH=${b.maxH} ovY=${b.ovY} rows=${b.rows}`
    )
    for (const c of m.children) {
      console.log(`  ${c.sel.padEnd(18)} client=${c.client} scroll=${c.scroll} dy=${c.dy} minH=${c.minH} ovY=${c.ovY}`)
    }
    console.log(
      `  바닥줄 bottom=${m.footBottom} / 모달 bottom=${m.modalBottom} → 넘어감 ${m.footClipped}px · 뷰포트 안? ${m.footInViewport}`
    )
    if (m.rows.length) console.log('  본문 행 높이: ' + m.rows.map((r) => r.cls + '=' + r.h).join(' · '))
  }

  // ── 2부: `.modal.sm` 의 **다른 자리**(Dialog.tsx)도 같이 고쳐졌나 ──────────────
  // overflow-check 는 짧은 삭제 확인창만 연다(18요소/81자) — 안 넘치니 전후가 똑같이 나온다.
  // 그건 "안 나빠졌다"까지만 말하고 "길어져도 닫을 수 있다"는 말해 주지 않는다. 그래서 열린
  // 다이얼로그 본문에 행을 밀어 넣어 **길게 만들어** 잰다(CSS 를 재는 것이므로 DOM 주입으로 충분).
  // 종료 확인창(Shell.tsx QUIT_LIST_MAX)이 세션 12개일 때가 정확히 이 모양이다.
  const tall = await win.webContents.executeJavaScript(`(${tallDialog.toString()})(${JSON.stringify(OLD_CSS)})`)
  console.log('\n══ 2부: 긴 확인 다이얼로그(.dlg-row 30줄 주입) ══')
  if (tall.err) console.log('  못 열었다: ' + tall.err)
  else
    for (const r of tall.rows)
      console.log(
        `  ${r.label.padEnd(12)} .modal client=${r.mc} scroll=${r.ms} dy=${r.mdy} · .dlg-body client=${r.bc} scroll=${r.bs} ovY=${r.bov}` +
          ` → 바닥줄이 밑변보다 ${r.clip}px ${r.clip > 0 ? '아래(못 닿는다)' : '위(닿는다)'} · 뷰포트 안? ${r.inVp}`
      )

  for (const p of ptys.values()) {
    try {
      p.kill()
    } catch {}
  }
  app.exit(0)
})

setTimeout(() => {
  console.log('modal-clip-probe timeout')
  app.exit(1)
}, 180000)
