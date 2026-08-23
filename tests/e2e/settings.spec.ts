// 설정 창 8섹션 (F5 폰트 + R5 확장 + W2 로그 + W3 AI + F23 MCP) — 즉시 적용 · 영속 · 라이선스 고지
import { test, expect, newLocalShell, persist, quitAra, openConnTab } from './fixtures'

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

  await page.click('.tb-menu span:text-is("파일")')
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
// SET-9 (G, 2026-08-21) 폰트 설정은 **터미널만** 바꾼다 — 사이드바·설정 같은 크롬 글꼴은 그대로다.
//
// 규칙이 뒤집힌 자리다. UI-font 시절에는 `--mono === --term` 이라 사이드바 세션명까지 코딩용
// 고정폭으로 바뀌었고, 이 검사도 그것을 확인했다. G 에서 **크롬 글꼴을 분리**했다(design-system §2:
// "그게 개발용 티의 8할이었다") — 이제 `--ui`(Pretendard) 고정이고 사용자가 고르는 것은 `--term` 뿐이다.
test('SET-9★ 폰트 설정은 터미널만 바꾸고 사이드바 글꼴은 그대로다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  // 셸을 열면 사이드바가 [파일] 로 넘어간다(2026-08-22 제보 6번) — 트리를 보려면 돌아온다.
  await openConnTab(page)
  const sessName = page.locator('.sess-node .sess-name').first()
  await expect(sessName).toBeVisible()
  const chromeFont = await sessName.evaluate((el) => getComputedStyle(el).fontFamily)
  const termBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--term').trim()
  )

  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="font"]`)
  const items = page.locator(`${drawer} .font-list .font-item`)
  expect(await items.count()).toBeGreaterThan(1)
  // 현재 선택과 다른 항목을 고른다(0 이 이미 선택돼 있으면 1을, 아니면 0을 고른다).
  const alreadySel = (await items.nth(0).getAttribute('class'))?.includes('sel') ?? false
  await items.nth(alreadySel ? 1 : 0).click()
  await page.keyboard.press('Escape')

  // 터미널 글꼴은 바뀐다.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--term').trim()))
    .not.toBe(termBefore)
  // 사이드바는 그대로다 — 크롬은 --ui 를 쓴다.
  expect(await sessName.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(chromeFont)
  const ui = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui'))
  const strip = (s: string) => s.replace(/["']/g, '')
  expect(strip(chromeFont)).toBe(strip(ui.trim()))
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
// 2026-08-17: 이 설정 하나가 **두 자리**를 움직인다 — 오른쪽·창에 열리는 것은 우측 액티비티 바,
// 아래에 열리는 여덟은 **하단 탭줄**. 하단만의 새 설정을 만들지 않았기 때문이고,
// 그 약속이 지켜지는지를 여기서 본다.
test('SET-ACT★ 아이콘 구성을 설정에서 끄고 켜고 순서를 바꾼다(바·탭줄 둘 다)', async ({ ara }) => {
  const { page } = ara
  const barIds = () =>
    page.locator('.activity-bar .act-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.activity))
  const dockIds = () =>
    page.locator('.bottom-panel .bp-tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bottom))
  const cfgRow = (id: string) => page.locator(`${drawer} .act-cfg-row[data-activity="${id}"]`)

  // 탭줄은 하단바를 켜야 나온다(IntelliJ 방식 — 토글 하나가 하단바 전체를 켠다).
  await page.click('.act-bottombar')
  await expect(page.locator('.bottom-panel')).toBeVisible()

  const before = await barIds()
  const beforeDock = await dockIds()
  expect(before[0]).toBe('ai')
  // 하단 도구는 바가 아니라 탭줄에 있다(둘 다에 있으면 안 된다).
  expect(before).not.toContain('log')
  expect(beforeDock).toContain('log')

  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="general"]`)
  await expect(cfgRow('ai')).toBeVisible()

  // ① 끄면 그 자리에서 사라진다(하단 항목은 탭줄에서).
  await cfgRow('log').locator('.set-toggle').click()
  await expect.poll(dockIds).not.toContain('log')
  // 목록에서는 자리를 지킨다(다시 켜면 그 자리로 돌아온다는 것이 보여야 한다).
  await expect(cfgRow('log')).toHaveClass(/off/)

  // ② 다시 켜면 원래 자리로 돌아온다.
  await cfgRow('log').locator('.set-toggle').click()
  await expect.poll(dockIds).toEqual(beforeDock)

  // ③ 순서를 바꾸면 **그 항목이 사는 자리**가 따라 바뀐다.
  //    sys 를 올리면 탭줄이, preview 를 끄면 바가 움직인다 — 순서·숨김은 하나인데
  //    그려지는 곳이 둘이라는 것을 양쪽으로 확인한다.
  await cfgRow('sys').locator('[data-action="up"]').click()
  await expect.poll(dockIds).toEqual(['sys', 'monitor', ...beforeDock.slice(2)])
  await expect.poll(barIds).toEqual(before) // 바는 그대로

  // 바 항목도 같은 설정에 반응한다. (순서로 보이려면 여러 번 올려야 한다 — 바 항목 사이에
  //  하단 항목이 끼어 있어서 한 칸 올리기로는 **바에서 보이는 순서**가 안 바뀐다. 끄기로 본다.)
  await cfgRow('preview').locator('.set-toggle').click()
  await expect.poll(barIds).not.toContain('preview')
  await cfgRow('preview').locator('.set-toggle').click()
  await expect.poll(barIds).toEqual(before)

  // 맨 위 항목은 더 올릴 수 없다(ai 는 목록 첫 자리 — 위 조작들이 그 자리를 안 건드렸다).
  await expect(cfgRow('ai').locator('[data-action="up"]')).toBeDisabled()
})

// SET-ACT2 설정한 구성이 재기동 후에도 남는다(ui.activityOrder/activityHidden).
test('SET-ACT2 아이콘 바 구성이 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await a1.page.keyboard.press('Control+,')
  await a1.page.click(`${drawer} .set-nav [data-section="general"]`)
  await a1.page.locator(`${drawer} .act-cfg-row[data-activity="preview"] .set-toggle`).click()
  await a1.page.locator(`${drawer} .act-cfg-row[data-activity="monitor"] [data-action="up"]`).click()
  await a1.page.keyboard.press('Escape')
  await a1.page.click('.act-bottombar') // 하단바를 켜 둔 채 재기동한다(탭 순서를 보려면 켜져 있어야 한다)
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  // 하단바 열림 여부는 세션 수명 상태라 재기동하면 꺼져 있다 — 다시 켜고 탭 순서를 본다.
  await a2.page.click('.act-bottombar')
  await a2.page.locator('.bottom-panel').waitFor({ state: 'visible' })
  // monitor 는 하단 도구라 **탭줄** 첫 자리로, preview 는 레일이라 **바**에서 사라졌어야 한다.
  const barIds = await a2.page
    .locator('.activity-bar .act-item')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.activity))
  const dockIds = await a2.page
    .locator('.bottom-panel .bp-tab')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bottom))
  expect(dockIds[0]).toBe('monitor')
  expect(barIds).not.toContain('preview')
})
