// 세션 전환 · 버퍼 보존 (R1.1 검은 화면 회귀 / R2.4 · F4b 양방향 동기)
import { test, expect, newLocalShell, runCommand, termText, expectTermText, sessionList, openConnTab } from './fixtures'

// SWITCH-1 탭을 오가도 각 세션의 스크롤백이 살아 있다(패널은 세션 단위로 마운트 유지)
test('SWITCH-1 탭을 전환해도 이전 세션 출력이 남아 있다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  await runCommand(page, a, 'echo 세션A_표식')
  await expectTermText(page, a, /세션A_표식/)

  const b = await newLocalShell(page)
  await runCommand(page, b, 'echo 세션B_표식')
  await expectTermText(page, b, /세션B_표식/)

  // A 로 돌아가기 — 검은 화면이 아니라 원래 출력이 그대로 보여야 한다.
  await page.locator(`.term-tabbar .ttab[data-session-id="${a}"]`).click()
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
  await expect(page.locator('.pane-grid .pane')).toHaveAttribute('data-session-id', a)
  expect(await termText(page, a)).toMatch(/세션A_표식/)
  // B 도 마운트가 유지돼 버퍼가 남아 있다(배경 탭).
  expect(await termText(page, b)).toMatch(/세션B_표식/)
})

// SWITCH-2 사이드바 트리의 세션 행 클릭 = 탭·패널 동기(F4b 양방향)
test('SWITCH-2 사이드바 트리에서 세션을 고르면 탭·패널이 함께 움직인다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  await newLocalShell(page)
  // 셸을 열면 사이드바가 [파일] 로 넘어간다(2026-08-22 제보 6번) — 트리를 누르려면 돌아온다.
  await openConnTab(page)
  const rows = page.locator('.tree .srv-group .sess-list .sess-node')
  await expect(rows).toHaveCount(2)
  await rows.first().click()
  await expect(page.locator('.pane-grid .pane')).toHaveAttribute('data-session-id', a)
  await expect(page.locator(`.term-tabbar .ttab.active[data-session-id="${a}"]`)).toHaveCount(1)
  await expect(page.locator('.tree .sess-node.active')).toHaveCount(1)
})

// SWITCH-3 Ctrl+` 로컬 셸 토글(로컬 세션 순환, 없으면 새로 연다)
test('SWITCH-3 Ctrl+` 는 로컬 셸을 순환하고 없으면 새로 연다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+`')
  await expect.poll(async () => (await sessionList(page)).length, { timeout: 20_000 }).toBe(1)
  const a = (await sessionList(page))[0].id
  await newLocalShell(page)
  await page.keyboard.press('Control+`')
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveAttribute('data-session-id', a)
})
