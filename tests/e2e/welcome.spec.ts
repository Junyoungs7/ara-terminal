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
  // 부팅 인사가 위에 있다 — 지나가야 이름 창을 누를 수 있다(#139).
  await page.keyboard.press('Escape')
  await expect(page.locator('.boot')).toHaveCount(0)
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
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)

  // 설정에서 그 이름이 보이고 바꿀 수 있다.
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
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
  await page.keyboard.press('Escape')
  await expect(page.locator('.boot')).toHaveCount(0)
  await expect(page.locator('.modal.welcome')).toBeVisible()
  await page.click('[data-action="welcome.skip"]')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)
  // 이름은 저장 안 됐지만 **다시는 안 뜬다** — 매번 물으면 첫 화면이 관문이 된다.
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal.welcome')).toHaveCount(0)
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
  await page.click('.tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="settings.open"]')
  await page.click('.drawer.open .set-nav [data-section="ai"]')
  await expect(page.locator('.drawer.open [data-field="ai.callName"]')).toHaveValue('')
})

test('BOOT-1★ 켤 때 인사가 지나간다 · 아무 키로 건너뛴다 · 설정에서 끈다', async ({ launch, userDataDir }) => {
  const { page } = await launch(userDataDir, true)
  const boot = page.locator('.boot')
  await expect(boot).toBeVisible()
  await expect(boot).toContainText('A.R.A')

  // ★ 붙잡지 않는다 — 아무 키면 바로 사라진다(급할 때 화면이 사람을 붙들면 안 된다).
  await page.keyboard.press('Escape')
  await expect(boot).toHaveCount(0)

  // 이름을 넣으면 그 이름으로 인사한다.
  await page.fill('.wc-input', '준영')
  await page.click('[data-action="welcome.ok"]')
  await page.reload()
  await page.waitForSelector('.pane-grid')
  // 문구는 매번 다르다(인사·반가움·명언) — 그래서 **정확한 글자**가 아니라 규칙을 본다:
  // 인사·반가움이면 이름이 들어 있고, 명언이면 출처가 붙어 있다. 둘 중 하나는 참이어야 한다.
  const hi = page.locator('.boot-hi')
  await expect(hi).toBeVisible()
  const line = (await hi.innerText()).trim()
  const byCount = await page.locator('.boot-by').count()
  expect(line.length).toBeGreaterThan(0)
  expect(line.includes('준영님') || byCount === 1).toBe(true)
  await page.keyboard.press('Escape')

  // ★ 끌 수 있다 — 멋은 한 번이고 방해는 매일이다.
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
  await page.click('.tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="settings.open"]')
  await page.click('.drawer.open .set-nav [data-section="general"]')
  await page.locator('.drawer.open .set-row', { hasText: '켤 때 인사 화면' }).locator('.set-toggle').click()
  await page.keyboard.press('Escape')
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await expect(page.locator('.boot')).toHaveCount(0)
})
