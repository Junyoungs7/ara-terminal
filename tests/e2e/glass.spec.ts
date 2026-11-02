// G1·G2 글라스(시안 C) — 설정 › 모양 [글라스] 켬/끔과 ARA_GLASS 강제. G2 부터 기본 켬.
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

test('GLASS-1 기본 켬 · 설정 › 모양 [글라스] 끔/켬 — 구조 면 반투명·뜨는 면 블러·터미널 불투명 유지, 재시작 후 유지', async ({
  userDataDir,
  launch
}) => {
  const a1 = await launch(userDataDir)
  const p = a1.page
  // G2 기본 켬 — 처음 켠 사람도 글라스
  await expect.poll(() => glassAttr(p)).toBe('on')
  const allowed = await transparencyAllowed(p)
  const on = { title: await bg(p, '.titlebar'), main: await bg(p, '.main'), grid: await bg(p, '.pane-grid') }
  if (allowed) expect(alphaOf(on.title)).toBeLessThan(1)
  else expect(alphaOf(on.title)).toBe(1)

  // 뜨는 면 — 명령 팔레트
  await p.keyboard.press('F1')
  const drop = p.locator('.cp-drop')
  await expect(drop).toBeVisible()
  const bf = await drop.evaluate((el) => getComputedStyle(el).backdropFilter)
  if (allowed) expect(bf).toContain('blur')
  else expect(bf).toBe('none')
  await p.keyboard.press('Escape')

  // 끄면 지금(G1 이전) 화면 그대로 — 타이틀바 불투명, 터미널 면은 켤 때와 같은 바탕
  await openLook(p)
  const sw = p.locator('.settings-page [data-item="glass"] [role="switch"]')
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => glassAttr(p)).toBeNull()
  await p.keyboard.press('Escape')
  await expect(p.locator('.settings-page.open')).toHaveCount(0)
  const off = { title: await bg(p, '.titlebar'), main: await bg(p, '.main'), grid: await bg(p, '.pane-grid') }
  expect(alphaOf(off.title)).toBe(1)
  expect(off.main).toBe(on.main)
  expect(off.grid).toBe(on.grid)

  // 끈 것이 재시작 뒤에도 남는다(false 만 끔)
  await persist(p)
  await quitAra(a1)
  const a2 = await launch(userDataDir)
  await expect.poll(() => glassAttr(a2.page)).toBeNull()
  // 다시 켜면 켬
  await openLook(a2.page)
  await a2.page.locator('.settings-page [data-item="glass"] [role="switch"]').click()
  await expect.poll(() => glassAttr(a2.page)).toBe('on')
  await a2.page.keyboard.press('Escape')
  expect(await bg(a2.page, '.titlebar')).toBe(on.title)
})

test('GLASS-2 ARA_GLASS=0 은 설정(기본 켬)을 덮어 끈다 · ARA_GLASS=1 은 설정(끔)을 덮어 켠다', async () => {
  const prev = process.env['ARA_GLASS']
  const ud = tempDir()
  try {
    process.env['ARA_GLASS'] = '0'
    const a = await launchAra(ud)
    expect(await glassAttr(a.page)).toBeNull()
    // 설정 화면은 저장값(기본 켬)을 그대로 보여 준다 — env 는 저장하지 않는다
    await openLook(a.page)
    const sw = a.page.locator('.settings-page [data-item="glass"] [role="switch"]')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    // 꺼서 저장해 두고 env 1 로 다시 켠다
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await persist(a.page)
    await quitAra(a)

    process.env['ARA_GLASS'] = '1'
    const b = await launchAra(ud)
    expect(await glassAttr(b.page)).toBe('on')
    await quitAra(b)
  } finally {
    if (prev === undefined) delete process.env['ARA_GLASS']
    else process.env['ARA_GLASS'] = prev
    rmDir(ud)
  }
})

test('GLASS-3 AI 공간 — 워크트리 목록이 유리(바닥 .main 이 비었다), 가운데는 불투명, 빈 화면 아이콘은 ✦ 아닌 워크트리', async ({ ara }) => {
  const p = ara.page
  await expect.poll(() => glassAttr(p)).toBe('on')
  await p.keyboard.press('Control+Alt+2')
  await expect(p.locator('.ai-rail')).toBeVisible()
  await expect(p.locator('.aiws-side')).toBeVisible()
  // 빈 화면 — FolderGit2(워크트리) 아이콘, 반짝이(✦ Sparkles) 없음. 공간 스위치·알림의 AI 아이콘도 반짝이 아님.
  await expect(p.locator('.aiws-empty svg.lucide-folder-git-2')).toHaveCount(1)
  await expect(p.locator('svg.lucide-sparkles')).toHaveCount(0)
  const allowed = await transparencyAllowed(p)
  const main = await bg(p, '.main.space-ai')
  const side = await bg(p, '.aiws-side')
  const center = await bg(p, '.aiws-center')
  if (allowed) {
    expect(alphaOf(main)).toBe(0)
    expect(alphaOf(side)).toBeLessThan(1)
    // 가운데 = 정적 빛 그라디언트 + 불투명 터미널 바닥(배경색 자체가 불투명)
    expect(alphaOf(center)).toBe(1)
    expect(await p.locator('.aiws-center').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient')
  } else {
    expect(alphaOf(side)).toBe(1)
  }
})
