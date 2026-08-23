// W3 F16 아라(내장 AI 어시스턴트) — 설계 §7 AI-1~AI-11 중 UI 배선을 Playwright 로 코드화한다.
// 단위(tests/ai.test.ts, 24개)가 마스킹 강제·키 센티널·델타 누적·취소·splitBlocks·insertText 를
// 네트워크 없이 이미 검증한다 — 여기서는 그 위의 실제 화면 배선만 본다.
//
// ARA_AI_FAKE=1 로 앱을 띄운다(fixtures.ts launchAra) — AraSession 이 실 Anthropic SDK 대신
// 결정적인 캔드 스트림(FAKE_ANSWER, ~150자 · 100ms 간격 7청크)을 쓴다. 실키·실과금·네트워크가 없다.
// AraSession 은 렌더러가 아니라 main 이 소유하므로(설계 §5), 델타 순서·부분 취소 판정은
// window.ev.ai.getState() 로 main 상태를 직접 읽는다(DOM 문자열 파싱보다 강한 증거).
import { AI_CHAT } from '../../src/shared/features'
import type { Page } from '@playwright/test'
import { test, expect, newLocalShell, runCommand, expectTermText, termText, focusTerminal } from './fixtures'

const drawer = '.drawer.open'

async function openAiSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="ai"]`)
}

// 설정 [AI] 에서 fake 키를 등록한다(ARA_AI_FAKE 라 실 검증 없이 즉시 ok).
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

// main 이 쥔 대화 상태에서 마지막 assistant 턴 텍스트(DOM 이 아니라 진짜 소유자를 읽는다).
async function lastAnswer(page: Page): Promise<string> {
  const s = await page.evaluate(() => window.ev.ai.getState())
  const answers = s.turns.filter((t) => t.role === 'assistant')
  return answers[answers.length - 1]?.text ?? ''
}

// AI-1 키 없음 상태로 패널을 열면 안내 카드와 비활성 입력만 보인다
/**
 * 2026-08-23: **아라 대화는 0.1.0 에서 숨겼다**(src/shared/features.ts 의 AI_CHAT).
 * 기능은 코드에 그대로 살아 있으므로 이 파일도 지우지 않는다 — 상수를 되돌리면 그날로 다시 돈다.
 * 지금은 진입점(레일·단축키·메뉴)이 없어 첫 줄부터 실패하므로 스스로 건너뛴다.
 */
test.beforeEach(() => {
  test.skip(!AI_CHAT, '아라 대화 숨김 — src/shared/features.ts 의 AI_CHAT 을 켜면 다시 돈다')
})

test('AI-1 키 없음 상태로 패널을 열면 안내 카드와 비활성 입력만 보인다', async ({ ara }) => {
  const { page } = ara
  // FB-ui2: 아라 진입점이 타이틀바(.tb-ai, 제거됨)에서 우측 액티비티 바로 이관됐다.
  await page.click('.act-item[data-activity="ai"]')
  await expect(page.locator('.ai-panel')).toBeVisible()
  await expect(page.locator('.ai-panel .ai-card')).toContainText('아라를 쓰려면 API 키가 필요합니다')
  await expect(page.locator('.ai-panel .ai-input')).toBeDisabled()
  await expect(page.locator('.ai-panel .ai-card [data-action="ai.openSettings"]')).toBeVisible()
})

// AI-2 설정에서 키를 저장하면(fake 검증 통과) 배지가 뜨고 입력칸이 즉시 비워진다
test('AI-2 설정에서 키를 저장하면(fake 검증 통과) 배지가 뜨고 입력칸이 즉시 비워진다', async ({ ara }) => {
  const { page } = ara
  await openAiSettings(page)
  const input = page.locator(`${drawer} input[data-field="ai.key"]`)
  await input.fill('sk-ant-fake-0001')
  await page.click(`${drawer} [data-action="ai.key.save"]`)
  await expect(page.locator(`${drawer} .ai-key-badge.ok`)).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(page.locator(`${drawer} .ai-key-state`)).toHaveAttribute('data-state', 'has')

  // 드로어를 다시 열어도 입력칸은 비어 있다(저장된 키를 되읽어 보여 주지 않는다 — 설계 §2).
  await page.keyboard.press('Escape')
  await openAiSettings(page)
  await expect(page.locator(`${drawer} input[data-field="ai.key"]`)).toHaveValue('')

  // 패널 쪽에도 반영된다 — 키가 있으니 안내 카드 없이 입력이 즉시 활성.
  await page.keyboard.press('Escape')
  await openAiPanel(page)
  await expect(page.locator('.ai-panel .ai-card')).toHaveCount(0)
  await expect(page.locator('.ai-panel .ai-input')).toBeEnabled()
})

// SET-AI-3 키를 삭제하면 저장 상태가 none 으로 바뀐다
test('SET-AI-3 키를 삭제하면 저장 상태가 none 으로 바뀐다', async ({ ara }) => {
  const { page } = ara
  await registerAiKey(page)
  await openAiSettings(page)
  await page.click(`${drawer} [data-action="ai.key.delete"]`)
  await expect(page.locator(`${drawer} .ai-key-state`)).toHaveAttribute('data-state', 'none')
  await expect(page.locator(`${drawer} [data-action="ai.key.delete"]`)).toBeDisabled()
})

// AI-3 질문을 보내면 델타가 순서대로 쌓이고 완료 후 사용량이 갱신된다
test('AI-3 질문을 보내면 델타가 순서대로 쌓이고 완료 후 사용량이 갱신된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openAiPanel(page)
  await page.fill('.ai-panel .ai-input', '로그가 너무 큽니다 어떻게 줄이나요')
  await page.click('.ai-panel [data-action="ai.send"]')

  // 스트리밍 중간 스냅샷 두 개가 "뒤 스냅샷이 앞 스냅샷으로 시작"해야 한다 — 순서대로 이어붙었다는 증거.
  await expect.poll(() => lastAnswer(page), { timeout: 3_000, intervals: [50, 100] }).not.toBe('')
  const mid = await lastAnswer(page)
  await expect.poll(() => lastAnswer(page), { timeout: 5_000 }).not.toBe(mid)
  const later = await lastAnswer(page)
  expect(later.startsWith(mid)).toBe(true)

  // 완료: 스트리밍 버튼이 [보내기]로 돌아오고 코드블록이 렌더된다.
  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ai-turn.ara .ai-code-body').last()).toContainText('du -sh')
  const usage = (await page.evaluate(() => window.ev.ai.getState())).usage
  expect(usage.input).toBeGreaterThan(0)
  expect(usage.output).toBeGreaterThan(0)
  await expect(page.locator('.ai-panel .ai-usage')).toContainText(String(usage.input))
})

// AI-4 스트리밍 중 [중단]을 누르면 부분 텍스트가 남고 중단됨이 표시된다
test('AI-4 스트리밍 중 [중단]을 누르면 부분 텍스트가 남고 중단됨이 표시된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openAiPanel(page)
  await page.fill('.ai-panel .ai-input', '아무거나 물어봅니다')
  await page.click('.ai-panel [data-action="ai.send"]')

  await expect.poll(() => lastAnswer(page), { timeout: 3_000, intervals: [50, 100] }).not.toBe('')
  await page.click('.ai-panel [data-action="ai.stop"]')

  const stopped = await lastAnswer(page)
  expect(stopped.length).toBeGreaterThan(0)
  expect(stopped).not.toContain('안전합니다') // 캔드 스트림 마지막 문장 — 끝까지 가지 않았다
  await expect(page.locator('.ai-turn.ara .ai-note').last()).toHaveText('중단됨')

  await page.waitForTimeout(500) // 중단 후 델타가 더 붙지 않는다(진짜로 멈췄다)
  expect(await lastAnswer(page)).toBe(stopped)
  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible()
})

// AI-5 ★ [터미널로 보내기]는 삽입만 하고 실행하지 않는다(보안 체크리스트 핵심)
test('AI-5 ★ [터미널로 보내기]는 삽입만 하고 실행하지 않는다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await registerAiKey(page)
  await openAiPanel(page)
  await page.fill('.ai-panel .ai-input', '질문')
  await page.click('.ai-panel [data-action="ai.send"]')
  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.ai-turn.ara .ai-code [data-action="ai.insert"]').last()).toBeVisible()

  await page.locator('.ai-turn.ara .ai-code [data-action="ai.insert"]').last().click()
  await expect.poll(() => termText(page, id)).toContain('du -sh /var/log')
  const afterInsert = await termText(page, id)

  // 개행이 갔다면 이 사이에 셸이 실행 결과(또는 명령 인식 오류)를 찍었을 시간이다.
  await page.waitForTimeout(1_500)
  expect(await termText(page, id)).toBe(afterInsert) // 늘지 않았다 = 실행되지 않고 프롬프트에 남았다
})

// AI-6 컨텍스트 칩을 켜고 보내면 사용자 턴에 첨부 배지가 남는다
test('AI-6 컨텍스트 칩을 켜고 보내면 사용자 턴에 첨부 배지가 남는다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 컨텍스트원문표식')
  await expectTermText(page, id, /컨텍스트원문표식/)
  await registerAiKey(page)
  await openAiPanel(page)
  // ctxToggle 이 켜지는 순간 ctxOpen 도 같은 값으로 따라간다(AiPanel.tsx) — 미리보기가 바로 열린다.
  await page.click('.ai-panel [data-action="ai.ctxToggle"]')
  await expect(page.locator('.ai-panel .ai-ctx-full.compose')).toContainText('컨텍스트원문표식')

  await page.fill('.ai-panel .ai-input', '이 출력이 뭔가요')
  await page.click('.ai-panel [data-action="ai.send"]')

  const badge = page.locator('.ai-turn.user [data-action="ai.ctxPeek"]').last()
  await expect(badge).toContainText('📎')
  await expect(badge).toContainText('줄')
  await badge.click()
  await expect(page.locator('.ai-turn.user .ai-ctx-full').last()).toContainText('컨텍스트원문표식')
})

// AI-7 ★ 컨텍스트 미리보기에 비밀 값이 마스킹돼 있다(보안 체크리스트 핵심)
test('AI-7 ★ 컨텍스트 미리보기에 비밀 값이 마스킹돼 있다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'export TOKEN=abc123XYZ')
  await expectTermText(page, id, /TOKEN=abc123XYZ/)
  await registerAiKey(page)
  await openAiPanel(page)
  // ctxToggle 이 켜지는 순간 ctxOpen 도 같은 값으로 따라간다(AiPanel.tsx) — 미리보기가 바로 열린다.
  await page.click('.ai-panel [data-action="ai.ctxToggle"]')

  const preview = page.locator('.ai-panel .ai-ctx-full.compose')
  await expect(preview).toContainText('****')
  expect(await preview.innerText()).not.toContain('abc123XYZ')
})

// AI-8 패널을 닫았다 다시 열어도 대화가 유지된다(main 소유 증명)
test('AI-8 패널을 닫았다 다시 열어도 대화가 유지된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await registerAiKey(page)
  await openAiPanel(page)
  await page.fill('.ai-panel .ai-input', '기억 확인 질문')
  await page.click('.ai-panel [data-action="ai.send"]')
  await expect(page.locator('.ai-panel [data-action="ai.send"]')).toBeVisible({ timeout: 10_000 })
  const before = await page.locator('.ai-turn').count()
  expect(before).toBeGreaterThan(0)

  await page.click('.ai-panel .ai-x')
  await expect(page.locator('.ai-panel')).toHaveCount(0)
  await openAiPanel(page)
  await expect(page.locator('.ai-turn')).toHaveCount(before)
  await expect(page.locator('.ai-turn.user').last()).toContainText('기억 확인 질문')
})

// AI-9 우클릭 메뉴의 [AI에게 질문]이 선택 텍스트를 프리필한다(getSelection 은 'copy' 와 같은 함수)
test('AI-9 우클릭 메뉴의 [AI에게 질문]이 선택 텍스트를 프리필한다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 선택될_텍스트_표식')
  await expectTermText(page, id, /선택될_텍스트_표식/)
  // 키가 없으면 `.ai-input` 이 disabled 라 프리필이 와도 focus() 가 걸리지 않는다(비활성 엘리먼트는
  // 포커스를 받을 수 없다 — HTML 표준) — 포커스 이동까지 보려면 등록된 키가 전제돼야 한다.
  await registerAiKey(page)
  await focusTerminal(page)
  await page.evaluate((sid) => window.__evTerm(sid)?.selectAll(), id)

  // selectAll()은 스크롤백의 빈 줄까지 통째로 잡는다 — 두 시점의 getSelection() 을 문자 단위로
  // 비교하면 빈 줄 트레일링 공백 차이로 흔들린다. "선택 텍스트가 실제로 프리필됐다"는 부분
  // 문자열 포함으로 검증한다(그래도 통짜 문자열 복붙이 아니라 selection 경로를 타야만 통과한다).
  await page.click('.pane-grid', { button: 'right', position: { x: 320, y: 220 } })
  await page.click('.ctx-menu .ctx-item[data-action="ai.ask"]')

  await expect(page.locator('.ai-panel')).toBeVisible()
  await expect(page.locator('.ai-panel .ai-input')).toHaveValue(/선택될_텍스트_표식/)
  await expect(page.locator('.ai-panel .ai-input')).toBeFocused()
})

// AI-10★ 레일은 한 번에 하나만 열린다 (#79, 2026-08-14)
// 이 검사는 원래 "미니 프리뷰와 아라 패널을 **동시에** 열어도 레이아웃이 안 무너진다"였다.
// 준영님 결정으로 레일이 상호 배타가 되면서 그 상황 자체가 만들어지지 않는다 — 지키는 성질을
// 바꾼다: ① 두 번째를 열면 첫 번째가 닫힌다 ② 그래도 **상태는 남는다**(컴포넌트가 안 죽는다)
// ③ 레일이 열린 채로도 터미널이 살아 있다.
//
// 왜 배타로 바꿨나: 레일 여섯이 전부 폭 고정이라 터미널만 줄어들었다. 셋만 열어도 1920 화면에서
// 터미널이 80칸 아래로 떨어지고, 여섯이면 아예 사라졌다.
test('AI-10★ 레일은 하나만 열리고, 다시 열면 쓰던 내용이 남아 있다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await newLocalShell(page)

  await page.keyboard.press('Control+Shift+P')
  await expect(page.locator('.mini-rail')).toBeVisible()

  // ① 아라 패널을 열면 미니 프리뷰가 닫힌다.
  await openAiPanel(page)
  await expect(page.locator('.ai-panel')).toBeVisible()
  await expect(page.locator('.mini-rail')).toHaveCount(0)

  // ② 레일에 값을 남기고 떠났다 돌아오면 그대로 있다(컴포넌트가 죽지 않는다).
  //    이관 이력: 세션 로그 검색창(→ #78 하단) → 시스템 모니터 탭(→ #83 하단) → **아라 패널의
  //    [터미널 화면 첨부] 칩**. 이제 남은 레일이 셋(ai·aisess·preview)뿐이고 그중 사용자가 바꿀
  //    수 있는 값이 이 칩이다. 컴포저 입력칸과 달리 이 칩은 API 키 없이도 눌린다(세션만 있으면 된다).
  const rail = (id: string) => page.click(`.activity-bar .act-item[data-activity="${id}"]`)
  const ctxChip = page.locator('.ai-panel .ai-chip[data-action="ai.ctxToggle"]')
  await expect(ctxChip).toHaveAttribute('aria-pressed', 'false')
  await ctxChip.click()
  await expect(ctxChip).toHaveAttribute('aria-pressed', 'true')
  await rail('preview')
  await expect(page.locator('.mini-rail')).toBeVisible()
  await expect(page.locator('.ai-panel')).toHaveCount(0)
  await rail('ai')
  await expect(ctxChip).toHaveAttribute('aria-pressed', 'true')

  // ③ 레일이 열려 있어도 터미널이 살아 있고 가로 스크롤이 안 생긴다.
  const dims = await page.evaluate(() => {
    const doc = document.documentElement
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().width ?? 0
    return { overflowX: doc.scrollWidth - doc.clientWidth, pane: rect('.pane-grid'), rail: rect('.ai-panel') }
  })
  expect(dims.overflowX).toBeLessThanOrEqual(1)
  expect(dims.pane).toBeGreaterThan(50)
  expect(dims.rail).toBeGreaterThan(50)
})
