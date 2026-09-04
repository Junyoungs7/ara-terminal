// 브랜드 SVG → 멀티사이즈 Windows .ico (16·24·32·48·64·128·256).
//
// **왜 손으로 굽나:** electron-builder 는 PNG 를 주면 .ico 를 만들어 주긴 하는데 **256 한 장짜리**로
// 만든다. 작업 표시줄·Alt+Tab·탐색기는 16·24·32·48 을 쓰므로, 그 크기가 없으면 Windows 가 PNG 로
// 압축된 256 을 억지로 줄이고 그 경로에서 셸이 깨진 그림을 낸다(2026-09-04 0.9.9 설치본에서 실제로).
//
// **크기마다 판이 다르다**(디자인 시스템 §8.2): 64px 이하는 랙을 덜어낸 assets/brand/ara-favicon.svg,
// 128 이상은 전체 판 resources/icons/ara-icon.svg. 1024 를 줄이지 않고 각 크기로 직접 렌더한다 —
// 벡터라 그게 훨씬 또렷하다.
//
// **256 만 PNG, 나머지는 DIB.** ICO 안의 PNG 엔트리는 Vista+ 에서만 읽히고 작은 크기에서는 셸 경로마다
// 지원이 갈린다. 지금 깨진 이유가 정확히 "PNG 256 하나뿐"이다.
//
// 왜 Electron 으로 그리나: 이 저장소에는 sharp·imagemagick 이 없고, 아이콘 때문에 빌드 체인에
// 의존성을 얹을 이유가 없다(make-icon-png.cjs 와 같은 방식).
// ⚠️ 이 PC 의 `convert` 는 imagemagick 이 아니라 Windows 의 디스크 포맷 변환 도구다. 쓰지 말 것.
//
// 로고가 바뀌면 셋을 다 돌린다: npm run icons:svg → icons:png → icons:ico
// 되뽑아 눈으로 보려면: electron scripts/make-icon-ico.cjs --extract <폴더>
const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const FULL = join(ROOT, 'resources', 'icons', 'ara-icon.svg')
const SMALL = join(ROOT, 'assets', 'brand', 'ara-favicon.svg')
const OUT = join(ROOT, 'resources', 'icons', 'ara-icon.ico')

/** 크기 → 어느 판을 쓰고 어떤 포맷으로 넣나. 64 이하는 덜어낸 판, 256 만 PNG. */
const PLAN = [
  { size: 16, src: SMALL, png: false },
  { size: 24, src: SMALL, png: false },
  { size: 32, src: SMALL, png: false },
  { size: 48, src: SMALL, png: false },
  { size: 64, src: SMALL, png: false },
  { size: 128, src: FULL, png: false },
  { size: 256, src: FULL, png: true }
]

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

/**
 * SVG 를 정확히 size×size PNG 로 찍는다.
 *
 * `capturePage()` 를 쓰지 않는 이유는 make-icon-png.cjs 에 적혀 있다 — 창이 화면보다 크면 잘려
 * 비정사각이 나온다. 그래서 DevTools 프로토콜로 뷰포트를 강제하고 그 밖까지 찍는다.
 */
async function render(win, svg, size) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    svg{width:${size}px;height:${size}px;display:block}
  </style>${svg}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // 폰트·필터가 자리를 잡을 시간(첫 페인트만으로는 필터가 덜 그려지는 경우가 있다).
  await new Promise((r) => setTimeout(r, 400))

  const dbg = win.webContents.debugger
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false
  })
  const shot = await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 }
  })
  const png = Buffer.from(shot.data, 'base64')
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  if (w !== size || h !== size) throw new Error(`${size}px 인데 ${w}x${h} 가 나왔다`)
  return png
}

/**
 * PNG → ICO 의 DIB 엔트리(BITMAPINFOHEADER + XOR + AND 마스크).
 *
 * `toBitmap()` 은 BGRA·top-down·**premultiplied** 를 준다(2026-09-04 실측: 흰색 50% 가
 * 128,128,128,128). ICO 32bpp 는 straight 알파라 나눠 풀어야 모서리에 어두운 테가 안 생긴다.
 * DIB 는 bottom-up 이라 행도 뒤집는다.
 */
function toDib(png, size) {
  const bmp = nativeImage.createFromBuffer(png).toBitmap()
  if (bmp.length !== size * size * 4) throw new Error(`${size}px 비트맵 길이가 ${bmp.length}`)
  const rowBytes = size * 4
  const xor = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * rowBytes
    const dstRow = y * rowBytes
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4
      const d = dstRow + x * 4
      const a = bmp[s + 3]
      if (a === 0) continue // 이미 0 으로 채워져 있다
      xor[d] = Math.min(255, Math.round((bmp[s] * 255) / a))
      xor[d + 1] = Math.min(255, Math.round((bmp[s + 1] * 255) / a))
      xor[d + 2] = Math.min(255, Math.round((bmp[s + 2] * 255) / a))
      xor[d + 3] = a
    }
  }
  // AND 마스크: 1bpp, 행마다 4바이트 정렬. 32비트 알파를 쓰므로 전부 0(불투명)이면 된다.
  const mask = Buffer.alloc((((size + 31) >> 5) * 4) * size)

  const hdr = Buffer.alloc(40)
  hdr.writeUInt32LE(40, 0) // biSize
  hdr.writeInt32LE(size, 4) // biWidth
  hdr.writeInt32LE(size * 2, 8) // biHeight — ⚠️ 두 배다(XOR + AND)
  hdr.writeUInt16LE(1, 12) // biPlanes
  hdr.writeUInt16LE(32, 14) // biBitCount
  hdr.writeUInt32LE(0, 16) // biCompression = BI_RGB
  hdr.writeUInt32LE(xor.length + mask.length, 20) // biSizeImage
  return Buffer.concat([hdr, xor, mask])
}

/** 이미지 데이터들 → ICO 파일 바이트. */
function buildIco(images) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type = icon
  head.writeUInt16LE(images.length, 4)

  let offset = 6 + 16 * images.length
  const dir = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size === 256 ? 0 : size, 0)
    e.writeUInt8(size === 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // colorCount
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bitCount
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)])
}

/** 만든 파일을 **다시 파싱해서** 확인한다 — 쓴 값을 믿지 않고 읽어서 잰다. */
function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ICO 헤더가 아니다')
  const n = buf.readUInt16LE(4)
  const spans = []
  const out = []
  for (let i = 0; i < n; i++) {
    const o = 6 + 16 * i
    const w = buf.readUInt8(o) || 256
    const h = buf.readUInt8(o + 1) || 256
    const bytes = buf.readUInt32LE(o + 8)
    const at = buf.readUInt32LE(o + 12)
    if (at < 6 + 16 * n || at + bytes > buf.length) throw new Error(`${w}px 오프셋이 파일 밖이다`)
    for (const s of spans) {
      if (at < s.at + s.bytes && s.at < at + bytes) throw new Error(`${w}px 데이터가 겹친다`)
    }
    spans.push({ at, bytes })
    const data = buf.subarray(at, at + bytes)
    const isPng = data.readUInt32BE(0) === 0x89504e47
    out.push({ w, h, bytes, at, isPng, data })
  }
  return out
}

/** ICO 안의 엔트리를 PNG 로 되뽑는다 — 숫자가 맞아도 그림이 뭉개졌으면 실패이므로 눈으로 본다. */
function entryToPng(entry) {
  if (entry.isPng) return entry.data
  const size = entry.w
  const rowBytes = size * 4
  const xor = entry.data.subarray(40, 40 + rowBytes * size)
  const top = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * rowBytes
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = y * rowBytes + x * 4
      const a = xor[s + 3]
      // createFromBitmap 은 toBitmap 과 짝이므로 premultiplied 로 되돌려 넣는다.
      top[d] = Math.round((xor[s] * a) / 255)
      top[d + 1] = Math.round((xor[s + 1] * a) / 255)
      top[d + 2] = Math.round((xor[s + 2] * a) / 255)
      top[d + 3] = a
    }
  }
  return nativeImage.createFromBitmap(top, { width: size, height: size }).toPNG()
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    // 투명 배경 — 아이콘은 배경이 비어 있어야 OS 가 알아서 얹는다.
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
  })
  win.webContents.debugger.attach('1.3')

  const svg = { [FULL]: readFileSync(FULL, 'utf8'), [SMALL]: readFileSync(SMALL, 'utf8') }
  const images = []
  for (const { size, src, png } of PLAN) {
    const shot = await render(win, svg[src], size)
    images.push({ size, data: png ? shot : toDib(shot, size) })
  }
  win.webContents.debugger.detach()

  const ico = buildIco(images)
  writeFileSync(OUT, ico)

  const entries = parseIco(readFileSync(OUT))
  const want = PLAN.map((p) => p.size)
  const got = entries.map((e) => e.w)
  if (got.join(',') !== want.join(',')) throw new Error(`엔트리가 ${got} — ${want} 여야 한다`)
  for (const e of entries) {
    if (e.w !== e.h) throw new Error(`${e.w}x${e.h} 는 정사각이 아니다`)
    if (e.isPng !== (e.w === 256)) throw new Error(`${e.w}px 포맷이 틀렸다(png=${e.isPng})`)
  }
  console.log(`icon: ${OUT} ${(ico.length / 1024).toFixed(1)}KB`)
  for (const e of entries) console.log(`  ${e.w}x${e.h}  ${e.isPng ? 'PNG' : 'DIB'}  ${e.bytes}B  @${e.at}`)

  const i = process.argv.indexOf('--extract')
  if (i > 0 && process.argv[i + 1]) {
    for (const e of entries) {
      const p = join(process.argv[i + 1], `ico-${e.w}.png`)
      writeFileSync(p, entryToPng(e))
      console.log(`  → ${p}`)
    }
  }
  app.exit(0)
})

process.on('unhandledRejection', (err) => {
  console.error('FAIL:', err)
  app.exit(1)
})
