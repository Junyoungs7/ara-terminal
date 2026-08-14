// 우클릭 인터랙션 (F4c + R1.4) — 리스트 메뉴 · 트리 메뉴 구성 · 미래 기능 안내
// #67(2026-08-14): 라디얼·스마트 팔레트를 지웠다. 모양 선택 설정도 함께 사라져 setCtxStyle 헬퍼가
// 필요 없어졌고, CTX-3/CTX-4 는 "둘이 정말 없는가"를 보는 검사 하나로 합쳤다.
import { test, expect, dialogConfirm, newLocalShell, sessionList } from './fixtures'

const rightClickTerminal = (page: import('@playwright/test').Page) =>
  page.click('.pane-grid', { button: 'right', position: { x: 320, y: 220 } })

// CTX-1 기본은 리스트 메뉴(라디얼이 커서로 라벨을 가린다는 피드백 반영)
test('CTX-1 터미널 우클릭 기본은 리스트 메뉴다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  await expect(page.locator('.ctx-menu')).toBeVisible()
  const actions = await page.locator('.ctx-menu .ctx-item').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.action)
  )
  expect(actions).toEqual([
    'copy',
    'paste',
    'split.horizontal',
    'split.vertical',
    'session.duplicate',
    'log.save',
    'ai.ask',
    'pane.close'
  ])
  // 단축키 힌트는 keymap 단일 소스에서 온다.
  await expect(page.locator('.ctx-menu .ctx-item[data-action="split.horizontal"] .ci-kbd')).toHaveText('Ctrl+Shift+-')
})

// CTX-2 리스트 메뉴에서 분할 실행
test('CTX-2 리스트 메뉴의 세로 분할이 동작한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  await page.click('.ctx-menu .ctx-item[data-action="split.vertical"]')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.pane-grid .div-col')).toHaveCount(1)
})

// CTX-3★ 라디얼·스마트 팔레트가 없다 + Ctrl+K 가 셸로 돌아갔다 (#67)
// 지운 기능은 "안 보인다"로는 부족하다 — 눌러서 아무 일도 안 일어나는지, 그 키를 셸이 받는지까지 본다.
test('CTX-3★ 라디얼·팔레트가 사라지고 Ctrl+K 가 앱을 열지 않는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  // 우클릭은 리스트 하나만 연다(모양 선택지 자체가 없다).
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await expect(page.locator('.radial-menu, .smart-palette')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Ctrl+K 는 이제 앱 키가 아니다 — 어떤 오버레이도 열리지 않고 xterm 이 셸로 흘려보낸다.
  await page.keyboard.press('Control+k')
  await expect(page.locator('.radial-menu, .smart-palette, .ctx-menu')).toHaveCount(0)
  await expect(page.locator('.cp-drop, .cheatsheet.open, .drawer.open')).toHaveCount(0)

  // 설정에도 "우클릭 메뉴 스타일" 줄이 남아 있지 않다.
  await page.keyboard.press('Control+,')
  await expect(page.locator('.drawer.open')).toBeVisible()
  await expect(page.locator('.drawer .sr-label:text-is("우클릭 메뉴 스타일")')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

// CTX-5 미래 기능(로그 저장)은 흐리게 표시되고 "추후 지원" 안내만 한다.
// (ai.ask 는 W3 F16 에서 실배선돼 더 이상 미래 기능이 아니다 — AI-9 가 실제 동작을 검증한다.)
// CTX-5★ 2026-08-14: 마지막 "추후 지원" 항목(로그 저장)이 실배선됐다 — 그전에는 토스트만 냈는데
// 로그 패널의 [내려받기]는 이미 동작하고 있었다. 이제 우클릭 메뉴에 **흐린 항목이 하나도 없어야**
// 한다. 눌렀는데 안 되는 메뉴를 두지 않는다는 것이 이 검사가 지키는 성질이다.
test('CTX-5★ 우클릭 메뉴에 "추후 지원" 항목이 하나도 없다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  await expect(page.locator('.ctx-menu .ctx-item.dim')).toHaveCount(0)
  // [로그 저장]은 이제 실제로 로그 패널을 연다.
  await page.click('.ctx-menu .ctx-item[data-action="log.save"]')
  await expect(page.locator('.log-panel')).toBeVisible({ timeout: 10_000 })
})

// CTX-6 사이드바 빈 영역 · 로컬 그룹 · 세션 행 메뉴 구성
test('CTX-6 사이드바 우클릭 메뉴가 상황별로 구성된다', async ({ ara }) => {
  const { page } = ara
  const actions = () =>
    page.locator('.ctx-menu .ctx-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.action))

  await page.click('.tree', { button: 'right', position: { x: 20, y: 220 } })
  // work.open = 작업 프로필 팝업(서버+폴더 즐겨찾기).
  expect(await actions()).toEqual(['local.new', 'ssh.open', 'group.new', 'work.open'])
  // 로컬 셸을 여는 길은 이 빈 영역 메뉴에도 있다 — [로컬] 그룹이 없어도 막히지 않는다(2026-08-13).
  await page.click('.ctx-menu .ctx-item[data-action="local.new"]')
  await expect.poll(async () => (await sessionList(page)).length, { timeout: 20_000 }).toBe(1)

  // 로컬 그룹 헤더 — 세션이 생긴 뒤에야 나온다(그전에는 트리에 아무것도 없다).
  await page.locator('.tree .srv-group:has(.srv-hd:has-text("로컬")) > .srv-hd').click({ button: 'right' })
  expect(await actions()).toEqual(['local.new', 'work.open'])
  await page.keyboard.press('Escape')

  // 세션 행
  await page.locator('.tree .sess-node').first().click({ button: 'right' })
  expect(await actions()).toEqual(['session.focus', 'session.rename', 'session.close'])
  await page.click('.ctx-menu .ctx-item[data-action="session.close"]')
  await dialogConfirm(page) // 로컬 셸도 확인을 묻는다(2026-08-11)
  await expect.poll(async () => (await sessionList(page)).length).toBe(0)
})

// CTX-7 ESC · 바깥 클릭으로 닫힌다
test('CTX-7 ESC 와 바깥 클릭으로 메뉴가 닫힌다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.ctx-menu')).toHaveCount(0)
  await rightClickTerminal(page)
  await page.locator('.ctx-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.ctx-menu')).toHaveCount(0)
})
