// 목업 HTML → PNG. `npm run shoot -- mockups/foo.html [...]`
//
// 이 저장소는 UI 를 **목업 먼저** 정한다(준영님 규칙 — HTML 목업 여러 판을 나란히 놓고 고른다).
// 그런데 그 판들을 눈으로 비교하려면 그림이 필요했고, 그때마다 임시 스크립트를 새로 썼다.
// 한 번 만들어 둔다.
//
// ⚠️ **창을 띄우지 않는다**(`show:false` + `offscreen`). 준영님이 쓰고 계신 화면 위로 창이 뜨면
// 그 자체가 방해다 — make-icon-png.cjs 와 같은 규율이다.
//
// 왜 Electron 인가: 이 저장소에 헤드리스 브라우저가 따로 없고, 목업은 앱과 같은 크로미움에서
// 봐야 폰트·서브픽셀이 실제와 같다. 새 의존성을 얹지 않는다.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { resolve, basename } = require('node:path')

const W = Number(process.env.SHOOT_W || 1200)
const H = Number(process.env.SHOOT_H || 760)
const files = process.argv.slice(2).filter((a) => a.endsWith('.html'))

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  if (files.length === 0) {
    console.error('쓸 파일이 없습니다. 예: electron scripts/shoot-mockup.cjs mockups/a.html')
    app.exit(1)
    return
  }
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })

  for (const f of files) {
    const src = resolve(f)
    await win.loadFile(src)
    // 폰트·그라디언트가 자리를 잡을 시간. 첫 페인트만으로는 웹폰트가 덜 그려진다.
    await new Promise((r) => setTimeout(r, 500))

    // **뷰포트를 강제**한다 — 창이 화면보다 크면 capturePage 가 잘린다(make-icon-png.cjs 의 그 함정).
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false
    })
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: W, height: H, scale: 1 }
    })
    dbg.detach()

    const png = Buffer.from(shot.data, 'base64')
    const out = src.replace(/\.html$/, '.png')
    writeFileSync(out, png)
    console.log(`${basename(out)}  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}  ${(png.length / 1024).toFixed(0)}KB`)
  }
  app.exit(0)
})
