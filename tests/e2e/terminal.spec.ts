// 터미널 표준 동작 (R3) — 검색 · 스크롤백 · ANSI · URL · 글자 크기 · 자동 제목
import { test, expect, newLocalShell, runCommand, expectTermText, sendInput, connectNewSshProfile, browserWindows, ctrlClickLink } from './fixtures'

// TERM-1 Ctrl+Shift+F 터미널 내 검색(한글 포함)
test('TERM-1 터미널 안에서 한글을 검색한다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 검색대상_문구_한글')
  await expectTermText(page, id, /검색대상_문구_한글/)
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.term-search')).toBeVisible()
  await page.fill('.term-search .ts-input', '검색대상_문구')
  // 매치가 있으면 miss 표시가 붙지 않는다.
  await expect(page.locator('.term-search .ts-input')).not.toHaveClass(/miss/)
  await expect(page.locator('.term-search .ts-miss')).toHaveCount(0)
})

// TERM-2 결과 없음 표시
test('TERM-2 검색 결과가 없으면 알려 준다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+F')
  await page.fill('.term-search .ts-input', '절대없는문자열_zzzz')
  await expect(page.locator('.term-search .ts-miss')).toHaveText('결과 없음')
  await expect(page.locator('.term-search .ts-input')).toHaveClass(/miss/)
})

// TERM-3 ESC 로 검색 바 닫기
test('TERM-3 ESC 로 검색 바를 닫는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+F')
  await expect(page.locator('.term-search')).toBeVisible()
  await page.locator('.term-search .ts-input').press('Escape')
  await expect(page.locator('.term-search')).toHaveCount(0)
})

// TERM-4 ANSI 16색 팔레트가 xterm 테마로 주입된다(R3.5)
test('TERM-4 ANSI 16색 테마가 터미널에 적용된다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  const theme = await page.evaluate((sid) => window.__evTerm(sid)?.theme ?? {}, id)
  for (const key of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    expect(theme[key], `ANSI ${key} 누락`).toBeTruthy()
    expect(theme['bright' + key[0].toUpperCase() + key.slice(1)], `bright ${key} 누락`).toBeTruthy()
  }
  expect(theme.background).toBeTruthy()
})

// TERM-5 스크롤백 설정이 열려 있는 세션에 즉시 반영된다(R3.4/R5)
test('TERM-5 스크롤백 설정이 즉시 반영된다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  const before = await page.evaluate((sid) => window.__evTerm(sid)?.scrollback, id)
  await page.keyboard.press('Control+,')
  await page.click('.drawer .set-nav [data-section="general"]')
  const slider = page.locator('.drawer .set-row:has(.sr-label:text-is("스크롤백")) input[type="range"]')
  await slider.fill('20000')
  await page.keyboard.press('Escape')
  await expect.poll(async () => page.evaluate((sid) => window.__evTerm(sid)?.scrollback, id)).toBe(20000)
  expect(before).not.toBe(20000)
})

// TERM-6 Ctrl+휠로 글자 크기를 바꾼다(R3.7) — 설정 슬라이더와 같은 범위·같은 저장 경로
test('TERM-6 Ctrl+휠로 터미널 글자 크기를 바꾼다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  const size = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tt'))
  const before = parseInt((await size()) || '14', 10)
  const pane = page.locator('.pane-grid .pane:visible .term-pane').first()
  const box = await pane.boundingBox()
  if (!box) throw new Error('터미널 위치를 찾지 못했다')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(async () => parseInt((await size()) || '0', 10), { timeout: 10_000 }).toBe(before + 1)
})

// TERM-7 셸이 보낸 OSC 0/2 제목이 탭 이름이 된다(R3.6)
// 로컬 셸은 프롬프트가 제목을 계속 덮어써 판정이 흔들린다 — 입력을 그대로 되돌려주는 SSH 하네스로 검증한다.
test('TERM-7 셸이 보낸 제목이 탭 이름에 반영된다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-term7' })
  const id = await connectNewSshProfile(page, { name: 'title-remote', port: h.port, password: 'pw-term7' })
  // OSC 0 = 창 제목. 하네스가 입력을 그대로 되돌려주므로 xterm 이 출력으로 받아 파싱한다.
  await sendInput(page, id, '\u001b]0;셸이정한제목\u0007')
  await expect(page.locator(`.term-tabbar .ttab[data-session-id="${id}"] .tlabel`)).toHaveText('셸이정한제목', {
    timeout: 20_000
  })
})

// TERM-8 사용자가 바꾼 이름은 셸 제목이 덮어쓰지 않는다(R3.6 manualTitle)
test('TERM-8 사용자가 정한 탭 이름은 셸 제목보다 우선한다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-term8' })
  const id = await connectNewSshProfile(page, { name: 'manual-remote', port: h.port, password: 'pw-term8' })
  const tab = page.locator(`.term-tabbar .ttab[data-session-id="${id}"]`)
  await tab.dblclick()
  await page.fill('.term-tabbar .tt-edit', '내이름우선')
  await page.keyboard.press('Enter')
  await expect(tab.locator('.tlabel')).toHaveText('내이름우선')
  await sendInput(page, id, '\u001b]0;셸이덮어쓰려함\u0007')
  await page.waitForTimeout(1500)
  await expect(tab.locator('.tlabel')).toHaveText('내이름우선')
})

// TERM-9 URL 은 수식자 클릭으로만 열린다(R3.3). 2026-09-10(linkTarget.ts planLink) 뒤로 로컬 셸의
// Ctrl+클릭은 **아라 브라우저**, Ctrl+Alt+클릭이 OS 브라우저(main 의 app:openExternal)다 — 둘 다 본다.
test('TERM-9 URL 은 수식자 클릭으로만 열린다 — Ctrl 은 아라 브라우저, Ctrl+Alt 는 외부 브라우저', async ({ ara }) => {
  const { page, app } = ara
  // 실제 브라우저를 띄우지 않도록 main 핸들러를 가로챈다(호출 여부만 기록).
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    ipcMain.removeHandler('app:openExternal')
    ipcMain.handle('app:openExternal', (_e, { url }: { url: string }) => {
      g.__opened.push(url)
      return { ok: true }
    })
  })
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo https://example.invalid/docs')
  await expectTermText(page, id, /example\.invalid\/docs/)

  const link = page.locator('.pane-grid .pane:visible .xterm-rows').getByText('https://example.invalid/docs').last()
  await link.waitFor({ timeout: 10_000 })
  await link.click() // 수식자 없는 클릭 — 열리면 안 된다
  await page.waitForTimeout(600)
  expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([])
  expect(await browserWindows(app)).toHaveLength(0)
  // 호버 확정을 기다리는 클릭(fixtures ctrlClickLink — 맨 클릭으로 떨어지지 않게).
  await ctrlClickLink(page, 'https://example.invalid/docs')
  await expect.poll(async () => (await browserWindows(app))[0]?.url ?? '', { timeout: 25_000 }).toBe('https://example.invalid/docs')
  expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([])
  await ctrlClickLink(page, 'https://example.invalid/docs', true)
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened), { timeout: 10_000 })
    .toEqual(['https://example.invalid/docs'])
})
