// UI-font4 — 준영님이 실제로 캡처한 Tabby 화면(참고 이미지, Tabby 안에서 Claude Code 실행 중)의
// 첫 줄 한글과, 우리 앱의 KR System 적용 후 같은 문장을 나란히 캡처(팀장 정정 반영: 그 이미지는
// 실제 Tabby 캡처였다 — agent_talk/UI-font4-done.md §0 갱신용 증거).
const { app, BrowserWindow, nativeImage } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, readFileSync } = require('node:fs')
const os = require('node:os')

const OUT = join(__dirname, '..', 'out')
const outPath = (n) => join(__dirname, '..', 'agent_talk', n)
const REF = 'C:/Users/P24086/Pictures/Screenshots/아라 폰트.png'
const SENTENCE = '높이 가설을 실제로 실험해봤고, 아쉽게도 효과가 없었습니다.'

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

app.whenReady().then(async () => {
  try {
    // 1) 참고 이미지 첫 줄(한글 문장) 크롭 + 4배 확대
    const refImg = nativeImage.createFromPath(REF)
    const refCropped = refImg.crop({ x: 0, y: 0, width: refImg.getSize().width, height: 34 })
    writeFileSync(outPath('UI-font4-realtabby-line.png'), nearestZoomPng(refCropped, 4))

    // 2) 우리 앱 KR System 스택으로 같은 문장 렌더
    const araCss = join(OUT, 'renderer', 'assets', 'index-tHvocv1Z.css').replace(/\\/g, '/')
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="file:///${araCss}">
      <style>html,body{background:#0d1119;margin:0}
      pre{color:#cdd6e4;font-family:'KR System','Nanum Gothic Coding','D2Coding','JetBrains Mono','Consolas',monospace;
      font-size:14px;line-height:1.58;padding:6px 10px;white-space:pre;margin:0}</style>
      </head><body><pre>${SENTENCE}</pre></body></html>`
    const p = join(os.tmpdir(), 'uifont4-realtabby.html')
    writeFileSync(p, html, 'utf8')
    const win = new BrowserWindow({ width: 1000, height: 120, show: true, frame: false, backgroundColor: '#0d1119' })
    await win.loadFile(p)
    await win.webContents.executeJavaScript('document.fonts.ready')
    await new Promise((r) => setTimeout(r, 300))
    const rect = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('pre').getBoundingClientRect(); return {x:0,y:0,width:Math.ceil(b.width)+20,height:Math.ceil(b.height)+12} })()`)
    const [cssW] = win.getContentSize()
    const full = await win.webContents.capturePage()
    const scale = full.getSize().width / cssW || 1
    const region = { x: 0, y: 0, width: Math.min(Math.round(rect.width * scale), full.getSize().width), height: Math.min(Math.round(rect.height * scale), full.getSize().height) }
    const cropped = full.crop(region)
    writeFileSync(outPath('UI-font4-realtabby-ours.png'), nearestZoomPng(cropped, 3))

    console.log('REALTABBY_COMPARE_OK')
  } catch (e) {
    console.log('ERROR: ' + (e && e.stack || e))
  } finally {
    app.exit(0)
  }
})
setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 20000)
