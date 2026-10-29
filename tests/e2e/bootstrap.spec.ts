// F17 AI 부트스트랩 GUI(components/AiBootstrapModal.tsx) E2E — 열기 두 경로 · 키 없음 안내 ·
// SSH 대상 게이트 · 제출(AiPanel 재사용 전송 경로) · 응답 코드블록의 [터미널로 보내기](AI-5·CB-6 와
// 같은 삽입-only 판정)까지 코드화한다.
import type { Page } from '@playwright/test'
import { test, expect, newLocalShell, termText } from './fixtures'

const drawer = '.drawer.open'
const modal = '.overlay.open .ai-bootstrap'

async function openAiSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="ai"]`)
}

// 설정 [AI] 에서 fake 키를 등록한다(ARA_AI_FAKE 라 실 검증 없이 즉시 ok) — ai.spec.ts 와 같은 헬퍼를
// 이 스펙 파일 안에 로컬로 다시 둔다(공유 fixtures.ts 를 건드리지 않는다).
async function registerAiKey(page: Page, key = 'sk-ant-fake-0001'): Promise<void> {
  await openAiSettings(page)
  await page.fill(`${drawer} input[data-field="ai.key"]`, key)
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-key-badge.ok`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(drawer)).toHaveCount(0)
}

async function openBootstrapViaPanel(page: Page): Promise<void> {
  // 2.0: 우측 액티비티 바가 없어지며 채팅 진입점은 타이틀바 [채팅](.tb-chat) 하나다.
  await page.click('.tb-chat')
  await expect(page.locator('.ai-panel')).toBeVisible()
  await page.click('.ai-panel [data-action="ai.bootstrap.open"]')
  await expect(page.locator(modal)).toBeVisible()
}

/**
 * 모달 자체를 보는 검사(BOOT-3~5)는 **살아 있는 진입점**으로 연다 — ≡ › 파일 › [프로젝트 부트스트랩…](BOOT-2).
 *
 * `.ai-panel`(옛 AiPanel)은 #125(2026-08-25) `ARA_CHAT = true` 뒤로 화면에 붙지 않는다 — 같은 레일 자리를
 * AraChatPanel 이 쓰고, 거기엔 부트스트랩 버튼이 없다(W5-15 와 같은 사정). 그래서 패널 버튼 경로는
 * 열리지 않는 패널을 기다리다 실패했다. 이 검사들이 지키던 것(키 없음 안내·대상 게이트·제출)은 모달의
 * 성질이라 여는 길과 무관하다.
 */
async function openBootstrapViaMenu(page: Page): Promise<void> {
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
  await page.click('.titlebar .tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="ai.bootstrap"]')
  await expect(page.locator(modal)).toBeVisible()
}

// 라벨 텍스트로 부트스트랩 폼 입력칸을 찾는다(입력에 id/data-field 가 없다 — 라벨이 유일한 안정 앵커,
// fixtures.ts 의 연결 프로필 field() 헬퍼와 같은 패턴).
function bootstrapField(page: Page, label: string) {
  return page.locator(`${modal} .set-row:has(.sr-label:text-is("${label}")) input`)
}

// BOOT-1 진입점 ① — AI 패널 상단 버튼. **옛 화면 것이다**: 그 버튼은 옛 AiPanel 에만 있고 #125 뒤로 AiPanel 은
// 마운트되지 않는다(openBootstrapViaMenu 주석). 지우지 않고 건너뛴다 — W5-15 처럼 옛 패널을 걷어내는 날 함께 지운다.
// 지금의 진입점은 메뉴(BOOT-2)·통합 검색이다.
test.skip('BOOT-1 AI 패널 상단 버튼으로 부트스트랩 모달이 열린다(옛 AiPanel — ARA_CHAT 이후 미사용)', async ({ ara }) => {
  const { page } = ara
  await openBootstrapViaPanel(page)
})

// BOOT-2 진입점 ② — File 메뉴(패널이 마운트돼 있지 않아도 동작해야 한다)
test('BOOT-2 File 메뉴의 [프로젝트 부트스트랩…] 항목으로도 열린다(패널 마운트 불필요)', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.ai-panel')).toHaveCount(0)
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
  await page.click('.titlebar .tb-menu span:text-is("파일")')
  await page.click('.ctx-menu .ctx-item[data-action="ai.bootstrap"]')
  await expect(page.locator(modal)).toBeVisible()
})

// BOOT-3 키가 없으면 안내 카드만 보이고 폼 필드는 없다
test('BOOT-3 키를 등록하지 않으면 안내 카드만 보이고 폼 필드가 없다', async ({ ara }) => {
  const { page } = ara
  await openBootstrapViaMenu(page)
  await expect(page.locator(`${modal} .ai-card`)).toContainText('아라를 쓰려면 API 키가 필요합니다')
  await expect(page.locator(`${modal} .seg-ctl`)).toHaveCount(0)
  await expect(page.locator(`${modal} input`)).toHaveCount(0)
})

// BOOT-4 키 등록 + 로컬 세션만 있으면 대상의 SSH 버튼이 비활성, 기본은 로컬
test('BOOT-4 로컬 세션만 있으면 대상의 SSH 버튼이 비활성이고 기본은 로컬이다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openBootstrapViaMenu(page)
  const target = page.locator(`${modal} .set-row:has(.sr-label:text-is("대상")) .seg-ctl button`)
  await expect(target.filter({ hasText: '로컬' })).toHaveClass(/on/)
  await expect(target.filter({ hasText: '현재 SSH 세션' })).toBeDisabled()
})

// BOOT-5 폼을 채워 제출 → 아라 채팅이 열리고 입력값이 반영된 내 말이 가며, 이어 아라의 답이 온다.
// #125 부터 제출은 AraChatPanel 로 간다(Shell onSubmit → openRail('ai') + prefill autoSend). 옛 AiPanel 의
// 대화 상태(ev.ai.getState)·코드블록 렌더는 그 화면 것이라 아라 채팅의 내 말(.ara-me)·답(.ara-ai)으로 본다.
test('BOOT-5 폼 제출 → 아라 채팅이 열리고 입력값이 반영된 내 말 뒤에 답이 온다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openBootstrapViaMenu(page)

  await page.click(`${modal} .set-row:has(.sr-label:text-is("종류")) .seg-ctl button:text-is("CLI 도구")`)
  await bootstrapField(page, '언어/런타임').fill('Node.js')
  await bootstrapField(page, '프로젝트 이름').fill('my-cli-app')
  await bootstrapField(page, '경로').fill('/home/dev/my-cli-app')
  await page.click(`${modal} [data-action="ai.bootstrap.submit"]`)

  await expect(page.locator(modal)).toHaveCount(0)
  const panel = page.locator('.ara-panel')
  await expect(panel).toBeVisible()

  const mine = panel.locator('.ara-me').last()
  await expect(mine).toContainText('CLI 도구', { timeout: 30_000 })
  await expect(mine).toContainText('Node.js')
  await expect(mine).toContainText('my-cli-app')
  await expect(mine).toContainText('/home/dev/my-cli-app')
  // 가짜 엔진(ARA_AI_FAKE)은 받은 말을 그대로 돌려준다 — 보낸 그 말이 실제로 엔진까지 갔다.
  await expect(panel.locator('.ara-ai').last()).toContainText('my-cli-app', { timeout: 30_000 })
})

// BOOT-6 ★ 응답 코드블록의 [터미널로 보내기]는 삽입만 하고 실행하지 않는다(AI-5·CB-6 와 같은 판정)
// **옛 화면 것이다**: 코드블록 [터미널로 보내기](.ai-code [data-action="ai.insert"])는 옛 AiPanel 에만 있고,
// #125 뒤로 제출은 AraChatPanel 로 간다(BOOT-5) — 아라 채팅엔 그 버튼이 없다. W5-15 처럼 건너뛴다.
test.skip('BOOT-6 ★ 응답 코드블록의 [터미널로 보내기]는 삽입만 하고 실행하지 않는다(옛 AiPanel — ARA_CHAT 이후 미사용)', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await registerAiKey(page)
  await openBootstrapViaPanel(page)

  await bootstrapField(page, '언어/런타임').fill('Python')
  await bootstrapField(page, '프로젝트 이름').fill('my-script')
  await page.click(`${modal} [data-action="ai.bootstrap.submit"]`)
  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible({ timeout: 10_000 })

  const insert = page.locator('.ai-turn.ara .ai-code [data-action="ai.insert"]').last()
  await expect(insert).toBeVisible()
  await insert.click()
  await expect.poll(() => termText(page, id)).toContain('du -sh /var/log')
  const afterInsert = await termText(page, id)

  // 개행이 갔다면 이 사이에 셸이 실행 결과(또는 오류)를 찍었을 시간이다.
  await page.waitForTimeout(1_500)
  expect(await termText(page, id)).toBe(afterInsert) // 늘지 않았다 = 실행되지 않고 프롬프트에 남았다
})
