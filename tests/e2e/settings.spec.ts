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
// "그게 개발용 티의 8할이었다") — 이제 `--ui`(Pretendard, 2026-10-08~11 은 SUIT) 고정이고 사용자가 고르는 것은 `--term` 뿐이다.
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

// SET-ACT★ 아이콘 바·하단 탭줄의 목록과 순서.
// 2026-08-30 준영님 결정으로 설정 [우측 아이콘 바]가 **없어졌다**(순서·숨기기 둘 다).
// 순서를 고칠 손잡이가 없으니 **파생이 틀리면 사용자가 되돌릴 수 없다** — 그만큼 이 계약이
// 살아 있어야 한다. 단위 검사(tests/activityBar.test.ts)는 배열만 보고, 여기서는 **진짜 화면**을 본다.
test('SET-ACT★ 아이콘 바는 ACTIVITY_ITEMS 순서, 하단 탭줄은 BOTTOM_IDS 열 개', async ({ ara }) => {
  const { page } = ara
  await page.click('.act-bottombar')
  await expect(page.locator('.bottom-panel')).toBeVisible()

  const barIds = await page
    .locator('.activity-bar .act-item')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.activity))
  const dockIds = await page
    .locator('.bottom-panel .bp-tab')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bottom))

  // 레일 = ACTIVITY_ITEMS 에서 isBottomId 아닌 것 + 맨 아래 [하단바] 토글(ActivityId 가 아니다).
  expect(barIds).toEqual(['ai', 'pastlog', 'preview', 'explorer', 'cmdbook', 'settings', 'bottombar'])
  // 하단 탭줄 = BOTTOM_IDS 그대로. 숨기기가 없어졌으니 **늘 열**이다(준영님이 감수하신 결과).
  expect(dockIds).toEqual(['monitor', 'sys', 'ps', 'svc', 'disk', 'pkg', 'ctr', 'k8s', 'log', 'applog'])
  // 둘 다에 있으면 같은 도구가 화면에 두 번 나온다.
  for (const id of dockIds) expect(barIds).not.toContain(id)

  // 설정 [일반]에 그 목록이 남아 있으면 안 된다.
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="general"]`)
  await expect(page.locator(`${drawer} .act-cfg`)).toHaveCount(0)
})
