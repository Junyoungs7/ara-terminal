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

  const img = await win.webContents.capturePage()
  const png = img.toPNG()
  writeFileSync(OUT, png)
  const { width, height } = img.getSize()
  console.log(`icon: ${OUT} ${width}x${height} ${(png.length / 1024).toFixed(1)}KB`)
  if (width < 512 || height < 512) {
    console.error(`FAIL: electron-builder 는 512px 이상을 요구한다 (${width}x${height})`)
    app.exit(1)
    return
  }
  app.exit(0)
})
