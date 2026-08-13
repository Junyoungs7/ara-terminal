// 우클릭 인터랙션 (F4c + R1.4) — 리스트/라디얼/팔레트 3종 · 트리 메뉴 구성 · 미래 기능 안내
import { test, expect, dialogConfirm, newLocalShell, sessionList } from './fixtures'

const rightClickTerminal = (page: import('@playwright/test').Page) =>
  page.click('.pane-grid', { button: 'right', position: { x: 320, y: 220 } })

async function setCtxStyle(page: import('@playwright/test').Page, value: 'list' | 'radial' | 'palette') {
  await page.keyboard.press('Control+,')
  await page.click(`.drawer .set-row:has(.sr-label:text-is("우클릭 메뉴 스타일")) .seg-ctl button[data-value="${value}"]`)
  await page.keyboard.press('Escape')
  await expect(page.locator('.drawer.open')).toHaveCount(0)
}

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

// CTX-3 라디얼 메뉴 — 8항목이 커서 위치에 원형 배치
test('CTX-3 라디얼 메뉴로 전환하면 8개 액션이 원형으로 뜬다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await setCtxStyle(page, 'radial')
  await rightClickTerminal(page)
  // .radial-menu 컨테이너는 크기 0인 앵커다(항목이 절대 배치) — 항목으로 열림을 판정한다.
  await expect(page.locator('.radial-menu.open .ri').first()).toBeVisible()
  await expect(page.locator('.radial-menu .ri')).toHaveCount(8)
  await expect(page.locator('.radial-menu .ri[data-action="pane.close"]')).toHaveClass(/tint-danger/)
  await page.click('.radial-menu .ri[data-action="split.horizontal"]')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
})

// CTX-4 스마트 팔레트 — 우클릭 + Ctrl+K, 한글 검색 필터
test('CTX-4 스마트 팔레트가 열리고 한글로 액션을 거른다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await setCtxStyle(page, 'palette')
  await rightClickTerminal(page)
  await expect(page.locator('.smart-palette.open')).toBeVisible()
  await expect(page.locator('.smart-palette .sp-item')).toHaveCount(8)
  await page.fill('.smart-palette .sp-search input', '분할')
  await expect(page.locator('.smart-palette .sp-item')).toHaveCount(2)
  await page.fill('.smart-palette .sp-search input', '없는작업')
  await expect(page.locator('.smart-palette .sp-empty')).toHaveText('일치하는 작업이 없습니다')
  await page.keyboard.press('Escape')
  await expect(page.locator('.smart-palette')).toHaveCount(0)

  // Ctrl+K 는 스타일과 무관하게 화면 중앙 팔레트를 연다.
  await page.keyboard.press('Control+k')
  await expect(page.locator('.smart-palette.open')).toBeVisible()
})

// CTX-5 미래 기능(로그 저장)은 흐리게 표시되고 "추후 지원" 안내만 한다.
// (ai.ask 는 W3 F16 에서 실배선돼 더 이상 미래 기능이 아니다 — AI-9 가 실제 동작을 검증한다.)
test('CTX-5 미래 기능은 안내 토스트만 띄운다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await rightClickTerminal(page)
  await expect(page.locator('.ctx-menu .ctx-item[data-action="ai.ask"]')).not.toHaveClass(/dim/)
  await expect(page.locator('.ctx-menu .ctx-item[data-action="log.save"]')).toHaveClass(/dim/)
  await page.click('.ctx-menu .ctx-item[data-action="log.save"]')
  await expect(page.locator('.pane-toast')).toHaveText('추후 지원 예정입니다')
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
