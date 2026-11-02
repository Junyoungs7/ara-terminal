// 동작 중 모션 비용 — 헤드리스 msedge(창 없음). 마크 0개 vs 6개(B 모드 64px) 를 5초씩:
// rAF 프레임 간격(평균·p95·최대·33ms 넘은 수) + CDP Performance 지표 증가분(스타일 재계산·레이아웃·스크립트).
// NODE_PATH=D:/AI/OFA/node_modules node perf.cjs
const { chromium } = require('playwright-core')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const page = pathToFileURL(path.join(__dirname, '..', 'kit', 'motion', 'working-demo.html')).href
;(async () => {
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  for (const n of [0, 6]) {
    const p = await b.newPage({ viewport: { width: 800, height: 300 } })
    const cdp = await p.context().newCDPSession(p)
    await cdp.send('Performance.enable')
    await p.goto(page + '?perf=' + n)
    await p.waitForTimeout(500)
    // ① 메인 스레드 비용 — rAF 없이 5초(합성기에 넘어간 애니메이션은 여기서 0 이어야 한다)
    const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
    await p.waitForTimeout(5000)
    const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
    // ② 프레임 간격 — rAF 5초
    await p.evaluate(() => window.__startRaf())
    await p.waitForFunction(() => window.__perf, null, { timeout: 15000 })
    const iv = (await p.evaluate(() => window.__perf)).sort((a, c) => a - c)
    const avg = iv.reduce((a, c) => a + c, 0) / iv.length
    const d = (k) => +(m1[k] - m0[k]).toFixed(3)
    console.log(JSON.stringify({ marks: n, frames: iv.length, avgMs: +avg.toFixed(2), p95Ms: +iv[Math.floor(iv.length * 0.95)].toFixed(2), maxMs: +iv[iv.length - 1].toFixed(2), over33: iv.filter((x) => x > 33).length,
      recalcStyleCount: d('RecalcStyleCount'), recalcStyleSec: d('RecalcStyleDuration'), layoutCount: d('LayoutCount'), layoutSec: d('LayoutDuration'), scriptSec: d('ScriptDuration'), taskSec: d('TaskDuration') }))
    await p.close()
  }
  await b.close()
})()
