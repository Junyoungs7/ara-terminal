// UI-font4 산출물 합성 — before/after 각각 사이드바·상태바·탭 3장을 세로로 이어붙인다(진단용, 일회성).
const { nativeImage } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const outPath = (n) => join(__dirname, '..', 'agent_talk', n)

function composite(phase) {
  const tags = ['sidebar', 'statusbar', 'tab']
  const imgs = tags.map((t) => nativeImage.createFromPath(outPath(`UI-font4-${phase}-${t}.png`)))
  const sizes = imgs.map((im) => im.getSize())
  const maxW = Math.max(...sizes.map((s) => s.width))
  const gap = 20
  const totalH = sizes.reduce((a, s) => a + s.height, 0) + gap * (tags.length - 1)
  const dst = Buffer.alloc(maxW * totalH * 4, 0)
  for (let i = 0; i < dst.length; i += 4) { dst[i] = 0x19; dst[i + 1] = 0x11; dst[i + 2] = 0x0d; dst[i + 3] = 0xff }
  let yOff = 0
  for (let idx = 0; idx < imgs.length; idx++) {
    const bm = imgs[idx].toBitmap()
    const { width: w, height: h } = sizes[idx]
    for (let y = 0; y < h; y++) {
      const srcRow = y * w * 4
      const dstRow = (yOff + y) * maxW * 4
      bm.copy(dst, dstRow, srcRow, srcRow + w * 4)
    }
    yOff += h + gap
  }
  const png = nativeImage.createFromBitmap(dst, { width: maxW, height: totalH }).toPNG()
  writeFileSync(outPath(`UI-font4-${phase}.png`), png)
  console.log(phase, 'composited', maxW, totalH)
}
composite('before')
composite('after')
