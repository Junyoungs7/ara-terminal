// 헤드리스 msedge 스크린샷 — 창을 띄우지 않는다. node shot.cjs <html> <png> [width]
// NODE_PATH=D:/AI/OFA/node_modules (playwright-core)
const { chromium } = require('playwright-core')
const path = require('node:path')
;(async () => {
  const [html, png, w = '1600'] = process.argv.slice(2)
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  const p = await b.newPage({ viewport: { width: +w, height: 400 }, deviceScaleFactor: 1 })
  await p.goto(require('node:url').pathToFileURL(path.resolve(html)).href)
  await p.waitForTimeout(400)
  await p.screenshot({ path: png, fullPage: true })
  await b.close()
})()
