// 브랜드 SVG → 1024×1024 PNG. electron-builder 는 512px 이상 PNG 를 주면 Windows .ico 와
// mac .icns 를 알아서 만든다 — .ico 6종을 손으로 만들 필요가 없다.
//
// 왜 Electron 으로 그리나: 이 저장소에는 sharp·imagemagick 이 없고, 아이콘 한 장 때문에 빌드
// 체인에 의존성을 얹을 이유가 없다. 우리는 이미 Electron 으로 화면을 찍는 하네스를 여럿 갖고 있다
// (tests/*-screenshot.cjs) — 같은 방식이다.
// ⚠️ 이 PC 의 `convert` 는 imagemagick 이 아니라 Windows 의 디스크 포맷 변환 도구다. 쓰지 말 것.
//
// 로고가 바뀌면 다시 돌린다: npm run icons:png
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 1024
const SRC = join(__dirname, '..', 'resources', 'icons', 'ara-icon.svg')
const OUT = join(__dirname, '..', 'resources', 'icons', 'ara-icon.png')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = readFileSync(SRC, 'utf8')
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    // 투명 배경 — 아이콘은 배경이 비어 있어야 OS 가 알아서 얹는다.
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })

  // SVG 를 그대로 문서에 심는다(파일 URL 로 열면 viewBox 스케일이 기기 배율을 타 크기가 흔들린다).
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
    svg{width:${SIZE}px;height:${SIZE}px;display:block}
  </style>${svg}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // 폰트·필터가 자리를 잡을 시간(첫 페인트만으로는 필터가 덜 그려지는 경우가 있다).
  await new Promise((r) => setTimeout(r, 400))

  /**
   * **화면 크기와 무관하게** 1024×1024 를 뽑는다.
   *
   * 예전엔 `capturePage()` 였는데, 그건 창이 실제로 차지한 만큼만 찍는다 — 이 PC 처럼 화면
   * 높이가 1024 보다 작으면 창이 잘려 `1024×901` 같은 **비정사각** PNG 가 나오고,
   * electron-builder 는 그걸 아이콘으로 못 쓴다(2026-08-23 실제로 이렇게 났다).
   * 그래서 DevTools 프로토콜로 **뷰포트를 강제**하고 그 밖까지 찍는다.
   */
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: SIZE,
    height: SIZE,
    deviceScaleFactor: 1,
    mobile: false
  })
  const shot = await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 }
  })
  dbg.detach()
  const png = Buffer.from(shot.data, 'base64')
  writeFileSync(OUT, png)

  // 정말 정사각 1024 인지 PNG 헤더(IHDR)에서 직접 읽어 확인한다 — 크기를 믿지 않고 잰다.
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  console.log(`icon: ${OUT} ${width}x${height} ${(png.length / 1024).toFixed(1)}KB`)
  if (width !== SIZE || height !== SIZE) {
    console.error(`FAIL: ${SIZE}x${SIZE} 가 아니다 (${width}x${height})`)
    app.exit(1)
    return
  }
  app.exit(0)
})
