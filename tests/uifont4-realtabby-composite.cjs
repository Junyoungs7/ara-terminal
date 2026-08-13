const { app, nativeImage } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const outPath = (n) => join(__dirname, '..', 'agent_talk', n)

app.whenReady().then(() => {
  const a = nativeImage.createFromPath(outPath('UI-font4-realtabby-line.png'))
  const b = nativeImage.createFromPath(outPath('UI-font4-realtabby-ours.png'))
  const sa = a.getSize(), sb = b.getSize()
  const maxW = Math.max(sa.width, sb.width)
  const gap = 16
  const totalH = sa.height + sb.height + gap
  const dst = Buffer.alloc(maxW * totalH * 4, 0)
  for (let i = 0; i < dst.length; i += 4) { dst[i]=0x19; dst[i+1]=0x11; dst[i+2]=0x0d; dst[i+3]=0xff }
  const bmA = a.toBitmap(), bmB = b.toBitmap()
  for (let y = 0; y < sa.height; y++) bmA.copy(dst, y*maxW*4, y*sa.width*4, y*sa.width*4+sa.width*4)
  let yOff = sa.height + gap
  for (let y = 0; y < sb.height; y++) bmB.copy(dst, (yOff+y)*maxW*4, y*sb.width*4, y*sb.width*4+sb.width*4)
  writeFileSync(outPath('UI-font4-vs-tabby-real.png'), nativeImage.createFromBitmap(dst, {width:maxW,height:totalH}).toPNG())
  console.log('done')
  app.exit(0)
})
