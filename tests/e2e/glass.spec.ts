// G1 글라스(시안 C) — 설정 › 모양 [글라스] 켬/끔과 ARA_GLASS 강제.
// 보는 것: 켜면 <html data-glass="on"> + 구조 면(타이틀바) 반투명 + 뜨는 면(명령 팔레트) 블러,
// 터미널 면(.main·.pane-grid)은 켜기 전과 같은 불투명 바탕. 끄면 전부 원래대로. 재시작 후 유지.
// ⚠️ Windows '투명 효과'가 꺼진 PC 는 prefers-reduced-transparency: reduce 라 투명·블러가 빠지는 게 정상이다 —
//    그때는 "켜도 불투명"을 기대값으로 바꿔 본다(폴백 검사가 된다).
import { test, expect, persist, quitAra, launchAra, tempDir, rmDir } from './fixtures'
import type { Page } from '@playwright/test'

const bg = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor)
const alphaOf = (c: string) => {
  const m = /rgba?\(([^)]+)\)/.exec(c)
  const p = m ? m[1].split(',').map((x) => parseFloat(x)) : []
  return p.length === 4 ? p[3] : 1
}
const transparencyAllowed = (page: Page) =>
  page.evaluate(
    () =>
      matchMedia('(prefers-reduced-transparency: no-preference)').matches &&
      matchMedia('(prefers-contrast: no-preference)').matches &&
      matchMedia('(forced-colors: none)').matches
  )
const glassAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.glass ?? null)

async function openLook(page: Page) {
  await page.keyboard.press('Control+Comma')
  await expect(page.locator('.settings-page.open')).toBeVisible()
  await page.click('.settings-page .sp-nav [data-section="look"]')
}

test('GLASS-1 설정 › 모양 [글라스] 켬/끔 — 구조 면 반투명·뜨는 면 블러·터미널 불투명 유지, 재시작 후 유지', async ({
  userDataDir,
  launch
}) => {
  const a1 = await launch(userDataDir)
  const p = a1.page
  // 기본 끔 — 지금 화면 그대로
  expect(await glassAttr(p)).toBeNull()
  const before = { title: await bg(p, '.titlebar'), main: await bg(p, '.main'), grid: await bg(p, '.pane-grid') }
  expect(alphaOf(before.title)).toBe(1)

  await openLook(p)
  const sw = p.locator('.settings-page [data-item="glass"] [role="switch"]')
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => glassAttr(p)).toBe('on')
  await p.keyboard.press('Escape')
  await expect(p.locator('.settings-page.open')).toHaveCount(0)

  const allowed = await transparencyAllowed(p)
  const title = await bg(p, '.titlebar')
  if (allowed) expect(alphaOf(title)).toBeLessThan(1)
  else expect(alphaOf(title)).toBe(1)
  // 불투명 면은 그대로
  expect(await bg(p, '.main')).toBe(before.main)
  expect(await bg(p, '.pane-grid')).toBe(before.grid)

  // 뜨는 면 — 명령 팔레트
  await p.keyboard.press('F1')
  const drop = p.locator('.cp-drop')
  await expect(drop).toBeVisible()
  const bf = await drop.evaluate((el) => getComputedStyle(el).backdropFilter)
  if (allowed) expect(bf).toContain('blur')
  else expect(bf).toBe('none')
  await p.keyboard.press('Escape')

  await persist(p)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect.poll(() => glassAttr(a2.page)).toBe('on')
  // 끄면 원래대로
  await openLook(a2.page)
  await a2.page.locator('.settings-page [data-item="glass"] [role="switch"]').click()
  await expect.poll(() => glassAttr(a2.page)).toBeNull()
  await a2.page.keyboard.press('Escape')
  expect(await bg(a2.page, '.titlebar')).toBe(before.title)
})

test('GLASS-2 ARA_GLASS=1 은 설정(끔)을 덮어 첫 화면부터 켠다 · ARA_GLASS=0 은 설정(켬)을 덮어 끈다', async () => {
  const prev = process.env['ARA_GLASS']
  const ud = tempDir()
  try {
    process.env['ARA_GLASS'] = '1'
    const a = await launchAra(ud)
    expect(await glassAttr(a.page)).toBe('on')
    // 설정 화면은 저장값(끔)을 그대로 보여 준다 — env 는 저장하지 않는다
    await openLook(a.page)
    await expect(a.page.locator('.settings-page [data-item="glass"] [role="switch"]')).toHaveAttribute('aria-checked', 'false')
    // 켜서 저장해 두고 env 0 으로 다시 켠다
    await a.page.locator('.settings-page [data-item="glass"] [role="switch"]').click()
    await persist(a.page)
    await quitAra(a)

    process.env['ARA_GLASS'] = '0'
    const b = await launchAra(ud)
    expect(await glassAttr(b.page)).toBeNull()
    await quitAra(b)
  } finally {
    if (prev === undefined) delete process.env['ARA_GLASS']
    else process.env['ARA_GLASS'] = prev
    rmDir(ud)
  }
})
