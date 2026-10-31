// F17 AI 부트스트랩 GUI(components/AiBootstrapModal.tsx) E2E — 열기 두 경로 · 키 없음 안내 ·
// SSH 대상 게이트 · 제출(아라 채팅으로 가는 전송 경로)까지 코드화한다.
import type { Page } from '@playwright/test'
import { test, expect, newLocalShell } from './fixtures'

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

/**
 * 모달 자체를 보는 검사(BOOT-3~5)는 **살아 있는 진입점**으로 연다 — ≡ › 파일 › [프로젝트 부트스트랩…](BOOT-2).
 *
 * 옛 대화 패널(`.ai-panel`)은 #125(2026-08-25) 뒤로 화면에 붙지 않았고 M0 0-10 에서 지웠다 — 같은 레일 자리를
 * AraChatPanel 이 쓰고, 거기엔 부트스트랩 버튼이 없다. 이 검사들이 지키던 것(키 없음 안내·대상 게이트·제출)은 모달의
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
// #125 부터 제출은 AraChatPanel 로 간다(Shell onSubmit → openRail('ai') + prefill autoSend).
// 아라 채팅의 내 말(.ara-me)·답(.ara-ai)으로 본다.
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
