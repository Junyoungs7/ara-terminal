// P3 R2-A 터미널 3차(TM-09~15) — 작성만(실행은 메인). 화면·클립보드를 건드리는 OSC 52 실제 쓰기는 검사하지 않는다(쓰기 경로는 단위 시험 p3r2aOsc52).
import { test, expect, newLocalShell, runCommand } from './fixtures'

const term = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((sid) => {
    const t = window.__evTerm(sid)
    return t ? { bg: t.theme?.background ?? null, contrast: (t as { minimumContrastRatio?: number }).minimumContrastRatio ?? null } : null
  }, id)

async function openTerminalSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click('.settings-page .sp-nav [data-section="terminal"]')
}

test('TM3-1 설정 › 터미널에 3차 줄이 있고 OSC 52 는 기본 꺼짐·인라인 이미지는 켬', async ({ ara }) => {
  const { page } = ara
  await openTerminalSettings(page)
  for (const item of ['term.shell', 'term.shellArgs', 'term.theme', 'term.contrast', 'term.import', 'term.inlineImages', 'term.osc52'])
    await expect(page.locator(`.settings-page .set-row[data-item="${item}"]`)).toBeVisible()
  await expect(page.locator('.settings-page .set-row[data-item="term.osc52"] .set-toggle')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('.settings-page .set-row[data-item="term.inlineImages"] .set-toggle')).toHaveAttribute('aria-checked', 'true')
  // 셸 목록은 이 PC 감지 결과 — Windows 면 PowerShell 이 늘 있다.
  await page.click('.settings-page [data-field="term.shell"] .dd')
  await expect(page.locator('.dd-list')).toContainText(process.platform === 'win32' ? 'Windows PowerShell' : '자동')
})

test('TM3-2 대비 하한 자동(어두운 아라 기본 = 3) → 끔(1)이 열린 터미널에 바로', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await expect.poll(() => term(page, id).then((t) => t?.contrast)).toBe(3)
  await openTerminalSettings(page)
  await page.click('.settings-page [data-field="term.contrast"] [data-value="off"]')
  await expect.poll(() => term(page, id).then((t) => t?.contrast)).toBe(1)
})

test('TM3-3 테마 라이브러리에서 고르면 열린 터미널 배경이 바뀌고, 아라 기본으로 돌아온다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  const before = (await term(page, id))?.bg
  await openTerminalSettings(page)
  await page.click('.settings-page [data-field="term.theme"] .dd')
  await page.locator('.dd-list >> text=Ghostty Default Style Dark').click()
  await expect.poll(() => term(page, id).then((t) => t?.bg)).toBe('#282c34')
  await page.click('.settings-page [data-field="term.theme"] .dd')
  await page.locator('.dd-list >> text=아라 기본').click()
  await expect.poll(() => term(page, id).then((t) => t?.bg)).toBe(before)
})

test('TM3-4 셸 인자 — 새 로컬 셸에만 붙는다(PowerShell -NoProfile)', async ({ ara }) => {
  test.skip(process.platform !== 'win32', 'Windows PowerShell 인자 시험')
  const { page } = ara
  await openTerminalSettings(page)
  const args = page.locator('.settings-page [data-field="term.shellArgs"]')
  await args.fill('-NoLogo -NoProfile')
  await args.blur()
  await page.keyboard.press('Escape')
  const id = await newLocalShell(page)
  await runCommand(page, id, '[Environment]::GetCommandLineArgs() -join "|"')
  await expect.poll(() => page.evaluate((sid) => window.__evTerm(sid)?.text() ?? '', id)).toMatch(/-NoProfile/)
})
