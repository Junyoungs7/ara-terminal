// 2026-11-04 준영님 제보 "세션이 전체 화면이 안 된다 — 검은 라운드가 쳐진다"(2.2.4, 창 최대화).
// 원인: xterm.css `.xterm-viewport { background-color:#000 }` 가 .xterm 패딩 둘레를 덮었다(xterm 6 은 여기 테마색을 안 칠한다).
// 큰 창(1920×1040)에서: 세션 칸·.xterm·패딩 둘레가 전부 xterm 테마 배경과 같은 색, 칸은 그리드에 꽉 붙고,
// 글자판(.xterm-screen)과 칸의 차이는 패딩(+셀 나머지)뿐이다. AI 공간 에이전트 탭도 같은 TerminalPane·같은 CSS 다.
import { test, expect, newLocalShell } from './fixtures'

test('TERM-FILL 큰 창에서 세션 칸이 테마 배경으로 꽉 찬다(검은 띠 없음)', async ({ ara }) => {
  const { app, page } = ara
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1040))
  await page.setViewportSize({ width: 1920, height: 1040 })
  const id = await newLocalShell(page)
  const pane = page.locator(`.pane[data-session-id="${id}"]`)
  await expect(pane.locator('.xterm-screen')).toBeVisible()
  await page.waitForTimeout(300) // fit 이 새 크기로 다시 맞춰질 시간

  const m = await pane.evaluate((p) => {
    const q = (s: string) => p.querySelector(s) as HTMLElement
    const bg = (el: Element) => getComputedStyle(el).backgroundColor
    const box = (el: Element) => el.getBoundingClientRect().toJSON() as DOMRect
    const x = q('.xterm')
    const cs = getComputedStyle(x)
    const grid = p.closest('.pane-grid') as HTMLElement
    return {
      theme: bg(q('.xterm-scrollable-element')), // xterm 이 테마 배경을 직접 칠하는 곳 = 기준
      xterm: bg(x),
      viewport: bg(q('.xterm-viewport')),
      pane: bg(p),
      grid: bg(grid),
      gridBox: box(grid),
      paneBox: box(p),
      host: box(q('.term-pane')),
      screen: box(q('.xterm-screen')),
      pad: { l: parseFloat(cs.paddingLeft), t: parseFloat(cs.paddingTop), r: parseFloat(cs.paddingRight), b: parseFloat(cs.paddingBottom) },
      radius: [p, q('.term-pane'), x].map((el) => getComputedStyle(el).borderRadius),
      shadow: [p, q('.term-pane'), x].map((el) => getComputedStyle(el).boxShadow)
    }
  })

  // 색: 패딩 둘레를 덮던 viewport 는 비었고, 그 아래 .xterm·칸·그리드는 테마 배경과 같다.
  expect(m.viewport).toBe('rgba(0, 0, 0, 0)')
  expect(m.xterm).toBe(m.theme)
  expect(m.pane).toBe(m.theme)
  expect(m.grid).toBe(m.theme)
  // 모양: 둥근 모서리·그림자 없음, 칸은 그리드에 꽉 붙는다(창 하나).
  expect(m.radius.every((r) => r === '0px')).toBe(true)
  expect(m.shadow.every((s) => s === 'none')).toBe(true)
  for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(m.paneBox[k] - m.gridBox[k])).toBeLessThanOrEqual(1)
  // 글자판과 칸의 차이 = 왼쪽·위는 패딩 그대로, 오른쪽·아래는 패딩 + 셀 하나 미만의 나머지.
  expect(Math.abs(m.screen.left - m.host.left - m.pad.l)).toBeLessThanOrEqual(1)
  expect(Math.abs(m.screen.top - m.host.top - m.pad.t)).toBeLessThanOrEqual(1)
  expect(m.host.right - m.screen.right).toBeGreaterThanOrEqual(m.pad.r - 1)
  expect(m.host.right - m.screen.right).toBeLessThan(m.pad.r + 40) // 셀 폭 나머지 + 스크롤바 상한
  expect(m.host.bottom - m.screen.bottom).toBeGreaterThanOrEqual(m.pad.b - 1)
  expect(m.host.bottom - m.screen.bottom).toBeLessThan(m.pad.b + 48) // 셀 높이 나머지 상한

  // 실제 픽셀: 패딩 띠 한가운데(왼쪽 3px 안쪽)를 찍어 테마색인지 — computed 가 맞아도 위에 다른 층이 덮으면 잡는다.
  const shot = await page.screenshot({ clip: { x: Math.round(m.host.left) + 2, y: Math.round(m.host.top + m.host.height / 2), width: 2, height: 2 } })
  const px = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }, shot.toString('base64'))
  const want = (m.theme.match(/\d+/g) ?? []).map(Number)
  // 화면 캡처의 색 관리로 1~2 단계 어긋날 수 있다 — 검은 띠(0,0,0)와는 확실히 갈린다.
  px.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(3))
})
