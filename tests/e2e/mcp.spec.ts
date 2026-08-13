// F23 설정 [MCP] 섹션 — 서버 토글 · 포트/토큰 노출 · 토큰 1회성 발급 · 연결 관리 행.
// McpSection(SettingsDrawer.tsx)은 프롭 없이 window.ev.mcp.getState()/onStateChanged 로만
// 상태를 얻는다 — 렌더러 로컬 state 는 freshToken(발급 직후 1회 표시) 뿐이다.
import { test, expect } from './fixtures'

const drawer = '.drawer.open'
const mcpToggle = `${drawer} .set-row:has(.sr-label:text-is("MCP 서버")) .set-toggle`

async function openMcpSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="mcp"]`)
}

// MCP-1 최초 상태(새 userData) — 토글 꺼짐, 포트/토큰 행이 렌더되지 않는다.
test('MCP-1 최초 상태에서는 MCP 서버가 꺼져 있고 포트·토큰 행이 보이지 않는다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await expect(page.locator(mcpToggle)).toBeVisible()
  await expect(page.locator(mcpToggle)).not.toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toHaveCount(0)
  await expect(page.locator(`${drawer} [data-field="mcp.token"]`)).toHaveCount(0)
})

// MCP-2 토글을 켜면 127.0.0.1 로컬 포트가 즉시 노출된다.
test('MCP-2 토글을 켜면 포트가 127.0.0.1: 로 표시된다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await expect(page.locator(mcpToggle)).toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toContainText(/^127\.0\.0\.1:\d+/)
})

// MCP-3 토큰 발급 — 입력칸에 값이 채워지고 "지금 복사하세요" 류 경고가 뜬다.
test('MCP-3 토큰을 발급하면 입력칸에 값이 채워지고 경고 문구가 뜬다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await page.click(`${drawer} [data-action="mcp.token.issue"]`)
  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).not.toHaveValue('')
  // 상시 노출되는 .set-note[data-note="mcp.scope"] 와 별개로, 발급 직후에만 뜨는 경고 note(data-note 없음).
  await expect(page.locator(`${drawer} .set-note:not([data-note])`)).toBeVisible()
})

// MCP-5 발급 직후 토큰은 컴포넌트 밖(상위 상태·workspace.json)으로 올라가지 않는다 — 재조회 채널이
// 계약에 없다(McpSection 주석). 드로어를 닫았다가 다시 열어도(섹션을 벗어났다가 되돌아오는 재진입) 값이
// 남아 있으면 안 된다 — freshToken 은 McpSection 로컬 state 라 실제로 사라짐을 보려면 그 컴포넌트를
// 다시 마운트시켜야 한다(Escape 는 CSS 로만 드로어를 숨기고 SettingsDrawer/McpSection 은 계속 마운트된
// 채로 남는다 — 실제 소스 확인: MainArea.tsx 가 SettingsDrawer 를 unmount 하지 않는다). 그래서 재진입은
// 다른 섹션을 거쳐 mcp 섹션으로 되돌아오는 경로로 만든다(section 이 바뀌면 McpSection 이 unmount/remount).
test('MCP-5 발급된 토큰은 섹션을 재진입하면 다시 보이지 않는다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await page.click(`${drawer} [data-action="mcp.token.issue"]`)
  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).not.toHaveValue('')

  await page.click(`${drawer} .set-nav [data-section="general"]`)
  await page.click(`${drawer} .set-nav [data-section="mcp"]`)

  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).toHaveValue('')
  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).toHaveAttribute('placeholder', /발급된 토큰 있음/)
})

// MCP-7 토글을 다시 끄면 포트·토큰 행이 다시 사라진다.
test('MCP-7 토글을 다시 끄면 포트·토큰 행이 사라진다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toBeVisible()
  await page.click(mcpToggle)
  await expect(page.locator(mcpToggle)).not.toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toHaveCount(0)
  await expect(page.locator(`${drawer} [data-field="mcp.token"]`)).toHaveCount(0)
})

// MCP-13 서버가 켜진 상태에서도 데이터 범위 고지(.set-note[data-note="mcp.scope"])가 항상 보인다.
test('MCP-13 서버 켜짐 상태에서 데이터 범위 고지가 보인다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toBeVisible()
  await expect(page.locator(`${drawer} .set-note[data-note="mcp.scope"]`)).toBeVisible()
})
