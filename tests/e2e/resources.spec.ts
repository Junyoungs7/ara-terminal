// M0 0-7 FD-01 자원 관리자 — 집계 로직은 tests/resources.test.ts 가 본다; 여기는 실앱 연결만.
import { test, expect } from './fixtures'

// RES-1 상태바 [자원]을 열면 프로세스 목록에 main 이 보이고, 닫으면 팝오버가 사라진다(폴링도 같이 멈춘다).
test('RES-1 상태바 자원 팝오버에 main 프로세스가 보인다', async ({ ara }) => {
  const page = ara.page
  await page.locator('[data-action="statusbar.resources"]').first().click()
  const pop = page.locator('.res-pop')
  await expect(pop).toBeVisible()
  await expect(pop.locator('.res-row[data-kind="main"]')).toHaveCount(1, { timeout: 10_000 })
  await page.locator('[data-action="resources.tab.pty"]').click()
  await expect(pop.locator('.res-row[data-session], .res-empty')).not.toHaveCount(0)
  await page.locator('[data-action="statusbar.resources"]').first().click()
  await expect(pop).toHaveCount(0)
})
