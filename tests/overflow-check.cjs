// 실제 앱에서 **글자가 넘치는 자리를 기계로 센다** — 눈으로 훑지 않는다.
//
// 왜: A 판(a375178)이 본문을 12.5 → 13px 로 4% 키웠는데 실제 앱을 한 번도 안 띄웠다. 목업에 없던
// 화면(설정 드로어 여덟 탭·연결 관리자·모달·표·팔레트·AI 패널)의 줄바꿈은 아무도 안 쟀다.
//
// 무엇을 재나: DOM 전체를 훑어 `scrollWidth > clientWidth` · `scrollHeight > clientHeight` 인
// 요소를 목록으로 낸다. `overflow: auto|scroll` 인 자리와 `text-overflow: ellipsis` 인 자리는
// **갈라서** 표시한다 — 전자는 스크롤이 받기로 한 자리고 후자는 의도된 잘림일 수 있다.
//
// 🔴 기준선을 함께 잰다. A 가 만든 넘침과 원래 넘치던 것을 가르지 못하면 이 보고서는 못 믿는다.
// 기준선은 `git show a375178^:src/renderer/styles/{tokens,shell,interactions}.css` 를 그대로
// <style> 로 얹어 만든다. **A 는 선택자를 하나도 더하거나 지우지 않았다**(값만 바꿨다 —
// `git show a375178 -- src/renderer/styles/ | grep '^[+-].*{$'` 가 빈 결과다). 그래서 옛 파일을
// 통째로 뒤에 얹으면 같은 특이도로 옛 값이 전부 이긴다 = 옛 CSS 와 같다. 세 파일에 @import·url()
// 이 없어(확인함) 번들 처리 없이 원문 그대로 붙일 수 있다.
//
// 🔴 창을 띄우지 않는다: show:false + offscreen:true. 준영님이 쓰고 계신 화면 위로 뜨면 그 자체가
// 방해다(scripts/shoot-mockup.cjs 와 같은 규율).
//
// 돌리는 법:  npm run build && npx electron tests/overflow-check.cjs
// 산출물:     agent_talk/overflow-report.json  (+ 콘솔 요약)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const pty = require('node-pty')

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const REPORT = join(ROOT, 'agent_talk', 'overflow-report.json')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 두 폭 × 두 배율. 900×700 은 shell.css:3122 가 적어 둔 972px 사고가 있던 좁은 폭이다.
const SIZES = [
  [1280, 800],
  [900, 700]
]
const SCALES = [
  ['normal', 1],
  ['large', 1.12] // shared/types.ts UI_SCALE_FACTOR
]

// ── 기준선 CSS(A 직전) ──────────────────────────────────────────────────────
function oldCss() {
  const files = ['tokens.css', 'shell.css', 'interactions.css'] // main.tsx 의 import 순서 그대로
  return files
    .map((f) => execFileSync('git', ['show', `a375178^:src/renderer/styles/${f}`], { cwd: ROOT, maxBuffer: 1 << 26 }).toString('utf8'))
    .join('\n')
}

// ── 최소 IPC(r4-screenshot.cjs 와 같은 배선) ────────────────────────────────
const PROFILES = [
  {
    id: 'ov-p1',
    name: '결제서버',
    host: '10.20.30.40',
    port: 22,
    username: 'deploy',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'ov-p1' } },
    group: '운영'
  },
  {
    id: 'ov-p2',
    name: '사내 원격데스크톱',
    type: 'rdp',
    host: '10.20.30.41',
    port: 3389,
    username: 'administrator',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'ov-p2' } },
    group: '운영'
  }
]

const ptys = new Map()
const SESSIONS = []
let getWc = () => null
let sidebar = { collapsed: false, activeTab: 'conn', width: 264 }

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
  ipcMain.handle('profile:save', (_e, input) => ({ profile: input }))
  ipcMain.handle('profile:delete', ok)
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
      sidebar: { ...sidebar },
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
  ipcMain.handle('ui:setSidebar', (_e, s) => {
    sidebar = s
    return { ok: true }
  })
  ipcMain.handle('ssh:forgetHostKey', () => ({ ok: true, removed: true }))
  ipcMain.handle('ssh:connect', () => {
    const id = makeSession('ssh', PROFILES[0].name, PROFILES[0].name, PROFILES[0].id)
    return { ok: true, id, title: PROFILES[0].name }
  })
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
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/srv/서비스', entries: [] }))
}

// ── 렌더러에서 도는 탐침 ────────────────────────────────────────────────────
// 이 함수는 node 에서 호출되지 않는다. `probe.toString()` 으로 직렬화해 executeJavaScript 에
// 넣는다 — 문자열 템플릿에 코드를 적으면 이스케이프 사고가 난다(2026-08 하네스 교훈).
function probe(cfg) {
  const q = (s, root) => (root || document).querySelector(s)
  const all = (s, root) => [...(root || document).querySelectorAll(s)]
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const key = (init) =>
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)))
  const hit = (sel, root) => {
    const el = q(sel, root)
    if (!el) return false
    el.click()
    return true
  }
  const menu = async (title, action) => {
    const m = all('.tb-menu span').find((s) => s.textContent.trim() === title)
    if (!m) return false
    m.click()
    await sleep(150)
    return hit('.ctx-menu .ctx-item[data-action="' + action + '"]')
  }
  const esc = () => key({ key: 'Escape' })

  // 상태 클래스는 실행마다 흔들린다 — 키를 만들 때 뺀다(안 빼면 A/기준선 대응이 어긋난다).
  const VOLATILE = new Set(['cur', 'flash', 'hover', 'drag-over', 'dragging'])
  function pathOf(el) {
    const parts = []
    let n = el
    for (let d = 0; n && n.nodeType === 1 && d < 4; d++, n = n.parentElement) {
      let s = n.tagName.toLowerCase()
      const cls = (n.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter((c) => c && !VOLATILE.has(c))
        .slice(0, 3)
      if (cls.length) s += '.' + cls.join('.')
      for (const a of ['data-activity', 'data-bottom', 'data-section', 'data-action']) {
        if (n.hasAttribute(a)) s += '[' + a + '=' + n.getAttribute(a) + ']'
      }
      parts.unshift(s)
    }
    return parts.join(' > ')
  }

  function scan(screen) {
    const seen = new Map()
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      // 터미널 내부는 뺀다 — 글자 크기를 사용자가 정하는 자리라 A 판이 건드리지 않는다.
      if (el.closest('.xterm')) continue
      const cs = getComputedStyle(el)
      // 순수 inline 만 뺀다 — scrollWidth/clientWidth 가 뜻이 없다. **inline-block 은 잰다**:
      // 생략부호(text-overflow: ellipsis)가 붙은 라벨이 대부분 거기 살아서, 빼면 ⚪ 칸이 통째로 빈다.
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.display === 'inline' || cs.display === 'contents') continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      // 뷰포트 밖에 접혀 있는 것(닫힌 드로어 등)은 안 잰다 — 안 보이는 자리의 넘침은 넘침이 아니다.
      if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) continue
      const dx = el.scrollWidth - el.clientWidth
      const dy = el.scrollHeight - el.clientHeight
      if (dx < 2 && dy < 2) continue
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44)
      // 짝짓기 키에 **글자를 넣는다.** 경로만으로 세면 형제가 여럿인 자리(.set-row 등)에서
      // 넘치는 것이 첫째냐 둘째냐가 판마다 달라져 A-NEW 와 A-BETTER 가 한 쌍으로 위조된다.
      const p = pathOf(el)
      const sig = p + ' §' + text
      const n = (seen.get(sig) || 0) + 1
      seen.set(sig, n)
      out.push({
        screen,
        path: p + (n > 1 ? '#' + n : ''),
        sig: sig + (n > 1 ? '#' + n : ''),
        dx: Math.max(0, dx),
        dy: Math.max(0, dy),
        ew: Math.round(r.width), // 요소 크기. 창 크기(w/h)와 이름이 겹치면 키가 무너진다.
        eh: Math.round(r.height),
        // 스크롤이 받기로 한 자리인가 / 잘리기로 한 자리인가 — 판정을 가르는 두 축.
        scrollX: cs.overflowX === 'auto' || cs.overflowX === 'scroll',
        scrollY: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
        ell: cs.textOverflow === 'ellipsis',
        fs: cs.fontSize,
        text
      })
    }
    return out
  }

  // 화면마다 여는 법이 다르다. open 이 false 를 돌려주거나 probe 셀렉터가 안 뜨면 "못 열었다".
  const SCREENS = [
    { id: 'main', open: async () => true, at: null, close: async () => {} },
    ...['general', 'terminal', 'font', 'log', 'ai', 'mcp', 'keys', 'about'].map((sec) => ({
      id: 'settings:' + sec,
      at: '.drawer.open',
      open: async () => {
        key({ key: ',', ctrlKey: true })
        await sleep(220)
        return hit('.set-nav [data-section="' + sec + '"]')
      },
      close: async () => {
        esc()
        await sleep(120)
        if (q('.drawer.open')) hit('.drawer-hd .x')
      }
    })),
    {
      id: 'conn-new',
      at: '.modal',
      open: async () => {
        key({ key: 'm', ctrlKey: true, shiftKey: true })
        await sleep(280)
        return !!q('.modal .prof-form')
      },
      close: async () => {
        esc()
        await sleep(120)
        if (q('.modal .prof-form')) hit('.modal-hd .x')
      }
    },
    {
      id: 'conn-rdp',
      at: '.modal',
      open: async () => {
        key({ key: 'm', ctrlKey: true, shiftKey: true })
        await sleep(280)
        const b = all('.prof-form .seg-ctl button').find((x) => x.textContent.trim() === 'RDP')
        if (!b) return false
        b.click()
        await sleep(200)
        return true
      },
      close: async () => {
        esc()
        await sleep(120)
        if (q('.modal .prof-form')) hit('.modal-hd .x')
      }
    },
    {
      id: 'dialog',
      at: '.dlg-overlay',
      open: async () => {
        if (!hit('.tree .rowact .cc-b')) return false
        await sleep(200)
        if (!hit('.ctx-menu .ctx-item[data-action="server.delete"]')) return false
        await sleep(300)
        return !!q('.dlg-overlay')
      },
      close: async () => {
        esc()
        await sleep(150)
        if (q('.dlg-overlay')) hit('.dlg-overlay .modal-ft .btn.sec')
      }
    },
    {
      id: 'ai-bootstrap',
      at: '.modal',
      open: async () => {
        const okm = await menu('파일', 'ai.bootstrap')
        await sleep(300)
        return okm && !!q('.modal')
      },
      close: async () => {
        esc()
        await sleep(150)
        if (q('.modal')) hit('.modal-hd .x')
      }
    },
    {
      id: 'palette',
      at: '.cp-drop',
      open: async () => {
        key({ key: 'F1' })
        await sleep(280)
        return !!q('.cp-drop')
      },
      close: async () => {
        key({ key: 'F1' })
        await sleep(120)
      }
    },
    {
      id: 'cheatsheet',
      at: '.cheatsheet',
      open: async () => {
        const okm = await menu('도움말', 'help.cheatsheet')
        await sleep(300)
        return okm && !!q('.cheatsheet')
      },
      close: async () => {
        esc()
        await sleep(150)
      }
    },
    {
      id: 'cmdbook',
      at: '.cheatsheet',
      open: async () => {
        key({ key: 'k', ctrlKey: true, shiftKey: true })
        await sleep(320)
        return !!q('.cheatsheet')
      },
      close: async () => {
        esc()
        await sleep(150)
      }
    },
    ...['monitor', 'sys', 'ps', 'svc', 'disk', 'pkg', 'ctr', 'k8s', 'log', 'applog'].map((id) => ({
      id: 'bottom:' + id,
      at: '.bottom-panel',
      open: async () => {
        if (!q('.bottom-panel')) {
          hit('[data-activity="bottombar"]')
          await sleep(300)
        }
        if (!q('.bottom-panel')) return false
        if (!hit('.bp-tab[data-bottom="' + id + '"]')) return false
        await sleep(450)
        return true
      },
      close: async () => {}
    })),
    {
      id: 'bottom-close',
      at: null,
      open: async () => {
        if (q('.bottom-panel')) hit('.bottom-panel .bp-close')
        await sleep(200)
        return true
      },
      skipScan: true,
      close: async () => {}
    },
    ...['ai', 'pastlog', 'preview'].map((id) => ({
      id: 'rail:' + id,
      at: { ai: '.ara-panel, .ai-panel', pastlog: '.pastlog, .past-rail', preview: '.mini-rail' }[id],
      open: async () => {
        if (!hit('[data-activity="' + id + '"]')) return false
        await sleep(500)
        return true
      },
      close: async () => {
        hit('[data-activity="' + id + '"]')
        await sleep(200)
      }
    }))
    // 탐색기는 2026-10-28 부터 별도 OS 창(#explorerwin)이라 본창 DOM 검사 대상이 아니다.
  ]

  return (async () => {
    document.documentElement.style.setProperty('--ui-scale', String(cfg.scale))
    await sleep(400)

    const findings = []
    const failed = []
    const opened = []

    if (cfg.only) {
      // 환영 모달처럼 한 번밖에 못 여는 화면 — 열려 있는 그대로 잰다.
      if (!q(cfg.only.at)) return { findings, failed: [cfg.only.id + ' (셀렉터 없음: ' + cfg.only.at + ')'], opened, vw: window.innerWidth, docW: document.documentElement.scrollWidth }
      findings.push(...scan(cfg.only.id))
      opened.push(cfg.only.id)
      return { findings, failed, opened, vw: window.innerWidth, docW: document.documentElement.scrollWidth }
    }

    for (const s of SCREENS) {
      let ok = false
      try {
        ok = await s.open()
      } catch (e) {
        failed.push(s.id + ' (open 예외: ' + (e && e.message) + ')')
        continue
      }
      if (!ok || (s.at && !q(s.at))) {
        failed.push(s.id + (ok ? ' (열렸다고 했는데 ' + s.at + ' 가 없다)' : ' (open 실패)'))
        try {
          await s.close()
        } catch {}
        continue
      }
      // "열었다"가 거짓말이 되지 않게 **내용이 있었다는 증거**를 함께 적는다 — 빈 패널을 열어
      // 놓고 쟀다고 말하는 것이 이 라운드가 고치려는 병이다.
      const root = s.at ? q(s.at) : document.querySelector('.app')
      const nodes = root ? root.querySelectorAll('*').length : 0
      const chars = root ? (root.textContent || '').trim().length : 0
      const trs = root ? root.querySelectorAll('.con-tbl tbody tr, tbody tr').length : 0
      opened.push(s.id + ' [' + nodes + '요소/' + chars + '자' + (trs ? '/' + trs + '행' : '') + ']')
      if (!s.skipScan) findings.push(...scan(s.id))
      try {
        await s.close()
      } catch (e) {
        failed.push(s.id + ' (close 예외: ' + (e && e.message) + ')')
      }
      await sleep(120)
    }
    return { findings, failed, opened, vw: window.innerWidth, docW: document.documentElement.scrollWidth }
  })()
}

// ── 실행 ────────────────────────────────────────────────────────────────────
async function runVariant(win, variant, baselineCss) {
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(2500)
  if (baselineCss) {
    await win.webContents.executeJavaScript(
      `(() => { const s = document.createElement('style'); s.id='ov-baseline'; s.textContent = ${JSON.stringify(baselineCss)}; document.head.appendChild(s); return true })()`
    )
    await wait(600)
  }

  const rows = []
  const meta = []

  // ① 환영 모달 — 부팅 때 한 번만 뜬다. 닫기 전에 네 조합을 전부 잰다.
  for (const [w, h] of SIZES) {
    for (const [sname, sval] of SCALES) {
      win.setContentSize(w, h)
      await wait(400)
      const r = await win.webContents.executeJavaScript(
        `(${probe.toString()})(${JSON.stringify({ scale: sval, only: { id: 'welcome', at: '.modal.welcome' } })})`
      )
      for (const f of r.findings) rows.push({ ...f, variant, w, h, scale: sname })
      meta.push({ variant, w, h, scale: sname, phase: 'welcome', failed: r.failed, opened: r.opened, vw: r.vw, docW: r.docW })
    }
  }
  // 환영 모달을 닫고 세션 하나를 연다(빈 화면이 아닌 실사용 상태에서 재기 위해).
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.modal.welcome .wc-ft button')?.click()
    await sleep(500)
    document.querySelector('.tterm-add')?.click(); await sleep(300)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await sleep(1200)
    return !document.querySelector('.modal.welcome')
  })()`)
  await wait(800)

  // ② 나머지 화면 전부.
  for (const [w, h] of SIZES) {
    for (const [sname, sval] of SCALES) {
      win.setContentSize(w, h)
      await wait(500)
      const r = await win.webContents.executeJavaScript(`(${probe.toString()})(${JSON.stringify({ scale: sval })})`)
      for (const f of r.findings) rows.push({ ...f, variant, w, h, scale: sname })
      meta.push({ variant, w, h, scale: sname, phase: 'main', failed: r.failed, opened: r.opened, vw: r.vw, docW: r.docW })
      console.log(`[${variant}] ${w}x${h} ${sname}: 넘침 ${r.findings.length}건 · 연 화면 ${r.opened.length} · 못 연 화면 ${r.failed.length} (vw=${r.vw})`)
      if (r.failed.length) console.log('   못 열었다: ' + r.failed.join(' | '))
    }
  }
  return { rows, meta }
}

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  const baseline = oldCss()
  console.log('기준선 CSS ' + baseline.length + '자 (a375178^)')

  win = new BrowserWindow({
    width: 1280,
    height: 800,
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
      offscreen: true // 🔴 화면 밖 렌더 — 레이아웃은 그대로 돈다
    }
  })

  const A = await runVariant(win, 'A', null)
  const B = await runVariant(win, 'BASE', baseline)

  const keyOf = (r) => `${r.w}x${r.h}|${r.scale}|${r.screen}|${r.sig}`
  const bmap = new Map(B.rows.map((r) => [keyOf(r), r]))
  const amap = new Map(A.rows.map((r) => [keyOf(r), r]))

  const verdict = []
  for (const a of A.rows) {
    const b = bmap.get(keyOf(a))
    const bdx = b ? b.dx : 0
    const bdy = b ? b.dy : 0
    let tag
    if (!b) tag = 'A-NEW'
    else if (a.dx > bdx || a.dy > bdy) tag = 'A-WORSE'
    else if (a.dx < bdx || a.dy < bdy) tag = 'A-BETTER'
    else tag = 'SAME'
    verdict.push({ ...a, baseDx: bdx, baseDy: bdy, inBase: !!b, tag })
  }
  // 기준선에만 있던 것(A 가 고친 것)도 남긴다.
  const fixed = B.rows.filter((b) => !amap.has(keyOf(b)))

  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        sizes: SIZES,
        scales: SCALES,
        verdict,
        fixed,
        metaA: A.meta,
        metaB: B.meta,
        rawA: A.rows,
        rawB: B.rows
      },
      null,
      1
    )
  )

  const cnt = (t) => verdict.filter((v) => v.tag === t).length
  console.log('─'.repeat(70))
  console.log(`A-NEW ${cnt('A-NEW')} · A-WORSE ${cnt('A-WORSE')} · SAME ${cnt('SAME')} · A-BETTER ${cnt('A-BETTER')} · 기준선에만 ${fixed.length}`)
  console.log('보고서: ' + REPORT)

  for (const p of ptys.values()) {
    try {
      p.kill()
    } catch {}
  }
  app.exit(0)
})

setTimeout(() => {
  console.log('overflow-check timeout')
  app.exit(1)
}, 600000)
