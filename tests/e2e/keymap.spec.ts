// 단축키 정책 (R2.5 치트시트 + R3.8 셸 충돌 정책)
// 핵심 불변식: 앱 전용 키는 Ctrl+Shift+* / Alt+* 뿐이고, 셸이 쓰는 단일 Ctrl+문자는 전부 셸로 통과한다.
import { test, expect, newLocalShell, runCommand, termText, expectTermText, sessionList } from './fixtures'

// KEY-1 ? 치트시트가 열리고 배선된 키만 싣는다
test('KEY-1 ? 로 치트시트가 열리고 배선된 단축키만 보여 준다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.type('?')
  await expect(page.locator('.cheatsheet.open')).toBeVisible()
  const rows = await page.locator('.cheatsheet .cs-row .cs-desc').allTextContents()
  expect(rows).toContain('세로 분할')
  expect(rows).toContain('터미널 내 검색')
  expect(rows).toContain('AI 창 토글') // W3 F16 에서 실배선됐다(더 이상 미구현이 아니다)
  expect(rows).not.toContain('로그 저장') // 여전히 미구현 — 싣지 않는다
  await expect(page.locator('.cheatsheet .cs-foot')).toContainText('shared/keymap.ts')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cheatsheet')).toHaveCount(0)
})

// KEY-2 입력칸에 있을 때는 ? 가 치트시트를 열지 않는다(검색어에 ? 를 칠 수 있어야 한다)
test('KEY-2 입력 중에는 ? 가 치트시트를 열지 않는다', async ({ ara }) => {
  const { page } = ara
  await page.locator('.sidebar .sb-search input').fill('')
  await page.locator('.sidebar .sb-search input').type('?')
  await expect(page.locator('.cheatsheet')).toHaveCount(0)
  await expect(page.locator('.sidebar .sb-search input')).toHaveValue('?')
})

// KEY-3 셸 표준 Ctrl+L(화면 지우기)은 앱이 가로채지 않고 셸로 간다
test('KEY-3 Ctrl+L 은 셸로 전달돼 화면을 지운다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 지워질_출력_표식')
  await expectTermText(page, id, /지워질_출력_표식/)
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  await page.keyboard.press('Control+l')
  // 화면(스크롤백 제외 보이는 영역)에서 사라진다 — 앱이 먹었다면 아무 변화도 없다.
  await expect
    .poll(async () => /지워질_출력_표식/.test((await termText(page, id)).split('\n').slice(-40).join('\n')), {
      timeout: 15_000
    })
    .toBe(false)
})

// KEY-4 셸 표준 Ctrl+U(줄 지우기)도 셸로 간다
test('KEY-4 Ctrl+U 는 셸의 줄 지우기로 동작한다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  await page.keyboard.type('echo 지워질줄')
  await expectTermText(page, id, /지워질줄/)
  await page.keyboard.press('Control+u')
  await page.waitForTimeout(500)
  await page.keyboard.type('echo 남은줄')
  await page.keyboard.press('Enter')
  await expectTermText(page, id, /남은줄/)
  // Ctrl+U 가 먹혔다면 두 문구가 한 줄에 붙어 실행되지 않는다.
  expect(await termText(page, id)).not.toMatch(/지워질줄echo 남은줄/)
})

// KEY-5 앱 단축키는 셸로 새지 않는다(Ctrl+Shift+T 가 터미널에 T 를 찍으면 안 된다)
test('KEY-5 앱 단축키는 셸에 문자를 남기지 않는다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  const before = await termText(page, id)
  await page.keyboard.press('Control+Shift+T')
  await expect.poll(async () => (await sessionList(page)).length, { timeout: 20_000 }).toBe(2)
  const after = await termText(page, id)
  expect(after.replace(/\s+/g, '')).toBe(before.replace(/\s+/g, ''))
})

// KEY-6 치트시트에 적힌 조합과 실제 동작이 일치한다(문서-동작 일치 — 표본 검증)
test('KEY-6 치트시트에 적힌 조합이 실제로 동작한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  // 터미널이 포커스를 잡고 있으면 ? 는 셸로 간다(입력 중에는 치트시트를 열지 않는 정책 — KEY-2).
  // 여기서는 문서-동작 일치만 보면 되므로 타이틀바 버튼으로 연다.
  await page.click('.titlebar .tb-help')
  const combo = await page
    .locator('.cheatsheet .cs-row:has(.cs-desc:text-is("패널 최대화")) .cs-k')
    .allTextContents()
  expect(combo).toEqual(['Ctrl', 'Up'])
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-grid .pane:visible')).toHaveCount(2)
  await page.keyboard.press('Control+ArrowUp')
  await expect(page.locator('.pane-grid .pane:visible')).toHaveCount(1)
})
