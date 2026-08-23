// W1 F15 모니터링 미니 프리뷰 — 우측 레일(Ctrl+Shift+P · View 메뉴).
// 카드 내용은 xterm 버퍼의 텍스트 스냅샷이다(캔버스 복사 없음 — GPU 메모리·프레임 보호).
import type { Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, newLocalShell, runCommand, expectTermText } from './fixtures'

const rail = (page: Page) => page.locator('.mini-rail')
const cards = (page: Page) => page.locator('.mini-rail .mini-card')
const card = (page: Page, sessionId: string) => page.locator(`.mini-card[data-session="${sessionId}"]`)

// 서로 다른 출력을 가진 로컬 셸 두 개.
async function twoShells(page: Page): Promise<[string, string]> {
  const a = await newLocalShell(page)
  await runCommand(page, a, 'echo 카드A_표식')
  await expectTermText(page, a, /카드A_표식/)
  const b = await newLocalShell(page)
  await runCommand(page, b, 'echo 카드B_표식')
  await expectTermText(page, b, /카드B_표식/)
  return [a, b]
}

// PREV-1 단축키로 레일이 열린다
test('PREV-1 Ctrl+Shift+P 로 미니 프리뷰 레일을 연다', async ({ ara }) => {
  const { page } = ara
  await twoShells(page)
  await expect(rail(page)).toHaveCount(0)
  await page.keyboard.press('Control+Shift+P')
  await expect(rail(page)).toBeVisible()
  await expect(page.locator('.mini-rail .mini-head')).toHaveText('미니 프리뷰')
})

// PREV-2 메뉴도 같은 상태를 연다(메뉴 전용 배선 없음 — keymap 경유)
test('PREV-2 View 메뉴에서도 같은 레일이 열린다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.tb-menu span:text-is("보기")')
  await page.click('.ctx-menu .ctx-item[data-action="preview.toggle"]')
  await expect(rail(page)).toBeVisible()
})

// PREV-3 세션마다 카드 하나 — 제목 + 그룹색 dot
test('PREV-3 세션마다 카드가 하나씩 생긴다', async ({ ara, ssh }) => {
  const { page } = ara
  const localId = await newLocalShell(page)
  const h = await ssh({ password: 'pw-prev3' })
  const sshId = await connectNewSshProfile(page, { name: 'prev3', port: h.port, password: 'pw-prev3' })

  await page.keyboard.press('Control+Shift+P')
  await expect(cards(page)).toHaveCount(2)
  await expect(card(page, localId)).toHaveCount(1)
  await expect(card(page, sshId)).toHaveCount(1)
  await expect(card(page, sshId).locator('.mini-name')).toHaveText('prev3')
  // 그룹색 dot 은 인라인 배경색으로 칠해진다(로컬/서버 구분).
  const localDot = await card(page, localId).locator('.mini-dot').evaluate((el) => (el as HTMLElement).style.background)
  const sshDot = await card(page, sshId).locator('.mini-dot').evaluate((el) => (el as HTMLElement).style.background)
  expect(localDot).toBeTruthy()
  expect(sshDot).toBeTruthy()
  expect(localDot).not.toBe(sshDot)
})

// PREV-4 카드 본문 = 그 세션의 마지막 줄들
test('PREV-4 카드에 각 세션의 마지막 출력이 보인다', async ({ ara }) => {
  const { page } = ara
  const [a, b] = await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, a).locator('.mini-body')).toContainText('카드A_표식', { timeout: 15_000 })
  await expect(card(page, b).locator('.mini-body')).toContainText('카드B_표식', { timeout: 15_000 })
  await expect(card(page, a).locator('.mini-body')).not.toContainText('카드B_표식')
})

// PREV-5 주기 갱신(1.5초) — 탭을 옮기지 않고도 저쪽 세션의 변화가 보인다
test('PREV-5 다른 세션의 새 출력이 카드에 저절로 반영된다', async ({ ara }) => {
  const { page } = ara
  const [a, b] = await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, a).locator('.mini-body')).toContainText('카드A_표식', { timeout: 15_000 })

  // 지금 활성은 B — A 는 화면에 없는 세션이다.
  await runCommand(page, a, 'echo 나중에_추가된_줄')
  await expect(card(page, a).locator('.mini-body')).toContainText('나중에_추가된_줄', { timeout: 15_000 })
  expect(b).toBeTruthy()
})

// PREV-6 호버하면 왼쪽으로 확대 프리뷰
test('PREV-6 카드를 호버하면 확대 프리뷰가 뜬다', async ({ ara }) => {
  const { page } = ara
  const [a] = await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, a).locator('.mini-body')).toContainText('카드A_표식', { timeout: 15_000 })
  await expect(page.locator('.mini-zoom')).toHaveCount(0)
  // 실제 포인터 이동이어야 한다 — React 는 mouseover/mouseout 으로 잡으므로 합성 mouseenter 로는 안 열린다.
  await card(page, a).hover()
  await expect(page.locator('.mini-zoom')).toBeVisible()
  await expect(page.locator('.mini-zoom .mini-zoom-body')).toContainText('카드A_표식')
})

// PREV-7 카드를 누르면 그 세션으로 전환
test('PREV-7 카드를 클릭하면 그 세션으로 전환된다', async ({ ara }) => {
  const { page } = ara
  const [a, b] = await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, b)).toHaveClass(/active/)
  await card(page, a).click()
  await expect(card(page, a)).toHaveClass(/active/)
  await expect(card(page, b)).not.toHaveClass(/active/)
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveAttribute('data-session-id', a)
})

// PREV-8 다시 토글하면 닫힌다
test('PREV-8 다시 Ctrl+Shift+P 를 누르면 닫힌다', async ({ ara }) => {
  const { page } = ara
  await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(rail(page)).toBeVisible()
  await page.keyboard.press('Control+Shift+P')
  await expect(rail(page)).toHaveCount(0)
})

// PREV-9 닫혀 있으면 버퍼를 읽지 않는다(레일 자체가 DOM 에 없다 — 폴링 타이머도 없다)
test('PREV-9 닫혀 있는 동안에는 카드도 폴링도 없다', async ({ ara }) => {
  const { page } = ara
  const [a] = await twoShells(page)
  await expect(rail(page)).toHaveCount(0)
  await runCommand(page, a, 'echo 닫힌동안_출력')
  await expectTermText(page, a, /닫힌동안_출력/)
  await expect(cards(page)).toHaveCount(0)
  // 열면 그제서야 스냅샷을 뜬다.
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, a).locator('.mini-body')).toContainText('닫힌동안_출력', { timeout: 15_000 })
})

// PREV-10 세션이 없으면 안내
test('PREV-10 세션이 없으면 안내 문구를 보여 준다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+Shift+P')
  await expect(rail(page)).toBeVisible()
  await expect(page.locator('.mini-rail .mini-empty')).toHaveText('열린 세션이 없습니다')
  await expect(cards(page)).toHaveCount(0)
})

// PREV-11 캔버스 복사가 아니라 텍스트다
test('PREV-11 카드는 캔버스 복사가 아니라 텍스트로 채워진다', async ({ ara }) => {
  const { page } = ara
  const [a] = await twoShells(page)
  await page.keyboard.press('Control+Shift+P')
  await expect(card(page, a).locator('.mini-body')).toContainText('카드A_표식', { timeout: 15_000 })
  await expect(page.locator('.mini-rail canvas, .mini-rail img')).toHaveCount(0)
  expect((await card(page, a).locator('.mini-body').textContent())?.trim().length).toBeGreaterThan(0)
})
