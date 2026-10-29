// 클립보드 (R3.1 Windows Terminal 관례 + R5 선택 자동 복사)
// 클립보드 확인은 main 의 electron.clipboard 로 한다 — 렌더러 navigator.clipboard 를 다시 읽으면
// "앱이 쓴 값을 앱이 읽는" 자기검증이 된다.
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, newLocalShell, runCommand, expectTermText, termText } from './fixtures'

// OS 클립보드는 워커가 공유하는 전역 자원이다 — 이 파일 안에서는 병렬 실행을 끈다
// (안 그러면 다른 클립보드 테스트가 남의 값을 덮어써 실패한다).
// ⚠️ T2-W3: 'default' 는 이 프로젝트의 fullyParallel:true 를 그대로 물려받아 **병렬로 돈다** —
// 이 파일 6개만 돌리면 우연히 워커 1개로 떨어져 통과하다가, 전체 스위트를 돌리면 다른 파일의
// 테스트와 워커를 나눠 받으며 같은 순간 OS 클립보드를 건드려 CLIP-1·3·4·6 이 흔들렸다(회귀 아님 —
// 항상 이 파일의 병렬 설정이 무력했던 버그다). 'serial' 이 실제로 한 워커에 묶어 순서대로 돈다.
test.describe.configure({ mode: 'serial' })

const readClipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())
const writeClipboard = (app: ElectronApplication, text: string) =>
  app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)

// 터미널에 포커스를 준다(단축키가 xterm 의 커스텀 키 핸들러를 거치게 하려면 필요).
async function focusTerminal(page: Page): Promise<void> {
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
}

// 브라우저의 async 클립보드 쓰기는 **문서에 포커스가 있어야** 한다. e2e 는 사용자 화면을 뺏지 않으려고
// 창을 showInactive() 로 띄우므로(ARA_E2E=1) 그 조건이 저절로 만족되지 않는다.
//
// **`BrowserWindow.focus()` 는 쓰지 않는다.** OS 포커스를 뺏으면 ① 준영님 화면을 가로채고
// (2026-08-11 규칙) ② 같은 순간 다른 워커에서 도는 창이 포커스를 잃어 그쪽 붙여넣기 검사가 깨진다
// (2026-08-13 PASTE-6 이 정확히 그렇게 깨졌다). `webContents.focus()` 는 창을 앞으로 끌어내지 않고
// 웹 콘텐츠에만 포커스를 준다 — 필요한 건 그것뿐이다.
async function focusWebContents(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.focus())
}

// CLIP-1 선택이 있으면 Ctrl+C = 복사(셸로 보내지 않는다)
test('CLIP-1 선택 상태의 Ctrl+C 는 복사한다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 복사대상_문자열')
  await expectTermText(page, id, /복사대상_문자열/)
  await writeClipboard(app, '')
  await focusWebContents(app)
  await focusTerminal(page)
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)
  await page.keyboard.press('Control+c')
  await expect.poll(() => readClipboard(app), { timeout: 10_000 }).toContain('복사대상_문자열')
})

// CLIP-1b★ 복사가 거부되면 **조용히 넘어가지 않는다**(준영님 결정 2026-08-13 — "토스트로 알려줘").
// 그전에는 `.catch(() => {})` 로 삼켜서, 사용자는 복사된 줄 알고 붙여넣다가 이전 값을 붙였다.
//
// 거부를 **직접 만든다**(창 포커스를 뺏는 대신). 검증 대상은 "포커스가 없으면 브라우저가 거부한다"가
// 아니라 — 그건 Chromium 동작이지 우리 것이 아니다 — "거부되면 우리가 알리는가" 이기 때문이다.
// 창을 만졌다 놓았다 하는 방식은 OS 마다 결과가 달라 흔들리기도 한다.
test('CLIP-1b★ 복사가 거부되면 조용히 넘어가지 않고 안내가 뜬다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 거부확인_문자열')
  await expectTermText(page, id, /거부확인_문자열/)
  // cec8689(2026-08-31)부터 복사는 navigator.clipboard 가 아니라 main(clipboard:writeText)을 거친다 —
  // 렌더러 쪽을 막아 봐야 아무 일도 없다(그래서 "복사됨"이 떴다). 거부는 그 길의 끝, main 에서 만든다.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('clipboard:writeText')
    ipcMain.handle('clipboard:writeText', () => ({ ok: false }))
  })
  await focusTerminal(page)
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)
  await page.keyboard.press('Control+c')
  await expect(page.locator('.pane-toast')).toContainText('복사하지 못했습니다', { timeout: 10_000 })
})

// CLIP-2 선택이 없으면 Ctrl+C 는 셸로 간다(SIGINT — 앱이 가로채지 않는다)
test('CLIP-2 선택이 없으면 Ctrl+C 를 셸에 넘긴다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 인터럽트_표식_고유')
  await expectTermText(page, id, /인터럽트_표식_고유/)
  await focusTerminal(page)
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(800)
  // 앱이 터미널 내용을 복사하지 않았다 + 셸이 계속 동작한다(= Ctrl+C 가 셸로 갔다).
  expect(await readClipboard(app)).not.toContain('인터럽트_표식_고유')
  await runCommand(page, id, 'echo 인터럽트후_정상')
  await expectTermText(page, id, /인터럽트후_정상/)
})

// CLIP-3 Ctrl+V 는 항상 붙여넣기(리드라인 quoted-insert 보다 우선)
test('CLIP-3 Ctrl+V 로 클립보드를 셸에 붙여넣는다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await writeClipboard(app, 'echo 붙여넣기_확인')
  await focusTerminal(page)
  await page.keyboard.press('Control+v')
  await expectTermText(page, id, /붙여넣기_확인/)
  // 붙여넣은 줄을 실행하면 실제 명령으로 동작한다.
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await termText(page, id)).split('붙여넣기_확인').length, { timeout: 20_000 })
    .toBeGreaterThan(2)
})

// CLIP-4 앱 단축키(Ctrl+Shift+C / Ctrl+Shift+V)도 같은 동작을 한다
test('CLIP-4 Ctrl+Shift+C 복사 · Ctrl+Shift+V 붙여넣기', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 앱단축키_복사원본')
  await expectTermText(page, id, /앱단축키_복사원본/)
  await writeClipboard(app, '')
  await focusTerminal(page)
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(() => readClipboard(app), { timeout: 10_000 }).toContain('앱단축키_복사원본')
  await expect(page.locator('.pane-toast')).toHaveText('복사됨')

  await writeClipboard(app, 'echo 앱단축키_붙여넣기')
  await page.keyboard.press('Control+Shift+V')
  await expectTermText(page, id, /앱단축키_붙여넣기/)
})

// CLIP-5 선택이 없을 때 Ctrl+Shift+C 는 안내만 한다
test('CLIP-5 선택 없이 복사하면 안내 토스트가 뜬다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await focusTerminal(page)
  await page.keyboard.press('Control+Shift+C')
  await expect(page.locator('.pane-toast')).toHaveText('선택된 텍스트가 없습니다')
})

// CLIP-6 선택 시 자동 복사 — 기본 켜짐(X11·PuTTY 관례), 설정에서 끄면 멈춘다
test('CLIP-6 선택 시 자동 복사는 기본 켜짐이고 설정에서 끌 수 있다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 자동복사_대상')
  await expectTermText(page, id, /자동복사_대상/)

  // 기본값 확인 + 실제 동작(선택 후 mouseup 시점에 복사).
  const toggle = page.locator('.drawer .set-row:has(.sr-label:text-is("선택 시 자동 복사")) .set-toggle')
  // 이 설정은 [일반] 섹션에 있다(터미널 동작이지만 화면 전체 습관이라 그쪽에 뒀다) — 열린 섹션을
  // 가정하지 않고 눌러서 간다.
  const openTerminalSection = async (): Promise<void> => {
    await page.keyboard.press('Control+,')
    await page.click('.drawer .set-nav [data-section="general"]')
  }
  await openTerminalSection()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')

  await writeClipboard(app, '')
  await focusTerminal(page)
  const pane = page.locator('.pane-grid .pane:visible .term-pane').first()
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)
  await pane.dispatchEvent('mouseup')
  await expect.poll(() => readClipboard(app), { timeout: 10_000 }).toContain('자동복사_대상')

  // 끄면 같은 선택으로도 클립보드가 바뀌지 않는다.
  await openTerminalSection()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
  await writeClipboard(app, '유지되어야_함')
  await focusTerminal(page)
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)
  await pane.dispatchEvent('mouseup')
  await page.waitForTimeout(1000)
  expect(await readClipboard(app)).toBe('유지되어야_함')
})
