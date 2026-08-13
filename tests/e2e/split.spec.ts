// 분할창 (스펙 AC #3 최대 4분할 / F4a · R2.0) — 배경 세션 배치 · 방향 · 최대화 · detach · 포커스 이동
import { test, expect, dialogCancel, dialogConfirm, newLocalShell, sessionList } from './fixtures'

// SPLIT-1 분할은 "새 셸"이 아니라 이미 열린 배경 탭을 나란히 올린다(R2.0)
test('SPLIT-1 분할하면 배경 탭이 새 패널에 올라온다', async ({ ara }) => {
  const { page } = ara
  const first = await newLocalShell(page)
  const second = await newLocalShell(page) // 두 번째는 같은 패널을 차지 → 첫 번째가 배경 탭이 된다
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  // 세션은 늘지 않는다 — 새 셸을 만들지 않고 배경 세션을 배치했다.
  expect((await sessionList(page)).length).toBe(2)
  const placed = await page.locator('.pane-grid .pane').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.sessionId)
  )
  expect(placed.sort()).toEqual([first, second].sort())
})

// SPLIT-2 세로 분할(좌·우) / 가로 분할(상·하) 방향이 반영된다
test('SPLIT-2 세로 분할은 좌우, 가로 분할은 상하로 배치된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+\\') // 세로 분할 = 좌·우
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.pane-grid .div-col')).toHaveCount(1)
  await expect(page.locator('.pane-grid .div-row')).toHaveCount(0)
})

test('SPLIT-3 가로 분할은 상하 divider 를 만든다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+-') // 가로 분할 = 상·하
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.pane-grid .div-row')).toHaveCount(1)
  await expect(page.locator('.pane-grid .div-col')).toHaveCount(0)
})

// SPLIT-4 최대 4분할 상한 + 초과 시 안내 토스트
test('SPLIT-4 4분할이 상한이고 그 이상은 안내가 뜬다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Shift+\\')
    await expect(page.locator('.pane-grid .pane')).toHaveCount(i + 2)
  }
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-toast')).toHaveText('최대 4분할까지만 가능합니다')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(4)
})

// SPLIT-5 최대화(Ctrl+Up) 토글
test('SPLIT-5 Ctrl+Up 으로 포커스 패널을 최대화한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-grid .pane:visible')).toHaveCount(2)
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator('.pane-grid .pane:visible')).toHaveCount(1)
  await expect(page.locator('.pane-grid .div-col')).toHaveCount(0) // 최대화 중엔 divider 없음
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator('.pane-grid .pane:visible')).toHaveCount(2)
})

// SPLIT-6 패널 닫기 = detach(세션은 탭에 남는다)
// SPLIT-6 이 칸 닫기 = 세션 종료. 2026-08-11 준영님 결정으로 detach 에서 뒤집혔다 —
// "탭을 껐으면 세션도 꺼지고 해당 창도 꺼져야 한다. 다시 붙는 건 없다"(scenarios.md SPLIT-6).
// 취소하면 아무것도 죽지 않는 것까지 함께 본다 — 확인 다이얼로그의 값어치는 그쪽에 있다.
test('SPLIT-6 Ctrl+Shift+W 는 확인 후 그 칸의 세션을 종료한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  expect((await sessionList(page)).length).toBe(2)

  // 취소 → 그대로다.
  await page.keyboard.press('Control+Shift+W')
  await dialogCancel(page)
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(2)
  expect((await sessionList(page)).length).toBe(2)

  // 확인 → 패널·탭·세션이 함께 없어진다.
  await page.keyboard.press('Control+Shift+W')
  await dialogConfirm(page)
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(1)
  await expect.poll(async () => (await sessionList(page)).length).toBe(1)
})

// SPLIT-7 Alt+방향키 포커스 이동
test('SPLIT-7 Alt+방향키로 패널 포커스를 옮긴다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+\\')
  const focusedSession = () =>
    page.locator('.pane-grid .pane.focused').getAttribute('data-session-id')
  const right = await focusedSession() // 분할 직후 포커스는 새 패널(우측)
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(focusedSession).not.toBe(right)
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(focusedSession).toBe(right)
})

// SPLIT-8 divider 드래그로 비율을 바꾼다
test('SPLIT-8 divider 를 끌어 분할 비율을 바꾼다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+\\')
  const div = page.locator('.pane-grid .div-col')
  const box = await div.boundingBox()
  if (!box) throw new Error('divider 위치를 찾지 못했다')
  const gridCols = () => page.locator('.pane-grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
  const before = await gridCols()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(gridCols).not.toBe(before)
})
