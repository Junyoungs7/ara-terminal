// #138 첫 실행 인사 + 호칭 — 아라가 사람을 뭐라고 부를지 받는 자리.
//
// 준영님 제보(2026-08-25): 아라가 `sessions: []`·`secrets.vault`·`ssh_connect` 같은 내부 표현을
// 답에 그대로 썼다. 말투 규칙은 `--append-system-prompt-file` 로 넘기고(문구는
// tests/araPersona.test.ts 가 본다), 여기서는 **호칭을 받고 저장하는 길**만 본다.
import { test, expect } from './fixtures'

// 이 스펙만 인사 화면을 **그대로 둔다**. `ara` 픽스처는 그것을 지나 준다(그게 없으면 다른 90여
// 스펙이 전부 이 오버레이에 막힌다) — 그래서 여기서는 `launch` 로 직접 띄운다.

test('WELCOME-1★ 처음 켜면 이름을 묻고, 넣으면 다시 안 묻는다', async ({ launch, userDataDir }) => {
  const { page } = await launch(userDataDir, true)
  const modal = page.locator('.modal.welcome')
  await expect(modal).toBeVisible()

  // 어떻게 불릴지 **미리 보여 준다** — 넣기 전에 알면 고쳐 쓰게 된다.
  await page.fill('.wc-input', '준영')
  await expect(page.locator('.wc-prev')).toContainText('준영님')
  // 이미 님으로 끝나면 덧붙이지 않는다.
  await page.fill('.wc-input', '준영님')
  await expect(page.locator('.wc-prev')).toContainText('준영님')
  await expect(page.locator('.wc-prev')).not.toContainText('준영님님')

  await page.fill('.wc-input', '준영')
  await page.click('[data-action="welcome.ok"]')
  await expect(modal).toHaveCount(0)

  // 새로고침해도 다시 안 뜬다(저장됐다는 뜻이다).
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)

  // 설정에서 그 이름이 보이고 바꿀 수 있다.
  await page.click('.tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="settings.open"]')
  await page.click('.drawer.open .set-nav [data-section="ai"]')
  const field = page.locator('.drawer.open [data-field="ai.callName"]')
  await expect(field).toHaveValue('준영')
  await field.fill('대리')
  await expect(field).toHaveValue('대리')
})

test('WELCOME-2 건너뛰어도 다시 안 뜬다 — 첫 화면이 관문이 되면 안 된다', async ({ launch, userDataDir }) => {
  const { page } = await launch(userDataDir, true)
  await expect(page.locator('.modal.welcome')).toBeVisible()
  await page.click('[data-action="welcome.skip"]')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)
  // 이름은 저장 안 됐지만 **다시는 안 뜬다** — 매번 물으면 첫 화면이 관문이 된다.
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)
  await page.click('.tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="settings.open"]')
  await page.click('.drawer.open .set-nav [data-section="ai"]')
  await expect(page.locator('.drawer.open [data-field="ai.callName"]')).toHaveValue('')
})
