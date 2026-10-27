// 앱 크롬 (R4) — 메뉴바 · 창 컨트롤 · 상태바 · 사이드바 · 창 제목
import { test, expect, newLocalShell, persist, quitAra, sessionList } from './fixtures'

// CHROME-1 메뉴바 6개가 모두 열리고 항목이 들어 있다(R4.1 이전엔 Session 만 동작했다)
test('CHROME-1 메뉴바 6개가 모두 드롭다운으로 열린다', async ({ ara }) => {
  const { page } = ara
  const titles = await page.locator('.tb-menu span').allTextContents()
  // 2026-08-21(b7dd258)에 메뉴바가 한글이 됐다 — 라벨은 MENUBAR 단일 출처에서 온다.
  expect(titles).toEqual(['파일', '편집', '세션', '분할', '보기', '도움말'])
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
  await page.click('.tb-menu span:text-is("분할")')
  await page.click('.ctx-menu .ctx-item[data-action="split.horizontal"]')
  await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(page.locator('.pane-grid .div-row')).toHaveCount(1)
})

// CHROME-3 Help > ARA 정보
// 1.0.10(5e3c3c6): 앱 이름이 A.R.A → ARA(i18n app.name — Windows 검색에서 찾게). 치트시트·부팅 인사 글자는 그대로 A.R.A.
test('CHROME-3 Help 메뉴에서 앱 정보를 연다', async ({ ara }) => {
  const { page } = ara
  await page.click('.tb-menu span:text-is("도움말")')
  await page.click('.ctx-menu .ctx-item[data-action="help.about"]')
  await expect(page.locator('.dlg-overlay .modal.sm')).toContainText('ARA 정보')
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
  // 2.0 4단계: 호스트·인코딩·버전 칸은 라벨 없이 값만(시안 Z-final). 오른쪽 순서는 UTF-8 · 세션 n · 버전(2단계).
  await expect(page.locator('.statusbar .sb-seg.host .lbl')).toHaveCount(0)
  const right = page.locator('.statusbar .sb-right')
  await expect(right.locator('.sb-seg.enc .val')).toHaveText('UTF-8')
  await expect(right.locator('.sb-seg:has(.lbl:text-is("세션")) .val')).toHaveText('1')
  await expect(right.locator('.sb-seg.ver .val')).toHaveText(/^v\d/)
  // 순서: 앞의 MCP 칸(children)은 상황에 따라 있다 — 뒤 세 칸의 상대 순서만 본다.
  const order = await right.locator('.sb-seg').evaluateAll((els) =>
    els.map((e) => (e.classList.contains('enc') ? 'enc' : e.classList.contains('ver') ? 'ver' : e.querySelector('.lbl')?.textContent ?? ''))
  )
  expect(order.slice(-3)).toEqual(['enc', '세션', 'ver'])
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
  await expect(page.locator('.lrail-item[data-tab].active')).toHaveCount(0) // 닫히면 눌림도 풀린다
  await page.keyboard.press('Control+Shift+B')
  await expect(sidebar).not.toHaveClass(/collapsed/)
  // Ctrl+Shift+E = [파일] 탭 토글. 세션이 있어야 한다 — 세션이 0개면 [파일] 탭은 disabled 이고
  // 사이드바가 [연결] 로 고정된다(Sidebar.tsx: `const tab = fileSession ? active : 'conn'`).
  //
  // 2026-08-22(준영님 제보 6번): 셸을 열면 앱이 **스스로 [파일] 로 넘어간다**(연 폴더를 바로
  // 보여 준다). 그래서 여기서 Ctrl+Shift+E 는 여는 키가 아니라 **닫는 키**다 — 그게 같은 규칙이다.
  await newLocalShell(page)
  await expect(page.locator('.lrail-item[data-tab].active')).toHaveAttribute('data-tab', 'file')
  await page.keyboard.press('Control+Shift+E')
  await expect(sidebar).toHaveClass(/collapsed/)
  // 다시 누르면 [파일] 로 돌아온다.
  await page.keyboard.press('Control+Shift+E')
  await expect(page.locator('.lrail-item[data-tab].active')).toHaveAttribute('data-tab', 'file')
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
  await expect.poll(async () => page.title()).toBe('ARA') // 1.0.10: 앱 이름 ARA
  await newLocalShell(page)
  const title = (await sessionList(page))[0].title
  await expect.poll(async () => page.title(), { timeout: 15_000 }).toBe(`ARA — ${title}`)
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
