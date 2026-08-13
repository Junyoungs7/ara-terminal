// UI 글자 크기 · 배율 (UI-font5) — 준영님: "폰트가 작아서 살짝 가독성이 떨어지는데 ui에 사용되는
// 폰트 크기 키워주고 폰트가 커짐에 따라 잘리지 않게 해주고."
//
// 이 파일의 핵심은 SCALE-3 이다. 캡처를 눈으로 보는 것만으로는 1px 잘림을 못 잡는다 —
// "잘리지 않게"를 사람 눈이 아니라 기계가 판정하게 만든 것이 준영님 요구의 자동 검증분이다.
import { test, expect, newLocalShell, openConnTab, persist, quitAra } from './fixtures'
import type { Page } from '@playwright/test'

// 스크롤을 허용하지 않는 상자인데 내용이 넘치는 곳 = 잘린 곳.
// overflow 가 auto/scroll 인 상자는 넘쳐도 사용자가 스크롤로 볼 수 있으므로 잘림이 아니다.
// 터미널(xterm)은 자체 렌더러라 DOM 계산이 의미 없어 제외한다.
async function clippedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const SLACK = 1 // 소수 픽셀 반올림 여유
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('.xterm')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (el.clientHeight === 0 || el.clientWidth === 0) continue
      const vClip = cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + SLACK
      const hClip =
        cs.overflowX === 'hidden' &&
        cs.textOverflow !== 'ellipsis' && // 말줄임은 의도된 가로 잘림이다
        el.scrollWidth > el.clientWidth + SLACK
      if (vClip || hClip) {
        const name = (e: Element) =>
          `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ').filter(Boolean).join('.')}`
        // **어느 자식이 넘치게 만들었는지**까지 적는다. 상자 이름만 알려 주면 고칠 곳을 다시 찾아야
        // 한다 — 이 검사의 값어치는 "잘렸다"가 아니라 "여기를 고쳐라"에 있다.
        const box = el.getBoundingClientRect()
        const culprit = Array.from(el.querySelectorAll('*'))
          .map((c) => ({ c, r: c.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.right > box.right + SLACK || r.bottom > box.bottom + SLACK))
          .sort((a, b) => b.r.right - a.r.right)[0]
        const why = culprit ? ` ← ${name(culprit.c)}` : ''
        out.push(
          `${name(el)} ${vClip ? `세로 ${el.scrollHeight}>${el.clientHeight}` : ''}${
            hClip ? ` 가로 ${el.scrollWidth}>${el.clientWidth}` : ''
          }${why}`.trim()
        )
      }
    }
    return out
  })
}

// 화면에 사람이 읽는 글자가 실제로 얼마로 그려지는지. 토큰이 var() 로 흐르므로
// 선언값이 아니라 **계산된 값**을 봐야 의미가 있다.
async function fontSizesOf(page: Page, selector: string): Promise<number[]> {
  return page.evaluate(
    (sel) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel))
        .filter((el) => (el.textContent ?? '').trim().length > 0 && !el.closest('.xterm'))
        .map((el) => parseFloat(getComputedStyle(el).fontSize)),
    selector
  )
}

test('SCALE-1 UI 글자에 9~10px 짜리가 남아 있지 않다(하한 11px)', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openConnTab(page)

  // 사이드바·탭바·상태바 — 준영님이 늘 보시는 세 곳.
  const sizes = [
    ...(await fontSizesOf(page, '.sidebar *')),
    ...(await fontSizesOf(page, '.term-tabbar *')),
    ...(await fontSizesOf(page, '.statusbar *'))
  ]
  expect(sizes.length).toBeGreaterThan(5) // 아무것도 못 찾고 통과하는 일 방지
  // 옛 9 · 9.5 · 10px 이 30곳 있었다 — 그게 "가독성이 떨어진다"의 실체였다.
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
})

test('SCALE-2 본문 기준 크기가 예전(13.5px)보다 커졌다', async ({ ara }) => {
  const { page } = ara
  const bodyPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))
  expect(bodyPx).toBeGreaterThan(13.5)
})

test('SCALE-3★ 배율을 아주 크게 올려도 잘리는 요소가 없다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openConnTab(page)

  // 기본 배율에서 먼저 깨끗해야 한다.
  expect(await clippedElements(page)).toEqual([])

  // 가장 큰 배율. 글자만 키우고 행 높이를 안 키웠으면 여기서 무더기로 잡힌다.
  await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '1.25'))
  await page.waitForTimeout(300) // 리플로우
  expect(await clippedElements(page)).toEqual([])

  // 창을 좁혀도(사이드바가 눌리는 상황) 잘리지 않는다.
  await page.setViewportSize({ width: 900, height: 700 })
  await page.waitForTimeout(300)
  expect(await clippedElements(page)).toEqual([])
})

test('SCALE-4 설정 [일반]에서 배율을 바꾸면 글자가 즉시 커지고 재시작 후에도 유지된다', async ({
  userDataDir,
  launch
}) => {
  const a1 = await launch(userDataDir)
  const before = await a1.page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))

  await a1.page.keyboard.press('Control+Comma')
  await expect(a1.page.locator('.drawer')).toBeVisible()
  // Seg 컨트롤: 화면에 보이는 라벨로 고른다(저장값은 'xlarge').
  await a1.page.getByText('아주 크게', { exact: true }).click()

  await expect
    .poll(async () => a1.page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)))
    .toBeGreaterThan(before)
  // 배율을 올린 직후에도 잘림이 없어야 한다(SCALE-3 의 실사용 경로 버전).
  expect(await clippedElements(a1.page)).toEqual([])

  const bigger = await a1.page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect
    .poll(async () => a2.page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)))
    .toBe(bigger)
})
