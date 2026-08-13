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
  // FB-ui2: 아라 진입점이 타이틀바(.tb-ai, 제거됨)에서 우측 액티비티 바로 이관됐다.
  await page.click('.act-item[data-activity="ai"]')
  await expect(page.locator('.ai-panel')).toBeVisible()
  await page.click('.ai-panel [data-action="ai.bootstrap.open"]')
  await expect(page.locator(modal)).toBeVisible()
}

// 라벨 텍스트로 부트스트랩 폼 입력칸을 찾는다(입력에 id/data-field 가 없다 — 라벨이 유일한 안정 앵커,
// fixtures.ts 의 연결 프로필 field() 헬퍼와 같은 패턴).
function bootstrapField(page: Page, label: string) {
  return page.locator(`${modal} .set-row:has(.sr-label:text-is("${label}")) input`)
}

// main 이 쥔 대화 상태의 마지막 user 턴 텍스트(ai.spec.ts 의 lastAnswer 와 같은 판단 — DOM 이 아니라
// 진짜 소유자를 읽는다).
async function lastUserTurn(page: Page): Promise<string> {
  const s = await page.evaluate(() => window.ev.ai.getState())
  const turns = s.turns.filter((t) => t.role === 'user')
  return turns[turns.length - 1]?.text ?? ''
}

// BOOT-1 진입점 ① — AI 패널 상단 버튼
test('BOOT-1 AI 패널 상단 버튼으로 부트스트랩 모달이 열린다', async ({ ara }) => {
  const { page } = ara
  await openBootstrapViaPanel(page)
})

// BOOT-2 진입점 ② — File 메뉴(패널이 마운트돼 있지 않아도 동작해야 한다)
test('BOOT-2 File 메뉴의 [프로젝트 부트스트랩…] 항목으로도 열린다(패널 마운트 불필요)', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.ai-panel')).toHaveCount(0)
  await page.click('.titlebar .tb-menu span:text-is("File")')
  await page.click('.ctx-menu .ctx-item[data-action="ai.bootstrap"]')
  await expect(page.locator(modal)).toBeVisible()
})

// BOOT-3 키가 없으면 안내 카드만 보이고 폼 필드는 없다
test('BOOT-3 키를 등록하지 않으면 안내 카드만 보이고 폼 필드가 없다', async ({ ara }) => {
  const { page } = ara
  await openBootstrapViaPanel(page)
  await expect(page.locator(`${modal} .ai-card`)).toContainText('아라를 쓰려면 API 키가 필요합니다')
  await expect(page.locator(`${modal} .seg-ctl`)).toHaveCount(0)
  await expect(page.locator(`${modal} input`)).toHaveCount(0)
})

// BOOT-4 키 등록 + 로컬 세션만 있으면 대상의 SSH 버튼이 비활성, 기본은 로컬
test('BOOT-4 로컬 세션만 있으면 대상의 SSH 버튼이 비활성이고 기본은 로컬이다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openBootstrapViaPanel(page)
  const target = page.locator(`${modal} .set-row:has(.sr-label:text-is("대상")) .seg-ctl button`)
  await expect(target.filter({ hasText: '로컬' })).toHaveClass(/on/)
  await expect(target.filter({ hasText: '현재 SSH 세션' })).toBeDisabled()
})

// BOOT-5 폼을 채워 제출 → AI 패널이 열리고 사용자 턴에 입력값이 반영되며, 이어 assistant 턴에
// 코드블록 응답이 순서대로 렌더된다.
test('BOOT-5 폼 제출 → AI 패널이 열리고 입력값이 반영된 사용자 턴 뒤에 코드블록 응답이 온다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openBootstrapViaPanel(page)

  await page.click(`${modal} .set-row:has(.sr-label:text-is("종류")) .seg-ctl button:text-is("CLI 도구")`)
  await bootstrapField(page, '언어/런타임').fill('Node.js')
  await bootstrapField(page, '프로젝트 이름').fill('my-cli-app')
  await bootstrapField(page, '경로').fill('/home/dev/my-cli-app')
  await page.click(`${modal} [data-action="ai.bootstrap.submit"]`)

  await expect(page.locator(modal)).toHaveCount(0)
  await expect(page.locator('.ai-panel')).toBeVisible()

  await expect.poll(() => lastUserTurn(page)).toContain('CLI 도구')
  const prompt = await lastUserTurn(page)
  expect(prompt).toContain('Node.js')
  expect(prompt).toContain('my-cli-app')
  expect(prompt).toContain('/home/dev/my-cli-app')

  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ai-turn.ara .ai-code').first()).toBeVisible()
})

// BOOT-6 ★ 응답 코드블록의 [터미널로 보내기]는 삽입만 하고 실행하지 않는다(AI-5·CB-6 와 같은 판정)
test('BOOT-6 ★ 응답 코드블록의 [터미널로 보내기]는 삽입만 하고 실행하지 않는다', async ({ ara }) => {
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
