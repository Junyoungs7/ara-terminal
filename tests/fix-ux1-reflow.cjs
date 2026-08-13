// 창 축소 시 터미널 줄 간격/줄바꿈 이상 재현 하네스 (실사용 피드백 #6).
// 넓은 폭에서 dir 급 출력을 만든 뒤 창을 좁혔다 넓혔다 하며
//  (a) 버퍼에 빈 줄이 끼는지, (b) 렌더된 행 높이(줄 간격)가 변하는지, (c) resize 가 몇 번 도는지를 실측한다.
// 산출물: agent_talk/FIX-ux1-reflow.png (축소 후 상태)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

const ptys = new Map()
let getWc = () => null
const resizeLog = []

function wire() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 120, rows: 30, cwd: join(__dirname, '..', 'src'), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
    p.onExit(({ exitCode }) => { const wc = getWc(); if (wc && !wc.isDestroyed()) wc.send('session:exit:' + id, { id, exitCode }); ptys.delete(id) })
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => {
    resizeLog.push({ t: Date.now(), cols, rows })
    try { ptys.get(id)?.resize(cols, rows) } catch {}
    return { ok: true }
  })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

// 터미널 상태 스냅샷: 버퍼 텍스트 + 렌더된 행 geometry + xterm 치수.
const PROBE = `(() => {
  const el = document.querySelector('.pane-body .xterm') || document.querySelector('.xterm')
  const rowsEl = document.querySelector('.xterm-rows')
  const rowDivs = rowsEl ? [...rowsEl.children] : []
  const heights = rowDivs.slice(0, 12).map(r => Math.round(r.getBoundingClientRect().height * 100) / 100)
  const cs = rowsEl ? getComputedStyle(rowsEl) : null
  const text = rowDivs.map(r => r.textContent.replace(/\\u00a0/g, ' ').replace(/\\s+$/, '')).join('\\n')
  const lines = text.split('\\n')
  // 내용이 있는 마지막 줄까지에서 "중간에 낀 빈 줄" 개수 — 리플로우로 벌어진 간격의 실체.
  let last = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) last = i
  let interior = 0
  for (let i = 0; i <= last; i++) if (!lines[i].trim()) interior++
  const screen = document.querySelector('.xterm-screen')
  const host = document.querySelector('.term-pane')
  const xt = document.querySelector('.term-pane .xterm')
  const hs = host ? getComputedStyle(host) : null
  const xs = xt ? getComputedStyle(xt) : null
  return {
    roHits: window.__roHits || null,
    hostClient: host ? [host.clientWidth, host.clientHeight] : null,
    hostComputed: hs ? [hs.width, hs.height] : null,
    xtermParentIsHost: !!(xt && host && xt.parentElement === host),
    xtermComputed: xs ? [xs.width, xs.height] : null,
    rowHeights: heights,
    rowsLineHeight: cs ? cs.lineHeight : '',
    rowsFontSize: cs ? cs.fontSize : '',
    screenH: screen ? Math.round(screen.getBoundingClientRect().height) : 0,
    innerW: window.innerWidth, innerH: window.innerHeight,
    paneW: Math.round((document.querySelector('.term-pane')||{getBoundingClientRect:()=>({width:0,height:0})}).getBoundingClientRect().width),
    paneH: Math.round((document.querySelector('.term-pane')||{getBoundingClientRect:()=>({width:0,height:0})}).getBoundingClientRect().height),
    rowCount: rowDivs.length,
    interiorBlanks: interior,
    contentLines: last + 1,
    text: lines.slice(0, last + 1).join('\\n')
  }
})()`

async function capture(win, name) {
  const [w, h] = win.getSize()
  win.setSize(w - 1, h); await new Promise((r) => setTimeout(r, 250))
  win.setSize(w, h); await new Promise((r) => setTimeout(r, 350))
  let img = await win.webContents.capturePage()
  if (img.toPNG().length === 0) { await new Promise((r) => setTimeout(r, 800)); img = await win.webContents.capturePage() }
  writeFileSync(shotPath(name), img.toPNG())
  console.log('SCREENSHOT ' + name + ' bytes=' + img.toPNG().length)
}

const checks = []

app.whenReady().then(async () => {
  let win
  getWc = safeWc(() => win)
  wire()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119',
    // backgroundThrottling:false 가 없으면 창이 가려질 때 렌더 루프가 멈춰
    // ResizeObserver/rAF 콜백이 아예 배달되지 않는다(측정이 통째로 무효가 된다).
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true)
  win.show(); win.focus()
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1200))

  // 로컬 셸 열기(＋ → 로컬 셸).
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(250)
    const it = document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')
    if (it) it.click(); else document.querySelector('.tterm-add')?.click()
    await wait(1200)
  })()`)

  // dir 급 출력 생성.
  for (const [, p] of ptys) p.write('dir\r')
  await new Promise((r) => setTimeout(r, 2500))

  const before = await win.webContents.executeJavaScript(PROBE)
  console.log('--- WIDE (1440) ---')
  console.log('  winSize=' + JSON.stringify(win.getSize()) + ' inner=' + before.innerW + 'x' + before.innerH + ' pane=' + before.paneW + 'x' + before.paneH)
  console.log('  rowCount=' + before.rowCount + ' screenH=' + before.screenH)
  console.log('  rowHeights=' + JSON.stringify(before.rowHeights))
  console.log('  lineHeight=' + before.rowsLineHeight + ' fontSize=' + before.rowsFontSize)
  console.log('  contentLines=' + before.contentLines + ' interiorBlanks=' + before.interiorBlanks)

  await capture(win, 'FIX-ux1-reflow-wide.png')
  const resizesBefore = resizeLog.length

  // 같은 대상에 우리 RO 를 걸어 "관측 자체가 되는지"를 앱 RO 와 분리해 확인한다.
  await win.webContents.executeJavaScript(`(() => {
    window.__roHits = []
    const host = document.querySelector('.term-pane')
    window.__roProbe = new ResizeObserver((es) => {
      window.__roHits.push([Math.round(es[0].contentRect.width), Math.round(es[0].contentRect.height)])
    })
    window.__roProbe.observe(host)
    return true
  })()`)

  // 창 축소 — 사용자 시나리오(넓은 상태에서 출력 후 줄이기).
  win.setSize(760, 620)
  await new Promise((r) => setTimeout(r, 2500))
  console.log('  (setSize applied) winSize=' + JSON.stringify(win.getSize()))

  const after = await win.webContents.executeJavaScript(PROBE)
  console.log('--- NARROW (760) ---')
  console.log('  inner=' + after.innerW + 'x' + after.innerH + ' pane=' + after.paneW + 'x' + after.paneH)
  console.log('  rowCount=' + after.rowCount + ' screenH=' + after.screenH)
  console.log('  rowHeights=' + JSON.stringify(after.rowHeights))
  console.log('  lineHeight=' + after.rowsLineHeight + ' fontSize=' + after.rowsFontSize)
  console.log('  contentLines=' + after.contentLines + ' interiorBlanks=' + after.interiorBlanks)
  console.log('  RO 콜백(우리 프로브) = ' + JSON.stringify(after.roHits))
  console.log('  host client=' + JSON.stringify(after.hostClient) + ' computed=' + JSON.stringify(after.hostComputed))
  console.log('  xterm.parent===host ? ' + after.xtermParentIsHost + ' xterm computed=' + JSON.stringify(after.xtermComputed))
  console.log('  resize IPC during shrink = ' + (resizeLog.length - resizesBefore))
  console.log('  last resizes = ' + JSON.stringify(resizeLog.slice(-6)))
  console.log('--- NARROW TEXT (앞 25줄) ---')
  console.log(after.text.split('\n').slice(0, 25).map((l, i) => String(i).padStart(2) + '|' + l).join('\n'))

  await capture(win, 'FIX-ux1-reflow.png')

  // 다시 확대 → 원복되는지.
  win.setSize(1440, 900)
  await new Promise((r) => setTimeout(r, 2000))
  const back = await win.webContents.executeJavaScript(PROBE)
  console.log('--- BACK TO WIDE ---')
  console.log('  rowHeights=' + JSON.stringify(back.rowHeights))
  console.log('  contentLines=' + back.contentLines + ' interiorBlanks=' + back.interiorBlanks)

  // 축소/확대 3회 반복 — 매번 어긋나지 않는지(누적되지 않는지) 확인.
  let worst = 0
  for (let i = 0; i < 3; i++) {
    win.setSize(700 + i * 40, 560 + i * 30)
    await new Promise((r) => setTimeout(r, 1200))
    const n = await win.webContents.executeJavaScript(PROBE)
    worst = Math.max(worst, n.interiorBlanks)
    win.setSize(1440, 900)
    await new Promise((r) => setTimeout(r, 1200))
    const w = await win.webContents.executeJavaScript(PROBE)
    worst = Math.max(worst, w.interiorBlanks)
    console.log(`  cycle ${i + 1}: narrow blanks=${n.interiorBlanks} / wide blanks=${w.interiorBlanks}`)
  }
  checks.push(['축소·확대 3회 반복해도 빈 줄이 누적되지 않음', worst <= before.interiorBlanks])

  // 판정: 행 높이(줄 간격)가 리사이즈로 변하면 안 되고, 중간 빈 줄이 늘면 안 된다.
  const uniq = (a) => [...new Set(a)]
  checks.push(['행 높이가 리사이즈 전후 동일(줄 간격 불변)', uniq([...before.rowHeights, ...after.rowHeights, ...back.rowHeights]).length === 1])
  checks.push(['축소 시 중간 빈 줄이 늘지 않음', after.interiorBlanks <= before.interiorBlanks])
  checks.push(['확대 복귀 시 중간 빈 줄이 늘지 않음', back.interiorBlanks <= before.interiorBlanks])

  let ok = true
  for (const [name, pass] of checks) { console.log((pass ? 'PASS ' : 'FAIL ') + name); if (!pass) ok = false }
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(ok ? 0 : 1)
})

setTimeout(() => { console.log('FAIL timeout (70s)'); app.exit(1) }, 70000)
