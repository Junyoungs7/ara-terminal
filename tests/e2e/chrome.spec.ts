// 앱 크롬 (R4) — 메뉴바 · 창 컨트롤 · 상태바 · 사이드바 · 창 제목
import { test, expect, newLocalShell, persist, quitAra, sessionList } from './fixtures'

// CHROME-1 메뉴바 6개가 모두 열리고 항목이 들어 있다(R4.1 이전엔 Session 만 동작했다)
test('CHROME-1 메뉴바 6개가 모두 드롭다운으로 열린다', async ({ ara }) => {
  const { page } = ara
  const titles = await page.locator('.tb-menu span').allTextContents()
  expect(titles).toEqual(['File', 'Edit', 'Session', 'Split', 'View', 'Help'])
  for (const title of titles) {
    await page.click(`.tb-menu span:text-is("${title}")`)
    await expect(page.locator('.ctx-menu')).toBeVisible()
    expect(await page.locator('.ctx-menu .ctx-item').count()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
  }
})

// CHROME-2 메뉴 항목은 단축키와 같은 경로로 실행된다("메뉴에서만 되는 기능" 금지)
test('CHROME-2 Split 메뉴의 가로 분할이 실제로 분할한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.tb-menu span:text-is("Split")')
  await page.click('.ctx-menu .ctx-item[data-action="split.horizontal"]')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.pane-grid .div-row')).toHaveCount(1)
})

// CHROME-3 Help > A.R.A 정보
test('CHROME-3 Help 메뉴에서 앱 정보를 연다', async ({ ara }) => {
  const { page } = ara
  await page.click('.tb-menu span:text-is("Help")')
  await page.click('.ctx-menu .ctx-item[data-action="help.about"]')
  await expect(page.locator('.dlg-overlay .modal.sm')).toContainText('A.R.A 정보')
  await expect(page.locator('.dlg-overlay .dlg-detail')).toContainText('버전')
})

// CHROME-4 신호등 창 컨트롤이 실제로 창을 조작한다(R2.6)
test('CHROME-4 최대화 버튼이 창을 최대화·복원한다', async ({ ara }) => {
  const { page, app } = ara
  const isMax = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
  expect(await isMax()).toBe(false)
  await page.click('.titlebar .tb-ctl.max')
  await expect.poll(isMax, { timeout: 10_000 }).toBe(true)
  await page.click('.titlebar .tb-ctl.max')
  await expect.poll(isMax, { timeout: 10_000 }).toBe(false)
})

// CHROME-5 상태바가 유휴 → 로컬 셸 → 세션 수를 실데이터로 반영한다(R4.2)
test('CHROME-5 상태바가 활성 세션을 반영한다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.statusbar .sb-seg.host')).toHaveClass(/idle/)
  await expect(page.locator('.statusbar .sb-seg.host .val')).toHaveText('유휴 — 열린 세션 없음')
  await newLocalShell(page)
  await expect(page.locator('.statusbar .sb-seg.host')).not.toHaveClass(/idle/)
  await expect(page.locator('.statusbar .sb-seg.host .lbl')).toHaveText('셸')
  const right = page.locator('.statusbar .sb-right .sb-seg')
  await expect(right.nth(0).locator('.val')).toHaveText('1')
  await expect(right.nth(1).locator('.val')).toHaveText('UTF-8')
  await expect(right.nth(2).locator('.val')).toHaveText(/^v\d/)
})

// CHROME-6 사이드바 접기(버튼 · 단축키)와 [연결|파일] 탭 전환
test('CHROME-6 사이드바를 접고 펴고 탭을 전환한다', async ({ ara }) => {
  const { page } = ara
  const sidebar = page.locator('.sidebar')
  await expect(sidebar).not.toHaveClass(/collapsed/)
  // 2026-08-19: 접기 손잡이(`.sb-toggle`)를 없앴다 — **열려 있는 레일 아이콘을 다시 누르면 닫힌다**
  // (IntelliJ 툴윈도우). 여는 자리와 닫는 자리가 같아진 것이 이 변경의 알맹이다.
  await page.click('.lrail-item[data-tab="conn"]')
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect(page.locator('.lrail-item.active')).toHaveCount(0) // 닫히면 눌림도 풀린다
  await page.keyboard.press('Control+Shift+B')
  await expect(sidebar).not.toHaveClass(/collapsed/)
  // Ctrl+Shift+E = [파일] 탭 토글. 세션이 있어야 한다 — 세션이 0개면 [파일] 탭은 disabled 이고
  // 사이드바가 [연결] 로 고정된다(Sidebar.tsx: `const tab = fileSession ? active : 'conn'`).
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+E')
  await expect(page.locator('.lrail-item.active')).toHaveAttribute('data-tab', 'file')
  // 같은 것을 다시 누르면 닫는다 — 단축키도 레일과 같은 규칙이다(예전엔 [연결] 로 넘어갔다).
  await page.keyboard.press('Control+Shift+E')
  await expect(sidebar).toHaveClass(/collapsed/)
})

// CHROME-7 사이드바 폭 드래그 + 재기동 후 폭 유지(R4.3)
test('CHROME-7 사이드바 폭을 끌어 바꾸면 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  const width = () => a1.page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width)
  const before = await width()
  const handle = a1.page.locator('.sb-resizer')
  const box = await handle.boundingBox()
  if (!box) throw new Error('사이드바 손잡이를 찾지 못했다')
  await a1.page.mouse.move(box.x + box.width / 2, box.y + 200)
  await a1.page.mouse.down()
  await a1.page.mouse.move(box.x + 90, box.y + 200, { steps: 8 })
  await a1.page.mouse.up()
  await expect.poll(width, { timeout: 10_000 }).toBeGreaterThan(before + 40)
  const after = await width()
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect
    .poll(async () => a2.page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width), {
      timeout: 20_000
    })
    .toBeCloseTo(after, 0)
})

// CHROME-8 창 제목(OS 작업표시줄)이 활성 세션을 반영한다(R4.4)
test('CHROME-8 창 제목이 활성 세션을 따라간다', async ({ ara }) => {
  const { page } = ara
  await expect.poll(async () => page.title()).toBe('A.R.A')
  await newLocalShell(page)
  const title = (await sessionList(page))[0].title
  await expect.poll(async () => page.title(), { timeout: 15_000 }).toBe(`A.R.A — ${title}`)
})

// CHROME-9 타이틀바 ? 버튼 = 치트시트
test('CHROME-9 타이틀바 ? 가 치트시트를 연다', async ({ ara }) => {
  const { page } = ara
  await page.click('.titlebar .tb-help')
  await expect(page.locator('.cheatsheet.open')).toBeVisible()
  await expect(page.locator('.cheatsheet .cs-hd h2')).toHaveText('A.R.A 단축키 치트시트')
  await page.keyboard.press('Escape')
  await expect(page.locator('.cheatsheet')).toHaveCount(0)
})
