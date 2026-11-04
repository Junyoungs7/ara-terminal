// M1 라운드 2 — 상단 공간 전환 [터미널 | AI 작업] + 오른쪽 아이콘 바(시안 SW-final).
// M3 부터 기본 공개 — 옛 실험 기능 토글(설정 › 고급 › 실험 기능)은 섹션째 지웠다. 스위치는 늘 보인다.
import { test, expect, persist, quitAra } from './fixtures'

const drawer = '.settings-page.open'
const sw = '.titlebar .tb-spaces'

test('SPACE-1 기본 공개(M3) — 처음부터 스위치·오른쪽 아이콘 바·메뉴의 "공간:" 이 있고, 실험 기능 섹션은 없다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator(sw)).toBeVisible()
  await expect(page.locator(`${sw} [data-space="term"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.rbar')).toBeVisible()
  await page.click('.titlebar .tb-burger')
  await page.click('.tb-menu span:text-is("보기")')
  await expect(page.locator('.ctx-menu .ctx-item[data-action="space.ai"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  // 공간 키가 처음부터 먹는다.
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.ai-rail')).toBeVisible()
  await page.keyboard.press('Control+Alt+1')
  await expect(page.locator('.lrail')).toBeVisible()
  // 설정에 실험 기능 섹션·토글이 없다.
  await page.keyboard.press('Control+,')
  await expect(page.locator(`${drawer} .sp-nav [data-section="experimental"]`)).toHaveCount(0)
  await expect(page.locator(`${drawer} [data-item="exp.aiSpace"]`)).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('SPACE-2★ 스위치 → AI 작업 공간 전환·되돌리기 → 재시작 유지', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  const page = a1.page
  await expect(page.locator(sw)).toBeVisible()
  await expect(page.locator(`${sw} [data-space="term"]`)).toHaveAttribute('aria-selected', 'true')

  // 스위치 클릭 → AI 작업 공간: 왼쪽 레일·가운데·상태바 왼쪽이 바뀌고 타이틀바는 그대로.
  await page.click(`${sw} [data-space="ai"]`)
  await expect(page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.ai-rail')).toBeVisible()
  // M2 라운드 2: 워크트리 목록이 들어왔다 — 레일의 [워크트리]는 지금 화면(눌림). M3 R3a 에서 [에이전트]·[대시보드]가 살아났고
  // M6 R2 에서 [검색]이 살아났고 [자동화]는 아직 비활성.
  await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="worktree"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="search"]')).toBeEnabled()
  await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="automations"]')).toBeDisabled()
  await expect(page.locator('.lrail')).toHaveCount(0)
  await expect(page.locator('.aiws-home .aiws-side')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('.term-tabbar')).toBeHidden()
  await expect(page.locator('.statusbar .sb-seg.host')).toHaveCount(0)
  await expect(page.locator('.statusbar .sb-right')).toBeVisible()
  await expect(page.locator('.titlebar .tb-burger')).toBeVisible()

  // 단축키로 되돌리기(Ctrl+Alt+1) · 다시 가기(Ctrl+Alt+2).
  await page.keyboard.press('Control+Alt+1')
  await expect(page.locator('.lrail')).toBeVisible()
  await expect(page.locator('.term-tabbar')).toBeVisible()
  await expect(page.locator('.aiws-home')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.ai-rail')).toBeVisible()

  // 설정은 AI 작업 공간에서도 열린다(덮개가 .main 안에 산다).
  await page.click('.ai-rail .ai-rail-item[data-aiws="settings"]')
  await expect(page.locator(drawer)).toBeVisible()
  await page.keyboard.press('Escape')

  await persist(page)
  await quitAra(a1)

  // 재시작 — 마지막 공간(AI 작업)이 그대로.
  const a2 = await launch(userDataDir)
  await expect(a2.page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(a2.page.locator('.ai-rail')).toBeVisible()

  // ≡ [보기] 에 "공간:" 두 줄 — 고르면 같은 길(단축키)로 간다.
  await a2.page.click('.titlebar .tb-burger')
  await a2.page.click('.tb-menu span:text-is("보기")')
  await a2.page.click('.ctx-menu .ctx-item[data-action="space.term"]')
  await expect(a2.page.locator('.lrail')).toBeVisible()
})

test('SPACE-3 오른쪽 아이콘 바 — 아라를 열고 접는다, 타이틀바 [채팅]과 같은 상태', async ({ ara }) => {
  const { page } = ara
  const chat = page.locator('.rbar .rbar-item[data-rbar="chat"]')
  // 터미널 공간은 아라만.
  await expect(page.locator('.rbar .rbar-item')).toHaveCount(1)
  await chat.click()
  await expect(page.locator('.ara-panel')).toBeVisible()
  await expect(chat).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-rbar="chat"]')).toHaveAttribute('aria-pressed', 'true')
  await chat.click()
  await expect(page.locator('.ara-panel')).toHaveCount(0)
  await expect(page.locator('[data-rbar="chat"]')).toHaveAttribute('aria-pressed', 'false')
  // 타이틀바 [채팅]으로 열면 바도 눌린다(한 상태).
  await page.click('[data-rbar="chat"]')
  await expect(chat).toHaveAttribute('aria-pressed', 'true')
  await page.click('[data-rbar="chat"]')

  // AI 작업 공간 — 아래에 탐색기(M6: 파일 열기 — 살아 있음)·소스 제어·검사 자리(비활성).
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.rbar .rbar-item')).toHaveCount(5)
  await expect(page.locator('.rbar .rbar-item[data-rbar="explorer"]')).toBeEnabled()
  // [소스 제어]는 M7 에서 살아났다 — [검사]만 아직 자리.
  await expect(page.locator('.rbar .rbar-item[data-rbar="scm"]')).toBeEnabled()
  await expect(page.locator('.rbar .rbar-item[data-rbar="checks"]')).toBeDisabled()
})
