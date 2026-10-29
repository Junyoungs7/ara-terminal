// W5 아라 멀티 프로바이더 — 설정 [AI] 섹션의 provider 세그먼트 · 전환 확인 다이얼로그 ·
// 프로바이더별 분리 키 · compatible baseUrl 검증(★ 보안: https 전용, loopback http 만 예외) ·
// 모델 추천 칩 · 패널 헤더 표시 · 재기동 후 영속.
//
// openAiSettings/registerAiKey/lastAnswer 는 ai.spec.ts 와 동일 패턴을 이 파일에 로컬로 복제한다
// (fixtures.ts 는 다른 에이전트가 동시 편집 중이라 건드리지 않는다).
import type { Page } from '@playwright/test'
import { test, expect, dialog, dialogConfirm, persist, quitAra } from './fixtures'

const drawer = '.drawer.open'

async function openAiSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="ai"]`)
}

async function registerAiKey(page: Page, key = 'sk-ant-fake-0001'): Promise<void> {
  await openAiSettings(page)
  await page.fill(`${drawer} input[data-field="ai.key"]`, key)
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-key-badge.ok`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(drawer)).toHaveCount(0)
}

async function openAiPanel(page: Page): Promise<void> {
  await page.keyboard.press('Alt+a')
  await expect(page.locator('.ai-panel')).toBeVisible()
}

// 앱 상태(main 소유)에 직접 턴을 하나 만든다 — AraSession.send() 는 키 유무와 무관하게 사용자+assistant
// 턴을 즉시 push 하므로(키가 없으면 곧바로 noKey 로 종료될 뿐) turnCount>0 을 만드는 데 실제 UI 클릭이나
// 키 등록이 필요 없다(ponytail — switchProvider 의 확인 게이트는 turnCount 만 본다).
async function makeTurn(page: Page): Promise<void> {
  await page.evaluate(() => window.ev.ai.send({ text: '질문' }))
}

function providerBtn(page: Page, v: string) {
  return page.locator(`${drawer} .set-row:has(.sr-label:text-is("프로바이더")) .seg-ctl button[data-value="${v}"]`)
}

async function dialogCancel(page: Page): Promise<void> {
  await dialog(page).locator('.modal-ft .btn.sec').click()
}

// W5-1 프로바이더 세그먼트 4개, 기본 선택은 anthropic.
test('W5-1 provider 세그먼트가 4개 노출되고 기본값은 anthropic 이다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await expect(page.locator(`${drawer} .set-row:has(.sr-label:text-is("프로바이더")) .seg-ctl button`)).toHaveCount(4)
  await expect(providerBtn(page, 'anthropic')).toHaveClass(/on/)
})

// W5-2~4 대화가 있으면 전환 시 확인 다이얼로그가 뜨고, 취소하면 그대로, 확인하면 전환+대화 초기화.
test('W5-2~4 대화가 있는 상태의 프로바이더 전환은 확인 다이얼로그를 거친다', async ({ ara }) => {
  const { page } = ara
  await makeTurn(page)
  await openAiSettings(page)

  await providerBtn(page, 'openai').click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toContainText('Anthropic Claude')
  await expect(dialog(page)).toContainText('OpenAI')

  // W5-3: 취소 — provider·대화 그대로.
  await dialogCancel(page)
  await expect(dialog(page)).toHaveCount(0)
  await expect(providerBtn(page, 'anthropic')).toHaveClass(/on/)
  expect((await page.evaluate(() => window.ev.ai.getState())).turns.length).toBeGreaterThan(0)

  // W5-4: 다시 시도해 확인 — 전환되고 대화가 비워진다.
  await providerBtn(page, 'openai').click()
  await expect(dialog(page)).toBeVisible()
  await dialogConfirm(page)
  await expect(dialog(page)).toHaveCount(0)
  await expect(providerBtn(page, 'openai')).toHaveClass(/on/)
  await expect.poll(async () => (await page.evaluate(() => window.ev.ai.getState())).turns.length).toBe(0)
})

// W5-5 대화가 없으면(turnCount===0) 확인 없이 즉시 전환된다.
test('W5-5 대화가 없으면 프로바이더 전환에 확인 다이얼로그가 뜨지 않는다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await providerBtn(page, 'google').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(providerBtn(page, 'google')).toHaveClass(/on/)
})

// W5-6~7 키는 프로바이더별로 분리 저장된다 — 다른 프로바이더로 갔다 와도 원래 키는 남아 있다.
test('W5-6~7 프로바이더별로 키가 분리 저장된다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await page.fill(`${drawer} input[data-field="ai.key"]`, 'sk-ant-fake-A')
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-key-badge.ok`)).toBeVisible()
  await expect(page.locator(`${drawer} .ai-key-state`)).toHaveAttribute('data-state', 'has')

  // 대화가 없으니(turnCount 0) 다이얼로그 없이 즉시 전환.
  await providerBtn(page, 'openai').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(`${drawer} .ai-key-state`)).toHaveAttribute('data-state', 'none')
  await expect(page.locator(`${drawer} input[data-field="ai.key"]`)).toHaveValue('')

  await page.fill(`${drawer} input[data-field="ai.key"]`, 'sk-oai-fake-B')
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-key-badge.ok`)).toBeVisible()

  await providerBtn(page, 'anthropic').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(`${drawer} .ai-key-state`)).toHaveAttribute('data-state', 'has')
})

// W5-8 baseUrl 입력은 compatible 에서만 보인다.
test('W5-8 baseUrl 입력은 compatible 프로바이더에서만 보인다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await expect(page.locator(`${drawer} input[data-field="ai.baseUrl"]`)).toHaveCount(0)
  await providerBtn(page, 'compatible').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator(`${drawer} input[data-field="ai.baseUrl"]`)).toBeVisible()
  await providerBtn(page, 'anthropic').click()
  await expect(page.locator(`${drawer} input[data-field="ai.baseUrl"]`)).toHaveCount(0)
})

// W5-9~10 baseUrl 미설정/설정 상태가 반출 고지(.set-note[data-note="ai.export"])에 그대로 반영된다.
test('W5-9~10 baseUrl 미설정·설정 상태가 반출 고지 문구에 반영된다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await providerBtn(page, 'compatible').click()
  await expect(page.locator(`${drawer} .set-note[data-note="ai.export"]`)).toContainText('설정된 주소 없음')

  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'https://openrouter.ai/api/v1')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toHaveCount(0)
  await expect(page.locator(`${drawer} .set-note[data-note="ai.export"]`)).toContainText('openrouter.ai')
})

// W5-11 ★ 비loopback http baseUrl 은 에러로 막힌다(https 전용 — validateBaseUrl).
test('W5-11 ★ 바깥 평문 http baseUrl 은 에러 표시가 뜨고 사라지지 않는다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await providerBtn(page, 'compatible').click()
  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'http://example.com')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toBeVisible()

  // 이 상태로 키를 저장해도(ARA_AI_FAKE 라 키 저장 자체는 성공한다) baseUrl 에러 표시는 그대로 남는다 —
  // 즉석 검증 피드백이 다른 동작으로 조용히 사라지지 않는다는 것만 확인한다(실 전송 차단은 main 쪽
  // validateBaseUrl 재검증이 방어선 — 이 화면 테스트 범위 밖).
  await page.fill(`${drawer} input[data-field="ai.key"]`, 'sk-test')
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toBeVisible()
})

// W5-12 loopback http baseUrl 은 예외로 허용된다(로컬 LLM — Ollama/vLLM).
test('W5-12 loopback http baseUrl 은 에러 없이 허용된다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await providerBtn(page, 'compatible').click()
  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'http://127.0.0.1:11434/v1')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toHaveCount(0)
  await expect(page.locator(`${drawer} .set-note[data-note="ai.export"]`)).toContainText('127.0.0.1')
})

// W5-12b★ 사내 vLLM(사설망 평문) — D-3 결정(2026-08-16 준영님: "사내에서는 사내 서버의 vLLM 에
// 연결하여 사용할 수 있는 구조"). 그전에는 이 주소가 **저장 자체가 안 됐다**(loopback 만 예외였다).
// 반출 고지 문구가 그 호스트를 그대로 비추는지까지 본다 — 어디로 나가는지 사용자가 봐야 한다.
test('W5-12b★ 사내 사설망 http baseUrl 이 허용되고 반출 고지에 호스트가 뜬다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  await providerBtn(page, 'compatible').click()
  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'http://192.168.0.10:8000/v1')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toHaveCount(0)
  await expect(page.locator(`${drawer} .set-note[data-note="ai.export"]`)).toContainText('192.168.0.10')

  // 점 없는 사내 호스트명도 같은 이유로 허용된다(공개 DNS 는 TLD 를 요구한다).
  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'http://ai-server:8000/v1')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toHaveCount(0)

  // 사설망 '옆' 대역은 공인이다 — 넓힌 범위가 새지 않는지 화면에서도 확인한다.
  await page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'http://11.0.0.1:8000/v1')
  await expect(page.locator(`${drawer} .ai-baseurl-err`)).toBeVisible()
})

// W5-13 모델 추천 칩을 누르면 입력값이 채워지고 그 칩이 선택 표시된다.
// 추천 목록은 6564c8b(2026-10-20)부터 현재 모델 — claude-opus-5 → claude-opus-5-5(types.ts AI_MODELS_BY_PROVIDER).
test('W5-13 모델 추천 칩을 누르면 입력값이 채워지고 칩이 선택 표시된다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  const modelRow = `${drawer} .set-row:has(.sr-label:text-is("모델"))`
  await page.click(`${modelRow} .seg-ctl button[data-value="claude-opus-5-5"]`)
  await expect(page.locator(`${modelRow} input[data-field="ai.model"]`)).toHaveValue('claude-opus-5-5')
  await expect(page.locator(`${modelRow} .seg-ctl button[data-value="claude-opus-5-5"]`)).toHaveClass(/on/)
})

/**
 * W5-15 는 **옛 화면 것이다**(2026-08-26 확인).
 *
 * `.ai-panel`(AiPanel) 은 `ARA_CHAT` 플래그가 켜진 뒤로 화면에 안 붙는다 — 같은 레일 자리를
 * `AraChatPanel` 이 쓴다(Shell.tsx 의 `ARA_CHAT ? … : …`). 그래서 이 검사는 열리지 않는 패널을
 * 기다리다 실패했다. **제품이 아니라 검사가 낡은 것**이다.
 *
 * 지키려던 성질("지금 어느 모델인지 헤더에서 보인다")은 지금 화면에서 ARA2-7(모델 고르기)이
 * 이미 지킨다. 플래그를 되돌릴 일이 없다고 볼 수 없어 지우지는 않고 건너뛴다 — 옛 패널을 정말
 * 걷어내는 날 이 줄이 함께 지워진다.
 */
test.skip('W5-15 아라 패널 헤더에 현재 provider·model 이 표시된다(옛 AiPanel — ARA_CHAT 이후 미사용)', async ({ ara }) => {
  const { page } = ara
  await registerAiKey(page)
  await openAiPanel(page)
  await expect(page.locator('.ai-panel .ai-active-badge')).toContainText('Anthropic Claude')
})

// W5-17 provider·baseUrl 설정이 재기동 후에도 유지된다(SET-8 과 같은 재기동 패턴).
test('W5-17 provider·baseUrl 설정이 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await openAiSettings(a1.page)
  await providerBtn(a1.page, 'compatible').click()
  await a1.page.fill(`${drawer} input[data-field="ai.baseUrl"]`, 'https://openrouter.ai/api/v1')
  await a1.page.keyboard.press('Escape')
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await openAiSettings(a2.page)
  await expect(providerBtn(a2.page, 'compatible')).toHaveClass(/on/)
  await expect(a2.page.locator(`${drawer} input[data-field="ai.baseUrl"]`)).toHaveValue('https://openrouter.ai/api/v1')
})
