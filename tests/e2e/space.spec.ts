// M1 라운드 2 — 상단 공간 전환 [터미널 | AI 작업] + 오른쪽 아이콘 바(시안 SW-final).
// 실험 기능(설정 › 고급 › 실험 기능)을 켰을 때만 스위치가 보인다. 꺼진 기본 상태는 지금과 똑같은 화면이어야 한다.
import { test, expect, persist, quitAra } from './fixtures'

const drawer = '.settings-page.open'
const sw = '.titlebar .tb-spaces'

async function setAiSpace(page: import('@playwright/test').Page, on: boolean): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="experimental"]`)
  const toggle = page.locator(`${drawer} .set-row[data-item="exp.aiSpace"] .set-toggle`)
  await toggle.click()
  if (on) await expect(toggle).toHaveClass(/\bon\b/)
  else await expect(toggle).not.toHaveClass(/\bon\b/)
  await page.keyboard.press('Escape')
}

test('SPACE-1 꺼진 기본 상태 — 스위치·오른쪽 아이콘 바·메뉴의 "공간:" 이 없다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator(sw)).toHaveCount(0)
  await expect(page.locator('.rbar')).toHaveCount(0)
  // 공간 키도 먹지 않는다 — 터미널 레일 그대로.
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.ai-rail')).toHaveCount(0)
  await expect(page.locator('.lrail')).toBeVisible()
  await page.click('.titlebar .tb-burger')
  await page.click('.tb-menu span:text-is("보기")')
  await expect(page.locator('.ctx-menu .ctx-item[data-action="space.ai"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('SPACE-2★ 실험 기능 켜기 → 스위치 → AI 작업 공간 전환·되돌리기 → 재시작 유지', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  const page = a1.page
  await setAiSpace(page, true)
  await expect(page.locator(sw)).toBeVisible()
  await expect(page.locator(`${sw} [data-space="term"]`)).toHaveAttribute('aria-selected', 'true')

  // 스위치 클릭 → AI 작업 공간: 왼쪽 레일·가운데·상태바 왼쪽이 바뀌고 타이틀바는 그대로.
  await page.click(`${sw} [data-space="ai"]`)
  await expect(page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.ai-rail')).toBeVisible()
  // M2 라운드 2: 워크트리 목록이 들어왔다 — 레일의 [워크트리]는 지금 화면(눌림), 나머지는 아직 비활성.
  await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="worktree"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="agents"]')).toBeDisabled()
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

  // 재시작 — 실험 기능과 마지막 공간(AI 작업)이 그대로.
  const a2 = await launch(userDataDir)
  await expect(a2.page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(a2.page.locator('.ai-rail')).toBeVisible()

  // ≡ [보기] 에 "공간:" 두 줄 — 고르면 같은 길(단축키)로 간다.
  await a2.page.click('.titlebar .tb-burger')
  await a2.page.click('.tb-menu span:text-is("보기")')
  await a2.page.click('.ctx-menu .ctx-item[data-action="space.term"]')
  await expect(a2.page.locator('.lrail')).toBeVisible()

  // 실험 기능을 끄면 저장값과 무관하게 터미널 공간 + 스위치 없음.
  await a2.page.keyboard.press('Control+Alt+2')
  await expect(a2.page.locator('.ai-rail')).toBeVisible()
  await setAiSpace(a2.page, false)
  await expect(a2.page.locator(sw)).toHaveCount(0)
  await expect(a2.page.locator('.ai-rail')).toHaveCount(0)
  await expect(a2.page.locator('.lrail')).toBeVisible()
})

test('SPACE-3 오른쪽 아이콘 바 — 아라를 열고 접는다, 타이틀바 [채팅]과 같은 상태', async ({ ara }) => {
  const { page } = ara
  await setAiSpace(page, true)
  const chat = page.locator('.rbar .rbar-item[data-rbar="chat"]')
  // 터미널 공간은 아라만.
  await expect(page.locator('.rbar .rbar-item')).toHaveCount(1)
  await chat.click()
  await expect(page.locator('.ara-panel')).toBeVisible()
  await expect(chat).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.tb-chat')).toHaveAttribute('aria-pressed', 'true')
  await chat.click()
  await expect(page.locator('.ara-panel')).toHaveCount(0)
  await expect(page.locator('.tb-chat')).toHaveAttribute('aria-pressed', 'false')
  // 타이틀바 [채팅]으로 열면 바도 눌린다(한 상태).
  await page.click('.tb-chat')
  await expect(chat).toHaveAttribute('aria-pressed', 'true')
  await page.click('.tb-chat')

  // AI 작업 공간 — 아래에 탐색기·소스 제어·검사 자리(비활성).
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.rbar .rbar-item')).toHaveCount(4)
  for (const id of ['explorer', 'scm', 'checks']) await expect(page.locator(`.rbar .rbar-item[data-rbar="${id}"]`)).toBeDisabled()
})
