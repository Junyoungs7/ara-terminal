// UI-font2 진단 하네스(disable-gpu — CI/헤드리스에서도 재현 가능한 소프트웨어 래스터 버전) —
// "scrollHeight==clientHeight는 잉크 오버플로를 못 잡는다"는 지적을 실측으로 검증한다. 방법:
// 문제 요소의 overflow를 hidden→visible로 토글해 같은 영역을 확대 캡처하고, 박스 상단보다
// 위쪽 밴드에 새 잉크(비배경 픽셀)가 나타나는지 픽셀 diff.
// GPU 가속 버전은 tests/uifont2-measure-gpu.cjs — 둘 다 같은 결론(클리핑 없음)을 냈다
// (agent_talk/UI-font2-done.md §1, 두 렌더 경로 상호 검증).
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const outPath = (name) => join(__dirname, '..', 'agent_talk', name)

// nativeImage.resize({quality})는 보간(스무딩)을 해서 ClearType 서브픽셀 색을 섞어버린다 —
// 원본에 없는 무지개 번짐을 만드는 주범. 보간 없이 각 원본 픽셀을 zoomX×zoomX 블록으로
// 그대로 복제해 "실제로 렌더된 픽셀"을 왜곡 없이 키운다.
function nearestZoomPng(img, zoomX) {
  const { width: w, height: h } = img.getSize()
  const src = img.toBitmap() // BGRA (Windows/nativeImage 순서), 그대로 복제하므로 채널 순서는 무관.
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
ipcMain.handle('session:create', () => {
  const id = 'loc-' + Math.random().toString(36).slice(2)
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
const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 } }
ipcMain.handle('app:getVersion', () => '0.1.0')
ipcMain.handle('profile:list', () => [])
ipcMain.handle('workspace:load', () => ({ schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {}, layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [], ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko' } }))
ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
ipcMain.handle('ui:setGroups', () => ({ ok: true }))
ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
ipcMain.handle('mcp:getState', () => ({ enabled: false, listening: false, port: null, token: null, clientConnected: false, sessions: [] }))

// capturePage()가 "레이어 합성 전" 프레임을 돌려줄 수 있다 — 그런데 그게 정확히 어느
// 부분(전체 화면 어딘가엔 항상 뭔가 그려져 있으므로 "전체 화면에 배경과 다른 픽셀이 있는지"로는
// 특정 크롭 영역이 아직 안 그려진 걸 못 잡는다). 그래서 안전하게: **크롭한 그 영역 자체**를
// 두 번 연속 캡처해 바이트가 똑같아질 때까지(=그 영역이 안정됐을 때까지) 재시도한다.
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
        // 서브픽셀 AA/리드백 잡음 등 미세한 프레임 간 흔들림은 허용(픽셀당 평균 채널차 <1).
        let diffSum = 0
        for (let k = 0; k < bitmap.length; k++) diffSum += Math.abs(bitmap[k] - prevBitmap[k])
        if (diffSum / bitmap.length < 1) return cropped
      }
      prevBitmap = bitmap
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (best) return best // 완전히 안정화 안 돼도 마지막 캡처는 유효한 프레임이니 그걸로 진행.
  throw new Error('crop region never produced a valid frame after 20 retries')
}

// 캡처 영역(el 위쪽 여유 pad px 포함) → 8배 확대 PNG. 상태바처럼 창 맨 아래에 붙은 요소는
// pad 만큼 내려가면 실제 창 높이를 넘을 수 있으므로 프레임 크기(winSize)로 잘라낸다.
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
  writeFileSync(outPath(`UI-font2-${tag}.png`), nearestZoomPng(cropped, zoomX))
  return { region, bitmap: cropped.toBitmap(), size: cropped.getSize() }
}

// RGBA 비트맵 두 개의 "상단 밴드"(el 원래 top 위쪽, pad*scale px 높이)를 비교해
// 배경색과 다른(=잉크로 보이는) 픽셀 수를 센다. 배경은 각 비트맵의 좌상단 코너 픽셀로 추정.
function inkPixelsInTopBand(bitmap, size, bandHeightPx, bgTolerance) {
  let count = 0
  const bg = [bitmap[0], bitmap[1], bitmap[2]]
  for (let y = 0; y < Math.min(bandHeightPx, size.height); y++) {
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4
      const dr = Math.abs(bitmap[i] - bg[0])
      const dg = Math.abs(bitmap[i + 1] - bg[1])
      const db = Math.abs(bitmap[i + 2] - bg[2])
      if (dr + dg + db > bgTolerance) count++
    }
  }
  return count
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1440, height: 900, show: true, frame: false, backgroundColor: '#0d1119', webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
    getWc = safeWc(() => win)
    await win.loadFile(join(OUT, 'renderer', 'index.html'))
    await new Promise((r) => setTimeout(r, 700))
    const clicked = await win.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready
      const btn = document.querySelector('.tterm-add')
      btn?.click()
      return !!btn
    })()`)
    console.log('tterm-add clicked=' + clicked)
    await new Promise((r) => setTimeout(r, 1200))

    const info = await win.webContents.executeJavaScript(`(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: b.x, y: b.y, width: b.width, height: b.height, fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight, text: el.textContent } }
      return {
        dpr: window.devicePixelRatio,
        sessName: r('.sess-node .sess-name'),
        sbLbl: r('.sb-seg.host .lbl'),
        tlabel: r('.ttab .tlabel')
      }
    })()`)

    const [cssW] = win.getContentSize()
    let full0Size = { width: 0, height: 0 }
    for (let i = 0; i < 10 && full0Size.width === 0; i++) {
      full0Size = (await win.webContents.capturePage()).getSize()
      if (full0Size.width === 0) await new Promise((r) => setTimeout(r, 120))
    }
    console.log('cssW=' + cssW + ' full0Size=' + JSON.stringify(full0Size))
    const scale = full0Size.width / cssW || 1

    const PAD = 10 // el 위쪽 10px 여유(잉크가 그 안에서 나타나는지 본다)
    const ZOOM = 8
    const targets = [
      { sel: '.sess-node .sess-name', key: 'sessName', tag: 'sessname' },
      { sel: '.sb-seg.host .lbl', key: 'sbLbl', tag: 'sblbl' },
      { sel: '.ttab .tlabel', key: 'tlabel', tag: 'tlabel' }
    ]

    const results = { dpr: info.dpr, scale, elements: {} }

    for (const t of targets) {
      const rect = info[t.key]
      if (!rect) { results.elements[t.tag] = { found: false }; continue }

      // 1) hidden(현재 상태) 캡처
      const before = await captureZoom(win, scale, rect, PAD, ZOOM, `${t.tag}-A-hidden`, full0Size)

      // 2) overflow: visible 로 토글 후 같은 영역 재캡처
      await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(t.sel)}); if (el) { el.dataset.ofa2Prev = el.style.overflow; el.style.overflow = 'visible' } })()`)
      await new Promise((r) => setTimeout(r, 80))
      const after = await captureZoom(win, scale, rect, PAD, ZOOM, `${t.tag}-B-visible`, full0Size)

      // 3) 원복
      await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(t.sel)}); if (el) { el.style.overflow = el.dataset.ofa2Prev || ''; delete el.dataset.ofa2Prev } })()`)

      // 4) 박스 원래 top 위쪽 밴드(PAD*scale*ZOOM px 높이)에서 잉크 픽셀 수 비교
      const bandPx = Math.round(PAD * scale * ZOOM)
      const inkBefore = inkPixelsInTopBand(before.bitmap, before.size, bandPx, 30)
      const inkAfter = inkPixelsInTopBand(after.bitmap, after.size, bandPx, 30)

      results.elements[t.tag] = {
        found: true, sel: t.sel, text: rect.text, fontFamily: rect.fontFamily, fontSize: rect.fontSize, lineHeight: rect.lineHeight,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        topBandInkPixels_hiddenOverflow: inkBefore,
        topBandInkPixels_visibleOverflow: inkAfter,
        extraInkRevealedByVisible: inkAfter - inkBefore,
        verdict: (inkAfter - inkBefore) > 5 ? 'CLIPPED(오버플로 잉크가 실제로 잘려 있었음)' : '차이 없음(오버플로 클리핑 아님)'
      }
    }

    writeFileSync(outPath('UI-font2-measure.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
    console.log('MEASURE_OK')
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    for (const p of ptys.values()) { try { p.kill() } catch {} }
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 30000)
