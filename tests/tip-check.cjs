// 툴팁의 **배선**을 진짜 Chromium 으로 잰다 — 순수 함수가 아니라 DOM 을 지나가는 길 전체를.
//
// 왜: tests/tooltip.test.ts 는 `scrollW`/`clientW` 를 **손으로 넣는다.** `pickCut` 의 규칙만 지킬 뿐
// 실제 레이아웃 엔진이 그 값을 주는지, 배선(mouseover → 450ms → querySelectorAll 수집 → pickCut →
// 앵커 교체 → placeTip)이 도는지는 아무도 안 쟀다(TIP-fix-done.md "못 보는 것" ①·④).
//
// 🔴 가장 무서운 실패는 툴팁이 늘 뜨는 게 아니라 **툴팁이 통째로 사라지는 것**이다. `skip` 이 한 칸만
// 헛짚으면 `title` 89곳이 죽는다. 그래서 C·D(회귀 가드)를 A·B 와 같은 무게로 잰다.
//
// 무엇이 진짜고 무엇이 합성인가:
//   · 진짜 — CSS(`.con-tbl td` 의 ellipsis, `.ara-tip` 의 max-width), 레이아웃 엔진, 하단 패널 폭,
//            아이콘 버튼(C·D 는 앱이 그린 실물 요소를 그대로 hover 한다), tooltip.ts 배선 전체
//   · 합성 — 표의 행 데이터(A·B). 하단 ps 표는 SSH 세션이 있어야 그려지므로(ServerTool.tsx:54)
//            같은 마크업의 표를 **진짜 .bp-pane 안에** 끼워 넣는다. 클래스가 같으니 열 폭도 같다.
//
// 🔴 창을 띄우지 않는다: show:false + offscreen:true (overflow-check.cjs 와 같은 규율).
//
// 돌리는 법:  npm run build && npx electron tests/tip-check.cjs
// 산출물:     agent_talk/tip-report.json  (+ 콘솔 요약)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'out')
const REPORT = join(ROOT, 'agent_talk', 'tip-report.json')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 최소 IPC(overflow-check.cjs 와 같은 배선에서 pty 만 뺐다 — 세션을 만들지 않는다) ────────
const PROFILES = [
  {
    id: 'tip-p1',
    name: '결제서버',
    host: '10.20.30.40',
    port: 22,
    username: 'deploy',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'tip-p1' } },
    group: '운영'
  }
]

let getWc = () => null
let sidebar = { collapsed: false, activeTab: 'conn', width: 264 }

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
  ipcMain.handle('ssh:connect', () => ({ ok: false, error: 'harness' }))
  ipcMain.handle('window:minimize', ok)
  ipcMain.handle('window:toggleMaximize', () => ({ maximized: false }))
  ipcMain.handle('window:close', ok)
  ipcMain.handle('session:create', () => ({ id: null, error: 'harness' }))
  ipcMain.handle('session:attach', () => ({ backlog: new Uint8Array(0) }))
  ipcMain.handle('session:rename', ok)
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.handle('session:resize', ok)
  ipcMain.handle('session:destroy', ok)
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', () => {})
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
  ipcMain.handle('sftp:list', () => ({ ok: true, path: '/srv/서비스', entries: [] }))
}

// ── 렌더러에서 도는 탐침 ────────────────────────────────────────────────────
// node 에서 호출되지 않는다. `probe.toString()` 으로 직렬화해 executeJavaScript 에 넣는다 —
// 문자열 템플릿에 코드를 적으면 이스케이프 사고가 난다(2026-08 하네스 교훈).
function probe(cfg) {
  const q = (s) => document.querySelector(s)
  const all = (s) => Array.from(document.querySelectorAll(s))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const R = (el) => {
    const r = el.getBoundingClientRect()
    const n = (v) => Math.round(v * 10) / 10
    return { x: n(r.left), y: n(r.top), w: n(r.width), h: n(r.height), right: n(r.right), bottom: n(r.bottom) }
  }

  function tipState() {
    const h = q('.ara-tip')
    if (!h) return { host: false, on: false }
    return {
      host: true,
      on: h.classList.contains('on'),
      text: (h.textContent || '').slice(0, 90),
      // 상자가 **자기 글자를 담고 있나**. 판정 F 가 보는 값이다 — 사각형(R)만으로는 안 보인다:
      // 글자가 뚫고 나가도 상자의 getBoundingClientRect 는 얌전히 380 을 낸다.
      sw: h.scrollWidth,
      cw: h.clientWidth,
      r: R(h)
    }
  }

  // 이전 판정의 툴팁이 남지 않게 — title 없는 곳으로 mouseover 를 한 번 쏘면 hide() 가 걸린다.
  async function rest() {
    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(150)
  }

  // 진짜 mouseover 를 그 요소에 쏜다. 나머지는 앱이 한다(위임 리스너 → 450ms → show).
  async function hover(el) {
    await rest()
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(cfg.wait)
    return tipState()
  }

  // ── 합성 표 — ProcessTable.tsx:241-287 이 그리는 마크업 그대로(클래스가 같아야 열 폭이 같다) ──
  const LONG_CMD =
    '/usr/lib/systemd/systemd --switched-root --system --deserialize 31 ' +
    '--log-level=info --log-target=journal-or-kmsg --show-status=auto ' +
    '--unit=multi-user.target --machine-id=8f3c21ab9d4e40f1b2c7'
  const SHORT_CMD = 'bash'
  // F — **띄어쓰기 없는 긴 한 덩어리.** A 의 cmd 는 띄어쓰기가 많아 min-content 가 낱말 하나라
  // 툴팁이 곱게 감쌌다(그래서 앞 라운드가 이 버그를 놓쳤다). 진짜 ps 출력의 경로는 이렇게 생겼다.
  // ⚠️ 하이픈은 CSS 줄바꿈 자리다(`java-17-openjdk-…` 는 저절로 끊긴다) — 덩어리를 길게 만드는 건
  // 하이픈 **없는** 구간이다. 배포 릴리스 디렉터리(타임스탬프+해시)가 실제로 그렇다.
  const NOSPACE_CMD =
    '/usr/lib/jvm/java-17-openjdk-17.0.9.0.9-2.el9.x86_64/bin/java -jar ' +
    '/opt/verygood/erp/releases/20250903_141207_a9f3c21ab9d4e40f/lib/vgt_web_erp_boot_SNAPSHOT.jar'

  function cell(cls, txt) {
    const td = document.createElement('td')
    td.className = cls
    td.textContent = txt
    return td
  }
  // `tip` 이 있으면 **화면 글자와 다른 title** 이 된다(= pickCut 의 asIs). 그때만 앵커가 줄 전체로
  // 남아 위/아래 폴백이 돈다 — A 는 셀로 좁혀지느라 그 가지를 한 번도 안 밟는다.
  function row(pid, cmd, tag, tip) {
    const tr = document.createElement('tr')
    tr.className = 'con-row'
    tr.setAttribute('role', 'row')
    tr.setAttribute('data-pid', String(pid))
    tr.setAttribute('data-tipcheck', tag)
    tr.title = tip || cmd
    tr.appendChild(cell('cpid', String(pid)))
    tr.appendChild(cell('cuser', 'root'))
    tr.appendChild(cell('ccpu', '0.4'))
    const mem = document.createElement('td')
    mem.className = 'cmem'
    const bar = document.createElement('span')
    bar.className = 'con-bar'
    const i = document.createElement('i')
    i.style.width = '12%'
    bar.appendChild(i)
    const memv = document.createElement('span')
    memv.className = 'con-memv'
    memv.textContent = '1.2'
    mem.appendChild(bar)
    mem.appendChild(memv)
    tr.appendChild(mem)
    tr.appendChild(cell('ccmd', cmd))
    return tr
  }

  function mountTable() {
    // 1순위: 앱이 그린 진짜 하단 패널 본문(폭·여백이 실물이다).
    const panes = all('.bp-pane').filter((p) => p.offsetParent !== null || p.getBoundingClientRect().width > 0)
    let host = panes[0] || null
    let where = host ? '.bp-pane (진짜 하단 패널)' : null
    if (host) {
      // 🔴 세션이 없어 안내문(.sb-placeholder)이 들어 있다. `.bp-pane` 은 **가로 flex** 라
      // 그대로 두면 안내문이 폭을 나눠 가져 표가 오른쪽으로 밀린다 — 그러면 앵커 왼쪽 여유가
      // 실제보다 넓어져 이 검사가 증상을 못 만든다(첫 실행에서 tr.x 가 459 였다. 진짜 표는
      // 그 자리를 혼자 쓰므로 310 근처다). 지우지 않고 숨긴다 — React 가 관리하는 DOM 이다.
      for (const c of Array.from(host.children)) c.style.display = 'none'
    }
    if (!host) {
      // 2순위: 하단 패널을 못 열었을 때 — 폭만 흉내 낸 상자. **이 경우 폭은 실물이 아니다.**
      host = document.createElement('div')
      host.style.cssText =
        'position:fixed;left:320px;right:60px;bottom:0;height:220px;z-index:5;display:flex;flex-direction:column'
      document.body.appendChild(host)
      where = 'fallback 상자(하단 패널을 못 열었다 — 폭은 실물이 아니다)'
    }
    const wrap = document.createElement('div')
    wrap.className = 'con-tblwrap'
    wrap.id = 'tipcheck-wrap'
    const tbl = document.createElement('table')
    tbl.className = 'con-tbl'
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (const [cls, label] of [
      ['cpid', 'PID'],
      ['cuser', '사용자'],
      ['ccpu', 'CPU'],
      ['cmem', 'MEM'],
      ['ccmd', '명령']
    ]) {
      const th = document.createElement('th')
      th.className = cls
      th.setAttribute('data-col', cls)
      th.textContent = label
      htr.appendChild(th)
    }
    thead.appendChild(htr)
    const tbody = document.createElement('tbody')
    tbody.appendChild(row(1, LONG_CMD, 'long'))
    tbody.appendChild(row(812, SHORT_CMD, 'short'))
    // E — 화면 글자와 다른 설명문. 앵커가 줄 전체로 남는 유일한 줄이다(위/아래 폴백을 밟는다).
    // ⚠️ 문구가 **길어야** 한다. 짧게 잡았다가 한 번 헛짚었다(2026-09-05 실측): 툴팁이 276px 이면
    // 줄 왼쪽 여유 290px 안에 들어가 좌우로 붙는다 — 폴백은 마지막 수단이라 그게 맞는 동작이다.
    // 이 문구는 `.ara-tip` 의 max-width(380)에 닿아야 290 을 넘어 위로 밀린다. 저장소의 실물
    // 설명문 길이다(tests/tooltip.test.ts 가 쓰는 내려받기 버튼 문구와 같은 부류).
    tbody.appendChild(
      row(
        4021,
        'nginx: worker process',
        'wide',
        '원격에서 파일을 복사(Ctrl+C)하면 활성화됩니다 — 저장 위치를 골라 내려받습니다'
      )
    )
    tbody.appendChild(row(9310, NOSPACE_CMD, 'nospace'))
    tbl.appendChild(thead)
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    host.appendChild(wrap)
    return { where, wrap }
  }

  return (async () => {
    const notes = []

    // ① 환영 모달을 닫는다(부팅 때 한 번 뜬다 — 덮여 있으면 하단 패널을 못 연다).
    const wc = q('.modal.welcome .wc-ft button')
    if (wc) {
      wc.click()
      await sleep(500)
    }
    notes.push('환영 모달: ' + (wc ? '닫았다' : '없었다'))

    // ② 하단 패널을 연다(진짜 폭을 얻기 위해). 세션이 없으면 본문은 안내문이지만 패널 폭은 실물이다.
    if (!q('.bottom-panel')) {
      const b = q('[data-activity="bottombar"]')
      if (b) b.click()
      await sleep(500)
    }
    const psTab = q('.bp-tab[data-bottom="ps"]')
    if (psTab) {
      psTab.click()
      await sleep(400)
    }
    notes.push('하단 패널: ' + (q('.bottom-panel') ? '열렸다' : '못 열었다') + ' · ps 탭: ' + (psTab ? '눌렀다' : '없었다'))

    const mounted = mountTable()
    await sleep(300)

    const longTr = q('tr[data-tipcheck="long"]')
    const shortTr = q('tr[data-tipcheck="short"]')
    const longTd = longTr ? longTr.querySelector('.ccmd') : null
    const shortTd = shortTr ? shortTr.querySelector('.ccmd') : null

    const out = {
      mount: mounted.where,
      notes,
      vw: window.innerWidth,
      vh: window.innerHeight,
      A: null,
      B: null,
      C: null,
      D: null,
      E: null,
      F: null
    }

    // ── A: 긴 cmd 로 셀이 잘린 줄 ──────────────────────────────────────────
    if (!longTd) {
      out.A = { measured: false, why: '합성 행을 못 찾았다' }
    } else {
      // 🔴 이 라운드의 핵심 원자료: **진짜 레이아웃 엔진이 주는** scrollWidth/clientWidth.
      // 순수 함수 검사가 손으로 넣던 그 값이다.
      const raw = {
        tr: {
          scrollW: longTr.scrollWidth,
          clientW: longTr.clientWidth,
          r: R(longTr),
          text: (longTr.textContent || '').length
        },
        td: {
          scrollW: longTd.scrollWidth,
          clientW: longTd.clientWidth,
          r: R(longTd),
          ell: getComputedStyle(longTd).textOverflow,
          ov: getComputedStyle(longTd).overflow
        }
      }
      // 마우스가 실제로 얹히는 곳은 셀이다 — title 은 그 위 <tr> 에 있다(closest 가 찾아 올라간다).
      const st = await hover(longTd)
      out.A = { measured: true, raw, tip: st }
    }

    // ── B: 짧은 cmd(bash) 줄 ──────────────────────────────────────────────
    if (!shortTd) {
      out.B = { measured: false, why: '합성 행을 못 찾았다' }
    } else {
      const raw = {
        td: { scrollW: shortTd.scrollWidth, clientW: shortTd.clientWidth, r: R(shortTd), text: shortTd.textContent }
      }
      const st = await hover(shortTd)
      out.B = { measured: true, raw, tip: st }
    }

    // ── C: 보이는 글자가 없는 title(아이콘 버튼) — 실물 요소를 쓴다 ─────────
    // 회귀 가드다. 여기가 빨간불이면 asIs 갈래가 죽은 것이고 title 89곳이 통째로 사라진다.
    const iconBtn = all('[title]').find((el) => {
      if (el.closest('.activity-bar')) return false // D 가 쓴다
      if (el.closest('#tipcheck-wrap')) return false // 우리가 만든 것
      const r = el.getBoundingClientRect()
      return (
        (el.textContent || '').trim() === '' &&
        (el.getAttribute('title') || '').trim() !== '' &&
        r.width > 4 &&
        r.height > 4
      )
    })
    if (!iconBtn) {
      out.C = { measured: false, why: '글자 없는 title 요소를 화면에서 못 찾았다' }
    } else {
      const who = iconBtn.tagName.toLowerCase() + '.' + (iconBtn.getAttribute('class') || '(무클래스)')
      const raw = {
        who,
        title: iconBtn.getAttribute('title'),
        textContent: JSON.stringify(iconBtn.textContent),
        r: R(iconBtn)
      }
      const st = await hover(iconBtn)
      out.C = { measured: true, raw, tip: st }
    }

    // ── D: 좁은 앵커(액티비티 바) — 자리가 좌우여야 한다 ────────────────────
    const act = q('.activity-bar [title], .activity-bar [data-tip]')
    if (!act) {
      out.D = { measured: false, why: '액티비티 바 버튼을 못 찾았다' }
    } else {
      const raw = {
        who: 'act ' + (act.getAttribute('data-activity') || '?'),
        title: act.getAttribute('title') || act.getAttribute('data-tip'),
        r: R(act)
      }
      const st = await hover(act)
      out.D = { measured: true, raw, tip: st }
    }

    // ── E: 넓은 앵커(줄 전체) — 위/아래 폴백이 실제로 도는 유일한 자리 ──────
    // A 는 앵커가 셀로 좁혀져 좌우로 되돌아간다. 그래서 A 만으로는 ① 이 한 번도 안 돌아간다.
    const wideTr = q('tr[data-tipcheck="wide"]')
    if (!wideTr) {
      out.E = { measured: false, why: '합성 행을 못 찾았다' }
    } else {
      const raw = { r: R(wideTr), title: wideTr.getAttribute('title') || wideTr.getAttribute('data-tip'), shown: (wideTr.textContent || '').trim().slice(0, 40) }
      const st = await hover(wideTr.querySelector('.ccmd'))
      out.E = { measured: true, raw, tip: st }
    }

    // ── F: 띄어쓰기 없는 긴 cmd — 글자가 상자를 뚫는가 ──────────────────────
    // A~E 는 툴팁이 **어디에** 서는지를 봤다. F 는 상자가 **자기 글자를 담고 있는지**를 본다.
    // 준영님 제보(2026-09-05): "호버 창을 넘어가서 나와. 텍스트가 튀어나와 사이즈에 맞지않게."
    const nsTr = q('tr[data-tipcheck="nospace"]')
    if (!nsTr) {
      out.F = { measured: false, why: '합성 행을 못 찾았다' }
    } else {
      const nsTd = nsTr.querySelector('.ccmd')
      const raw = {
        td: { scrollW: nsTd.scrollWidth, clientW: nsTd.clientWidth, r: R(nsTd) },
        cmd: nsTr.getAttribute('title') || nsTr.getAttribute('data-tip'),
        // 가장 긴 **끊을 수 없는** 덩어리. 이게 380 을 넘어야 이 판정이 증상을 만든다 —
        // 안 넘으면 F 가 초록이어도 아무것도 증명하지 않는다(그래서 판정문에 같이 적는다).
        longestRun: Math.max(...(nsTr.getAttribute('title') || '').split(/\s+/).map((s) => s.length))
      }
      const st = await hover(nsTd)
      out.F = { measured: true, raw, tip: st }
    }

    // ── 인구조사(판정 아님) — 이 화면의 진짜 title 을 **전부** 하나씩 얹어 본다 ──────────
    // C·D 는 표본 둘이다. "툴팁 89곳이 죽었나"는 표본으로 답할 수 없어 세어 둔다.
    // 🔴 판정은 앱이 한다 — 여기서 pickCut 을 다시 구현하지 않는다(그러면 제 답을 제가 채점한다).
    // 조용해진 것(silent)이 있으면 그 자리는 툴팁을 잃은 것이다. 의도일 수도 아닐 수도 있어 **목록으로** 남긴다.
    const census = []
    const targets = all('[title], [data-tip]')
      .filter((el) => !el.closest('#tipcheck-wrap'))
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 3 && r.height > 3 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth
      })
      .slice(0, 90)
    for (const el of targets) {
      if (!el.isConnected) continue
      const tipText = el.getAttribute('title') || el.getAttribute('data-tip') || ''
      const shown = (el.textContent || '').replace(/\s+/g, ' ').trim()
      await rest()
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await sleep(620)
      census.push({
        who: el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '(무클래스)').split(' ').slice(0, 2).join('.'),
        tip: tipText.slice(0, 60),
        shown: shown.slice(0, 60),
        on: tipState().on
      })
    }
    out.census = census

    return out
  })()
}

// ── 판정(node 쪽) ───────────────────────────────────────────────────────────
// 재는 것과 판정하는 것을 갈라 둔다 — 원자료 JSON 만 보고도 이 판정을 다시 밟을 수 있어야 한다.
const EDGE = 8 // tooltip.ts 의 상수. 소스와 같은 값을 안 쓰고 여기 박아 뒀다(기존 검사와 같은 방식).
const GAP = 6
const TIPMAX = 380 // shell.css `.ara-tip` 의 max-width. 여기도 베껴 놓은 값이라 CSS 가 바뀌면 조용히 낡는다.

function judge(r) {
  const v = []
  const push = (id, pass, why) => v.push({ id, pass, why })

  // A — 잘린 셀에 뜨고, 그 줄 근처에 있고, 화면 왼쪽 끝(x=8)이 아니다.
  if (!r.A || !r.A.measured) push('A', null, '못 쟀다: ' + ((r.A && r.A.why) || 'A 자체가 없다'))
  else {
    const t = r.A.tip
    const td = r.A.raw.td
    const cut = td.scrollW > td.clientW + 1
    if (!t.on) push('A', false, `툴팁이 안 떴다 (셀 잘림 ${cut ? '있음' : '없음'}: scrollW ${td.scrollW} vs clientW ${td.clientW})`)
    else {
      const dy = Math.round(t.r.y + t.r.h / 2 - (td.r.y + td.r.h / 2))
      const near = Math.abs(dy) <= t.r.h + 40 // 위/아래 폴백이면 툴팁 높이+간격만큼 떨어진다
      const notEdge = Math.round(t.r.x) !== EDGE
      // 🔴 이 검사가 **증상을 재현할 수 있는 자리에서** 쟀는지를 함께 남긴다. 잰 사각형에 대한
      // 산술일 뿐 제품 로직을 베낀 게 아니다: `<tr>` 이 앵커였다면 좌우 여유가 둘 다 툴팁 폭에
      // 못 미쳐 옛 코드가 화면 왼쪽 끝(EDGE=8)으로 밀었을 자리인가. 아니면 A 는 통과해도
      // "고쳤다"의 증거가 아니다 — 옛 코드도 같은 값을 냈을 테니.
      const tr = r.A.raw.tr.r
      const tipW = t.r.w
      const roomR = Math.round(r.vw - tr.right - GAP - EDGE)
      const roomL = Math.round(tr.x - GAP - EDGE)
      const exercised = roomR < tipW && roomL < tipW
      push(
        'A',
        near && notEdge,
        `x=${t.r.x} y=${t.r.y} (셀 x=${td.r.x} y=${td.r.y}) · 세로차 ${dy}px ${near ? '근처다' : '멀다'} · x!==8 ${notEdge ? '만족' : '위반(왼쪽 끝에 붙었다)'}` +
          ` · 옛 배선 재현 ${exercised ? '가능(줄 앵커 여유 좌 ' + roomL + '/우 ' + roomR + ' < 툴팁폭 ' + tipW + ' → 옛 코드면 x=8)' : '불가(줄 앵커로도 여유가 있어 옛 코드도 8 이 아니었다 — 이 자리는 증상을 안 만든다)'}`
      )
    }
  }

  // B — 다 보이는 글자엔 안 뜬다.
  if (!r.B || !r.B.measured) push('B', null, '못 쟀다: ' + ((r.B && r.B.why) || 'B 자체가 없다'))
  else
    push(
      'B',
      !r.B.tip.on,
      r.B.tip.on ? `떴다(문구: ${r.B.tip.text})` : `안 떴다 (scrollW ${r.B.raw.td.scrollW} vs clientW ${r.B.raw.td.clientW})`
    )

  // C — 화면에 글자가 없는 title 은 그대로 뜬다(회귀 가드).
  if (!r.C || !r.C.measured) push('C', null, '못 쟀다: ' + ((r.C && r.C.why) || 'C 자체가 없다'))
  else
    push(
      'C',
      r.C.tip.on,
      `${r.C.raw.who} title=${JSON.stringify(r.C.raw.title)} → ${r.C.tip.on ? '떴다' : '🔴 안 떴다 — asIs 갈래가 죽었다'}`
    )

  // D — 좁은 앵커는 좌우에 붙는다(회귀 가드).
  if (!r.D || !r.D.measured) push('D', null, '못 쟀다: ' + ((r.D && r.D.why) || 'D 자체가 없다'))
  else if (!r.D.tip.on) push('D', false, '🔴 안 떴다 — 아이콘 바 툴팁이 죽었다')
  else {
    const t = r.D.tip.r
    const a = r.D.raw.r
    const side = t.right <= a.x + 1 ? 'left' : t.x >= a.right - 1 ? 'right' : 'overlap'
    const vOverlap = t.bottom > a.y && t.y < a.bottom
    push(
      'D',
      side !== 'overlap' && vOverlap,
      `앵커 ${a.w}x${a.h} @${a.x},${a.y} · 툴팁 @${t.x},${t.y} → ${side}${vOverlap ? ' · 세로 겹침 있음' : ' · 세로 안 겹침'}`
    )
  }

  // E — 넓은 앵커(줄 전체, asIs)는 위/아래로 간다. A 가 못 밟는 가지를 여기서 밟는다.
  if (!r.E || !r.E.measured) push('E', null, '못 쟀다: ' + ((r.E && r.E.why) || 'E 자체가 없다'))
  else if (!r.E.tip.on) push('E', false, '🔴 안 떴다 — 설명문 title 이 skip 으로 묶였다(asIs 가 죽었다)')
  else {
    const t = r.E.tip.r
    const a = r.E.raw.r
    const side = t.bottom <= a.y + 1 ? 'top' : t.y >= a.bottom - 1 ? 'bottom' : t.right <= a.x + 1 ? 'left' : t.x >= a.right - 1 ? 'right' : 'overlap'
    // 좌우로 갔다면 이 자리가 폴백을 안 밟은 것이다 — 통과시키면 ① 을 못 잰 채 잰 척하게 된다.
    push(
      'E',
      side === 'top' || side === 'bottom',
      `앵커(줄) ${a.w}x${a.h} @${a.x},${a.y} · 툴팁 ${t.w}x${t.h} @${t.x},${t.y} → ${side} · 가로가 줄 왼끝에 섰나 ${Math.abs(t.x - a.x) <= 1 ? '예' : '아니오(' + Math.round(t.x - a.x) + 'px 차)'}`
    )
  }

  // F — 띄어쓰기 없는 긴 cmd. **글자가 상자 안에 있나.** A~E 와 보는 것이 다르다(자리가 아니라 담김).
  if (!r.F || !r.F.measured) push('F', null, '못 쟀다: ' + ((r.F && r.F.why) || 'F 자체가 없다'))
  else if (!r.F.tip.on)
    push('F', false, `🔴 안 떴다 — 셀이 안 잘렸으면(scrollW ${r.F.raw.td.scrollW} vs clientW ${r.F.raw.td.clientW}) 합성 cmd 가 짧은 것이다`)
  else {
    const t = r.F.tip
    const over = t.sw - t.cw
    const fits = over <= 1
    const capped = t.r.w <= TIPMAX
    const inView = t.r.x >= 0 && t.r.right <= r.vw
    push(
      'F',
      fits && capped && inView,
      `상자 ${t.r.w}x${t.r.h} @${t.r.x},${t.r.y} · 글자 scrollW ${t.sw} vs clientW ${t.cw} → ` +
        (fits ? '안 넘는다' : `🔴 ${over}px 삐져나온다`) +
        ` · 폭<=${TIPMAX} ${capped ? '만족' : '위반'}` +
        ` · 창 안 ${inView ? '만족' : `위반(left ${t.r.x} / right ${t.r.right} / vw ${r.vw})`}` +
        ` · 끊을 수 없는 최장 덩어리 ${r.F.raw.longestRun}자`
    )
  }

  return v
}

// ── 실행 ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

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

  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(2500)

  const raw = await win.webContents.executeJavaScript(`(${probe.toString()})(${JSON.stringify({ wait: 900 })})`)
  const verdict = judge(raw)

  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), verdict, raw }, null, 1))

  console.log('─'.repeat(74))
  console.log('붙인 자리: ' + raw.mount)
  for (const n of raw.notes) console.log('  · ' + n)
  console.log('─'.repeat(74))
  for (const v of verdict) console.log(`${v.id}  ${v.pass === null ? '⚪ 못 쟀다' : v.pass ? '🟢 통과' : '🔴 실패'}  ${v.why}`)
  console.log('─'.repeat(74))
  const cen = raw.census || []
  const silent = cen.filter((c) => !c.on)
  console.log(`인구조사(판정 아님): 진짜 title ${cen.length}곳 중 ${cen.length - silent.length}곳이 떴다 · ${silent.length}곳은 조용하다`)
  for (const s of silent) console.log(`   조용함  ${s.who}  tip=${JSON.stringify(s.tip)}  화면글자=${JSON.stringify(s.shown)}`)
  console.log('─'.repeat(74))
  console.log('원자료: ' + REPORT)

  const bad = verdict.filter((v) => v.pass === false).length
  app.exit(bad ? 1 : 0)
})

setTimeout(() => {
  console.log('tip-check timeout')
  app.exit(1)
}, 300000)
