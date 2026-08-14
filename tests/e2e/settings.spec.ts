// 설정 창 8섹션 (F5 폰트 + R5 확장 + W2 로그 + W3 AI + F23 MCP) — 즉시 적용 · 영속 · 라이선스 고지
import { test, expect, newLocalShell, persist, quitAra } from './fixtures'

const drawer = '.drawer.open'

// SET-1 진입점 3개(Ctrl+, · 우측 액티비티 바 설정 아이콘 · File 메뉴)와 8섹션(W3 F16 에서 [AI] 추가로
// 6→7, F23 에서 [MCP] 추가로 7→8). FB-ui2: 두 번째 진입점이 타이틀바 기어(.tb-gear, 제거됨)에서
// 액티비티 바로 이관됐다.
test('SET-1 설정 창이 세 진입점 모두에서 열리고 8개 섹션을 갖는다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+,')
  await expect(page.locator(drawer)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(drawer)).toHaveCount(0)

  await page.click('.act-item[data-activity="settings"]')
  await expect(page.locator(drawer)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.click('.tb-menu span:text-is("File")')
  await page.click('.ctx-menu .ctx-item[data-action="settings.open"]')
  await expect(page.locator(drawer)).toBeVisible()

  const sections = await page.locator(`${drawer} .set-nav [data-section]`).allTextContents()
  expect(sections).toEqual(['일반', '터미널', '폰트', '로그', 'AI', 'MCP', '단축키', '정보'])
  for (const s of ['general', 'terminal', 'font', 'log', 'ai', 'mcp', 'keys', 'about']) {
    await page.click(`${drawer} .set-nav [data-section="${s}"]`)
    await expect(page.locator(`${drawer} .set-nav [data-section="${s}"]`)).toHaveAttribute('aria-selected', 'true')
  }
})

// SET-2 폰트 크기·행간이 CSS 변수와 미리보기에 즉시 반영된다
test('SET-2 폰트 크기·행간이 즉시 반영된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="font"]`)
  await page.locator(`${drawer} input[aria-label="글자 크기"]`).fill('18')
  await expect(page.locator(`${drawer} .fp-controls .cg`).first().locator('.v')).toHaveText('18px')
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tt')))
    .toBe('18px')
  await page.locator(`${drawer} input[aria-label="행 간격"]`).fill('1.8')
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tl')))
    .toBe('1.8')
})

// SET-3 한글 폰트 선택 + 실사용 한글 미리보기(스펙 AC #5)
test('SET-3 폰트를 고르면 미리보기와 터미널에 함께 적용된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="font"]`)
  // 미리보기는 알파벳이 아니라 실제 한글 터미널 출력이어야 한다.
  await expect(page.locator(`${drawer} .preview-box .pb-body`)).toContainText('데이터베이스 백업이 완료되었습니다')
  await expect(page.locator(`${drawer} .font-compare .fc-row`)).toHaveCount(4)

  const items = page.locator(`${drawer} .font-list .font-item`)
  expect(await items.count()).toBeGreaterThan(1)
  await items.nth(1).click()
  await expect(items.nth(1)).toHaveClass(/sel/)
  const stack = await page.evaluate(() => document.documentElement.style.getPropertyValue('--term'))
  expect(stack.length).toBeGreaterThan(0)
})

// SET-4 커서 모양·깜빡임이 열려 있는 세션에 즉시 반영된다
test('SET-4 커서 설정이 열린 세션에 즉시 반영된다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="terminal"]`)
  await page.click(`${drawer} .set-row:has(.sr-label:text-is("커서 모양")) .seg-ctl button[data-value="bar"]`)
  await expect.poll(async () => page.evaluate((sid) => window.__evTerm(sid)?.cursorStyle, id)).toBe('bar')
  await page.click(`${drawer} .set-row:has(.sr-label:text-is("커서 깜빡임")) .set-toggle`)
  await expect.poll(async () => page.evaluate((sid) => window.__evTerm(sid)?.cursorBlink, id)).toBe(false)
})

// SET-5 는 우클릭 메뉴 스타일 전환이었다 — #67(2026-08-14)에서 라디얼·팔레트를 지우며 설정 줄
// 자체가 없어졌다. "그 줄이 남아 있지 않은가"는 CTX-3★ 이 본다.

// SET-6 [정보] 섹션 — 버전과 번들 폰트 OFL 고지
test('SET-6 정보 섹션이 버전과 폰트 라이선스를 보여 준다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="about"]`)
  await expect(page.locator(`${drawer} .set-row .sr-label`).first()).toHaveText('A.R.A')
  await expect(page.locator(`${drawer} .sr-ctl .v`).first()).toHaveText(/^v\d/)
  expect(await page.locator(`${drawer} .license-list .license-row`).count()).toBeGreaterThan(0)
  await expect(page.locator(`${drawer} .license-list .lic-ofl`).first()).toHaveText('SIL Open Font License 1.1')
})

// SET-7 [단축키] 섹션은 keymap 단일 소스에서 생성된다(배선된 키만)
test('SET-7 단축키 섹션이 실제 배선된 단축키만 보여 준다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="keys"]`)
  const rows = await page.locator(`${drawer} .set-keys .cs-row .cs-desc`).allTextContents()
  expect(rows).toContain('가로 분할')
  expect(rows).toContain('연결 관리자')
  // 2026-08-14: 로그 저장이 실배선돼(로그 패널을 연다) 이제 여기에도 실린다.
  expect(rows).toContain('로그 저장')
  // 백로그 M-5(FINAL-batch 에서 수정됨): KEY_GROUPS 에 { title:'AI', cats:['ai'] } 그룹이 추가돼
  // ai.ask/ai.toggle 이 이제 설정 [단축키]에도 나온다(치트시트 `?` 에는 원래부터 나왔다 — KEY-1).
  // 이 테스트는 그 수정 전에는 반대(not.toContain)를 기대하고 있었다 — 갱신.
  expect(rows).toContain('AI에게 질문')
  expect(rows).toContain('AI 창 토글')
})

// SET-8 FB-monitor(FB-0004): [단축키] 섹션의 "tmux 사용법 보기" → 명령어 북(F18)이 tmux 카테고리로 바로 열린다.
test('SET-8 [단축키]의 tmux 사용법 보기가 명령어 북을 tmux 카테고리로 연다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="keys"]`)
  await page.click(`${drawer} [data-action="cmdbook.open.tmux"]`)

  // F24 [피드백 작성]과 같은 규칙 — 설정 창을 강제로 닫지 않는다(모달 위에 쌓인다).
  await expect(page.locator('.cheatsheet.open')).toBeVisible()
  const cats = new Set(await page.locator('.cheatsheet.open .cb-list .cb-cat').allTextContents())
  expect(cats).toEqual(new Set(['tmux']))
  expect(await page.locator('.cheatsheet.open .cb-list .cb-item').count()).toBeGreaterThan(0)
})

// SET-9 (UI-font) 폰트를 바꾸면 UI(사이드바 세션명)도 터미널과 같은 폰트로 즉시 바뀐다
test('SET-9 폰트를 바꾸면 사이드바 세션명도 같은 폰트로 즉시 바뀐다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  const sessName = page.locator('.sess-node .sess-name').first()
  await expect(sessName).toBeVisible()
  const before = await sessName.evaluate((el) => getComputedStyle(el).fontFamily)

  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="font"]`)
  const items = page.locator(`${drawer} .font-list .font-item`)
  expect(await items.count()).toBeGreaterThan(1)
  // 현재 선택과 다른 항목을 고른다(0 이 이미 선택돼 있으면 1을, 아니면 0을 고른다).
  const alreadySel = (await items.nth(0).getAttribute('class'))?.includes('sel') ?? false
  const pick = items.nth(alreadySel ? 1 : 0)
  await pick.click()
  await page.keyboard.press('Escape')

  await expect
    .poll(async () => sessName.evaluate((el) => getComputedStyle(el).fontFamily))
    .not.toBe(before)
  const afterSidebar = await sessName.evaluate((el) => getComputedStyle(el).fontFamily)
  const mono = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mono'))
  // --mono 는 store/font.ts 의 bindCssVars 가 --term 과 항상 같게 세팅한다(UI-font) — 사이드바가 그 값을 그대로
  // 따르는지 확인한다(브라우저가 홑/겹 인용부호를 폰트명 공백 유무에 따라 다르게 정규화하므로 인용부호를 떼고 비교).
  const strip = (s: string) => s.replace(/["']/g, '')
  expect(strip(afterSidebar)).toBe(strip(mono.trim()))
})

// SET-8 설정이 재기동 후에도 유지된다
test('SET-8 바꾼 설정이 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await a1.page.keyboard.press('Control+,')
  await a1.page.click(`${drawer} .set-nav [data-section="font"]`)
  await a1.page.locator(`${drawer} input[aria-label="글자 크기"]`).fill('19')
  await a1.page.click(`${drawer} .set-nav [data-section="terminal"]`)
  await a1.page.click(`${drawer} .set-row:has(.sr-label:text-is("커서 모양")) .seg-ctl button[data-value="underline"]`)
  await a1.page.keyboard.press('Escape')
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect
    .poll(async () => a2.page.evaluate(() => document.documentElement.style.getPropertyValue('--tt')), {
      timeout: 20_000
    })
    .toBe('19px')
  await a2.page.keyboard.press('Control+,')
  await a2.page.click(`${drawer} .set-nav [data-section="terminal"]`)
  await expect(
    a2.page.locator(`${drawer} .set-row:has(.sr-label:text-is("커서 모양")) .seg-ctl button[data-value="underline"]`)
  ).toHaveClass(/on/)
})

// SET-ACT★ 우측 아이콘 바 구성 — 준영님 2026-08-13: "우측 사이드바에 기능이 박혀 있는데
// 설정에서 껐다 켰다, 순서 변경하게 해줘". 판정은 **실제 바**가 따라 움직이는지로 한다.
test('SET-ACT★ 우측 아이콘 바를 설정에서 끄고 켜고 순서를 바꾼다', async ({ ara }) => {
  const { page } = ara
  const barIds = () =>
    page.locator('.activity-bar .act-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.activity))
  const cfgRow = (id: string) => page.locator(`${drawer} .act-cfg-row[data-activity="${id}"]`)

  const before = await barIds()
  expect(before[0]).toBe('ai')
  expect(before).toContain('log')

  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="general"]`)
  await expect(cfgRow('ai')).toBeVisible()

  // ① 끄면 바에서 사라진다.
  await cfgRow('log').locator('.set-toggle').click()
  await expect.poll(barIds).not.toContain('log')
  // 목록에서는 자리를 지킨다(다시 켜면 그 자리로 돌아온다는 것이 보여야 한다).
  await expect(cfgRow('log')).toHaveClass(/off/)

  // ② 다시 켜면 원래 자리로 돌아온다.
  await cfgRow('log').locator('.set-toggle').click()
  await expect.poll(barIds).toEqual(before)

  // ③ 순서를 바꾸면 바도 따라 바뀐다.
  await cfgRow('monitor').locator('[data-action="up"]').click()
  await expect.poll(barIds).toEqual(['monitor', 'ai', ...before.slice(2)])
  // 맨 위 항목은 더 올릴 수 없다.
  await expect(cfgRow('monitor').locator('[data-action="up"]')).toBeDisabled()
})

// SET-ACT2 설정한 구성이 재기동 후에도 남는다(ui.activityOrder/activityHidden).
test('SET-ACT2 아이콘 바 구성이 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await a1.page.keyboard.press('Control+,')
  await a1.page.click(`${drawer} .set-nav [data-section="general"]`)
  await a1.page.locator(`${drawer} .act-cfg-row[data-activity="preview"] .set-toggle`).click()
  await a1.page.locator(`${drawer} .act-cfg-row[data-activity="monitor"] [data-action="up"]`).click()
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  const ids = await a2.page
    .locator('.activity-bar .act-item')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.activity))
  expect(ids[0]).toBe('monitor')
  expect(ids).not.toContain('preview')
})
