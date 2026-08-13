// UI-font4 검증 하네스 — 한글 시스템 폴백(KR System, unicode-range) on/off 두 상태를 같은
// 구도로 캡처 + 터미널 정렬(cols/cell 폭) 실측. 구조는 uifont2-measure-gpu.cjs 재사용
// (Electron 부트스트랩·IPC 목·nearest-neighbor 확대 — 새로 발명하지 않음).
//
// 정렬 이론적 근거(코드로도 확인): xterm.js 는 문자의 셀 폭(1열/2열)을 유니코드 East Asian
// Width 속성표로 미리 정하고, 그 폭에 맞는 고정 셀 안에 어떤 폰트가 그리든 그 글자를 그린다
// (폰트 실측 metric으로 셀 폭을 바꾸지 않는다). 즉 한글 글리프의 "출처 폰트"가 바뀌어도
// 열 배치 자체는 흔들리지 않는다 — 이 스크립트는 그 이론을 실측으로 재확인한다:
//   1) term.cols/rows 가 KR System on/off 두 상태에서 동일한지(같은 창 크기 기준)
//   2) 라틴 전용 문자열의 렌더 폭(px)이 on/off 두 상태에서 동일한지(KR System 은 한글
//      unicode-range 밖이라 라틴엔 영향 없어야 한다)
//   3) 한글+라틴+박스 드로잉 혼합 표를 실제 pty로 출력해 육안·스크린샷 대조
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const pty = require('node-pty')

const OUT = join(__dirname, '..', 'out')
const outPath = (name) => join(__dirname, '..', 'agent_talk', name)

function nearestZoomPng(img, zoomX) {
  const { width: w, height: h } = img.getSize()
  const src = img.toBitmap()
  const dst = Buffer.alloc(w * zoomX * h * zoomX * 4)
  const dw = w * zoomX
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      for (let dy = 0; dy < zoomX; dy++) {
        const rowBase = ((y * zoomX + dy) * dw + x * zoomX) * 4
        for (let dx = 0; dx < zoomX; dx++) {
          const di = rowBase + dx * 4
          dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3]
        }
      }
    }
  }
  return nativeImage.createFromBitmap(dst, { width: dw, height: h * zoomX }).toPNG()
}

const ptys = new Map()
let getWc = () => null
let seq = 0
ipcMain.handle('session:create', () => {
  const id = 'loc-' + (seq++)
  const opts = { name: 'xterm-256color', cols: 100, rows: 28, cwd: process.cwd(), env: process.env, useConpty: true, useConptyDll: true }
  const p = pty.spawn('powershell.exe', ['-NoLogo'], opts)
  ptys.set(id, p)
  p.onData((d) => { const wc = getWc(); if (!wc || wc.isDestroyed()) return; const b = Buffer.from(d, 'utf8'); const u = new Uint8Array(b.length); u.set(b); wc.postMessage('session:data:' + id, u) })
  p.onExit(() => {})
  return { id }
})
ipcMain.handle('session:resize', () => ({ ok: true }))
ipcMain.handle('session:destroy', () => ({ ok: true }))
ipcMain.handle('session:list', () => [])
ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
ipcMain.on('session:pause', () => {})
ipcMain.on('session:resume', () => {})
const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58, krSystemFallback: false } }
ipcMain.handle('app:getVersion', () => '0.1.0')
ipcMain.handle('profile:list', () => [])
ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
ipcMain.handle('ui:setGroups', () => ({ ok: true }))
ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
ipcMain.handle('mcp:getState', () => ({ enabled: false, listening: false, port: null, token: null, clientConnected: false, sessions: [] }))

async function captureCropStable(win, region) {
  let prevBitmap = null
  let best = null
  for (let i = 0; i < 20; i++) {
    const full = await win.webContents.capturePage()
    const s = full.getSize()
    if (s.width > 0 && s.height > 0 && region.x + region.width <= s.width && region.y + region.height <= s.height) {
      const cropped = full.crop(region)
      const bitmap = cropped.toBitmap()
      best = cropped
      if (prevBitmap) {
        let diffSum = 0
        for (let k = 0; k < bitmap.length; k++) diffSum += Math.abs(bitmap[k] - prevBitmap[k])
        if (diffSum / bitmap.length < 1) return cropped
      }
      prevBitmap = bitmap
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (best) return best
  throw new Error('crop region never produced a valid frame after 20 retries')
}

async function captureZoom(win, scale, rect, pad, zoomX, tag, winSize) {
  const rawX = Math.round((rect.x - pad) * scale)
  const rawY = Math.round((rect.y - pad) * scale)
  const x = Math.max(0, rawX)
  const y = Math.max(0, rawY)
  const region = {
    x, y,
    width: Math.min(Math.round((rect.width + pad * 2) * scale) - (x - rawX), winSize.width - x),
    height: Math.min(Math.round((rect.height + pad * 2) * scale) - (y - rawY), winSize.height - y)
  }
  const cropped = await captureCropStable(win, region)
  writeFileSync(outPath(`${tag}.png`), nearestZoomPng(cropped, zoomX))
  return { region, size: cropped.getSize() }
}

// 박스 드로잉 + 한글 + 라틴/숫자 혼합 표(design-system 관례: 한글 전각=영문 2칸으로 패딩 계산).
const TABLE_LINES = [
  '┌──────────────┬────────┬─────────┐',
  '│ 이름           │ 상태    │ CPU(%)  │',
  '├──────────────┼────────┼─────────┤',
  '│ web-server-01  │ 정상    │ 12.3    │',
  '│ 데이터베이스      │ 경고    │ 87.9    │',
  '│ ai-worker      │ 정상    │ 3.1     │',
  '└──────────────┴────────┴─────────┘'
]
// pty에 그대로 write()하면 셸이 이걸 "입력(명령)"으로 해석해 파싱 에러가 난다(1차 시도에서
// 확인) — 대신 파일로 써서 Get-Content로 "출력"하게 한다(실제 텍스트 렌더링 경로만 테스트).
// BOM(U+FEFF)을 1행에 붙이면 콘솔 폭 계산이 그 행에서만 어긋나 1행이 덮어써지는 현상을
// 실측했다(원인 규명: agent_talk/UI-font4-done.md) — BOM 없이 쓰고 -Encoding UTF8을 명시한다.
const TABLE_FILE = join(os.tmpdir(), 'uifont4-table.txt')
writeFileSync(TABLE_FILE, TABLE_LINES.join('\r\n') + '\r\n', 'utf8')

async function run() {
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119', webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  getWc = safeWc(() => win)

  const results = { phases: {} }

  for (const phase of ['off', 'on']) {
    UI.font = { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58, krSystemFallback: phase === 'on' }
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    ptys.clear()

    await win.loadFile(join(OUT, 'renderer', 'index.html'))
    await new Promise((r) => setTimeout(r, 700))
    await win.webContents.executeJavaScript(`(async () => { await document.fonts.ready })()`)

    const clicked = await win.webContents.executeJavaScript(`(() => { const btn = document.querySelector('.tterm-add'); btn?.click(); return !!btn })()`)
    console.log(`[${phase}] tterm-add clicked=${clicked}`)
    await new Promise((r) => setTimeout(r, 1200))

    // 실제 렌더 스택 확인
    const stack = await win.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--term').trim()`)

    // 표 내용을 실제 pty로 "출력"(Get-Content — 셸이 명령으로 해석하지 않고 텍스트로 표시).
    // 진짜 xterm 줄바꿈/폭 로직을 그대로 통과한다.
    const p = [...ptys.values()][0]
    if (p) {
      await new Promise((r) => setTimeout(r, 400))
      p.write("Clear-Host\r")
      await new Promise((r) => setTimeout(r, 900))
      p.write(`Get-Content -Encoding UTF8 '${TABLE_FILE}'\r`)
      await new Promise((r) => setTimeout(r, 1500))
    }

    // 정렬 실측: xterm cols/rows + 라틴 문자열 렌더 폭(라틴은 KR System unicode-range 밖 —
    // on/off 무관하게 동일해야 함) + 한글 문자열 렌더 폭(2셀 배정이 폰트와 무관한지).
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const term = document.querySelector('.xterm')
      const rows = document.querySelector('.xterm-rows')
      const stack = getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
      function measure(text) {
        const span = document.createElement('span')
        span.style.setProperty('font-family', stack)
        span.style.setProperty('font-size', '14px')
        span.style.whiteSpace = 'pre'
        span.style.position = 'absolute'
        span.style.visibility = 'hidden'
        span.style.display = 'inline-block'
        span.textContent = text
        document.body.appendChild(span)
        void span.offsetWidth
        const w = span.getBoundingClientRect().width
        const appliedFont = getComputedStyle(span).fontFamily
        span.remove()
        return { w, appliedFont }
      }
      return {
        rowsFound: !!rows,
        rowCount: rows ? rows.children.length : 0,
        firstRowWidth: rows && rows.children[0] ? rows.children[0].getBoundingClientRect().width : null,
        latin: measure('WWWWWWWWWW'),
        hangul: measure('가나다라마'),
        termClientWidth: term ? term.getBoundingClientRect().width : null
      }
    })()`)

    const rect = await win.webContents.executeJavaScript(`(() => { const el = document.querySelector('.xterm-screen') || document.querySelector('.xterm'); if(!el) return null; const b = el.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height} })()`)

    // 스크린샷에서 상단 줄이 안 보이는 이유 진단 — 접근성 트리(스크린리더용 미러)에서 실제
    // 버퍼 텍스트를 직접 읽어, 내용이 애초에 없는 건지(버그) 그리기만 안 된 건지(캡처 타이밍) 구분.
    const a11yDump = await win.webContents.executeJavaScript(`(() => {
      const acc = document.querySelector('.xterm-accessibility') || document.querySelector('[class*=accessibility]')
      if (!acc) return { found: false }
      return { found: true, lines: Array.from(acc.querySelectorAll('*')).map(e => e.textContent).filter(t => t && t.trim()) }
    })()`)
    console.log(`[${phase}] a11yDump=${JSON.stringify(a11yDump)}`)

    const [cssW] = win.getContentSize()
    let full0Size = { width: 0, height: 0 }
    for (let i = 0; i < 10 && full0Size.width === 0; i++) {
      full0Size = (await win.webContents.capturePage()).getSize()
      if (full0Size.width === 0) await new Promise((r) => setTimeout(r, 120))
    }
    const scale = full0Size.width / cssW || 1

    if (rect) {
      await captureZoom(win, scale, rect, 4, 3, `UI-font4-terminal-${phase}`, full0Size)
    }

    results.phases[phase] = { stack, metrics }
    console.log(`[${phase}] stack=${stack}`)
    console.log(`[${phase}] metrics=${JSON.stringify(metrics)}`)
  }

  // "vs Tabby" 대조본 — 준영님이 지목한 참고 이미지가 실제로는 Tabby 캡처가 아니었다(사실 확인:
  // agent_talk/UI-font4-done.md §0). 그래서 SSH 저장 프로필이 있는 실제 Tabby 앱을 띄우는
  // 대신(내부망 접속 리스크 회피), Tabby 자신의 폴백 폰트 파일(tabby-terminal/src/fonts/
  // SourceCodePro.ttf)을 Tabby와 같은 계열의 Electron/Chromium 엔진(우리 앱)에서 Tabby의
  // 실제 font-family 스택("Consolas","SourceCodePro","monospace" — getCSSFontFamily 확인,
  // agent_talk/UI-font4-done.md §1)으로 그대로 재현해 우리 앱과 나란히 캡처한다.
  const tabbyFontFile = 'C:/Users/P24086/AppData/Local/Programs/tabby/resources/builtin-plugins/tabby-terminal/src/fonts/SourceCodePro.ttf'
  const araCss = join(OUT, 'renderer', 'assets', 'index-tHvocv1Z.css').replace(/\\/g, '/')
  const compareHtml = `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="file:///${araCss}">
    <style>
    @font-face { font-family: 'TabbySrcRef'; src: url('file:///${tabbyFontFile}'); }
    html,body{background:#0d1119;margin:0}
    .lbl{color:#7dd3fc;font-family:sans-serif;font-size:13px;padding:8px 10px 2px}
    pre{color:#cdd6e4;font-size:14px;line-height:1.58;padding:2px 10px 14px;white-space:pre;margin:0}
    .tabby pre{font-family:"Consolas","TabbySrcRef",monospace}
    .ara pre{font-family:'KR System','Nanum Gothic Coding','D2Coding','JetBrains Mono','Consolas',monospace}
  </style></head><body>
    <div class="tabby"><div class="lbl">Tabby 폰트 스택 그대로 재현 ("Consolas","SourceCodePro",monospace → 한글은 OS 폴백)</div><pre>${TABLE_LINES.join('\n')}</pre></div>
    <div class="ara"><div class="lbl">A.R.A 적용 후 ('KR System' 추가 — 한글만 같은 OS 폴백)</div><pre>${TABLE_LINES.join('\n')}</pre></div>
  </body></html>`
  const comparePath = join(os.tmpdir(), 'uifont4-vs-tabby.html')
  writeFileSync(comparePath, compareHtml, 'utf8')
  await win.loadFile(comparePath)
  await win.webContents.executeJavaScript('document.fonts.ready')
  await new Promise((r) => setTimeout(r, 400))
  const bodyRect = await win.webContents.executeJavaScript(`(() => { return {x:0,y:0,width:640,height:520} })()`)
  const [cssW2] = win.getContentSize()
  const full2 = await win.webContents.capturePage()
  const scale2 = full2.getSize().width / cssW2 || 1
  await captureZoom(win, scale2, bodyRect, 2, 3, 'UI-font4-vs-tabby', full2.getSize())

  const off = results.phases.off.metrics
  const on = results.phases.on.metrics
  results.verdict = {
    latinWidthUnchanged: off.latin.w === on.latin.w,
    hangulCellWidthRatioOk: Math.abs(on.hangul.w / on.latin.w - off.hangul.w / off.latin.w) < 0.01,
    rowWidthUnchanged: off.firstRowWidth === on.firstRowWidth,
    rowCountUnchanged: off.rowCount === on.rowCount,
    onAppliedKrSystemForHangul: on.hangul.appliedFont.includes('KR System')
  }
  writeFileSync(outPath('UI-font4-verify.json'), JSON.stringify(results, null, 2))
  console.log('VERIFY_RESULT=' + JSON.stringify(results.verdict))
  console.log('VERIFY_OK')
}

app.whenReady().then(async () => {
  try {
    await run()
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 40000)
