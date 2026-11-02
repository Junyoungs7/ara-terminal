// 양성 대조(헤드리스 msedge, rAF 없음, 2초): 무엇이 메인 스레드 스타일 재계산을 일으키나.
//  ① div transform 회전(합성기 기준)  ② SVG 안쪽 <path> opacity  ③ <svg> 상자 opacity  ④ div left(메인 스레드 — 지표가 잡는지 양성 대조)
const { chromium } = require('playwright-core')
const CASES = {
  'div transform': '<div class="a" style="width:40px;height:40px;background:red"></div>',
  'svg 안 path opacity': '<svg width="64" height="64"><path class="o" d="M0 0H64V64Z"/></svg>',
  'svg 상자 opacity': '<svg class="o" width="64" height="64"><path d="M0 0H64V64Z"/></svg>',
  'div left(양성)': '<div class="l" style="position:relative;width:40px;height:40px;background:red"></div>'
}
;(async () => {
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  for (const [k, html] of Object.entries(CASES)) {
    const p = await b.newPage(); const cdp = await p.context().newCDPSession(p); await cdp.send('Performance.enable')
    await p.setContent(`<style>@keyframes r{to{transform:rotate(1turn)}}@keyframes o{50%{opacity:0}}@keyframes l{to{left:100px}}.l{animation:l 2s linear infinite}.a{animation:r 2s linear infinite}.o{animation:o 2s ease-in-out infinite}</style>${html}`)
    await p.waitForTimeout(300)
    const g = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
    const a = await g(); await p.waitForTimeout(2000); const c = await g()
    console.log(k.padEnd(20), 'recalc/2s', c.RecalcStyleCount - a.RecalcStyleCount)
    await p.close()
  }
  await b.close()
})()
