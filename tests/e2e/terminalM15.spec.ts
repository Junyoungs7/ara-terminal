// M15 R2 터미널 개선(작성만 — 실행은 메인). TM-03 Reset Terminal: 죽은 TUI 가 켜 둔 마우스 추적을 단축키·우클릭으로 끈다.
import { test, expect, newLocalShell, runCommand } from './fixtures'

const modes = (page: import('@playwright/test').Page, id: string) => page.evaluate((sid) => window.__evTerm(sid)?.modes?.() ?? null, id)

// 마우스 추적(?1000h)을 셸 출력으로 켠다 — TUI 가 끄지 않고 죽은 상황. Windows 는 PowerShell, 그 밖엔 printf.
async function armMouse(page: import('@playwright/test').Page, id: string): Promise<void> {
  await runCommand(page, id, process.platform === 'win32' ? "[Console]::Out.Write([char]27 + '[?1000h')" : "printf '\\033[?1000h'")
  // 양성 대조: 켜졌는지 먼저 본다(안 켜졌으면 아래 "꺼졌다"는 아무것도 증명하지 않는다).
  await expect.poll(async () => (await modes(page, id))?.mouse, { timeout: 10_000 }).not.toBe('none')
}

test('TRESET-1 Ctrl+Shift+R 이 남은 마우스 추적을 끄고 알린다(셸은 그대로)', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await armMouse(page, id)
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  await page.keyboard.press('Control+Shift+R')
  await expect.poll(async () => (await modes(page, id))?.mouse).toBe('none')
  await expect(page.getByText('터미널 입력 모드를 초기화했습니다')).toBeVisible()
  // 셸은 살아 있다 — 다음 명령이 그대로 돈다.
  await runCommand(page, id, 'echo reset_ok_m15')
  await expect.poll(async () => page.evaluate((sid) => window.__evTerm(sid)?.text() ?? '', id)).toMatch(/reset_ok_m15/)
})

test('TRESET-2 터미널 우클릭 [터미널 초기화]', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await armMouse(page, id)
  // 마우스 추적이 켜져 있으면 우클릭이 셸로 갈 수 있다 — Shift 를 눌러 xterm 이 앱 메뉴로 넘기게 한다.
  await page.locator('.pane-grid .pane:visible .term-pane').first().click({ button: 'right', modifiers: ['Shift'] })
  await page.getByRole('menuitem', { name: /터미널 초기화/ }).click()
  await expect.poll(async () => (await modes(page, id))?.mouse).toBe('none')
})
