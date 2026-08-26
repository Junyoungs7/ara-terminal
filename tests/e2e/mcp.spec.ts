// F23 설정 [MCP] 섹션 — 서버 토글 · 포트/토큰 노출 · 토큰 1회성 발급 · 연결 관리 행.
// McpSection(SettingsDrawer.tsx)은 프롭 없이 window.ev.mcp.getState()/onStateChanged 로만
// 상태를 얻는다 — 렌더러 로컬 state 는 freshToken(발급 직후 1회 표시) 뿐이다.
import { test, expect, skipIntro, dialog, dialogConfirm, dialogCancel } from './fixtures'

const drawer = '.drawer.open'
const mcpToggle = `${drawer} .set-row:has(.sr-label:text-is("MCP 서버")) .set-toggle`

async function openMcpSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="mcp"]`)
}

/**
 * MCP-1★ **기본이 뒤집혔다**(2026-08-26 준영님 지시: *"mcp는 무조건 기본으로 켜지게"*).
 *
 * 전에는 "최초 상태에서 꺼져 있다"를 지켰다. 그런데 아라가 이 앱의 도구를 쓰는 길이 MCP 하나뿐이라,
 * 꺼진 채로 시작하면 사용자가 아무것도 안 건드렸는데 아라가 반쪽이 된다.
 */
test('MCP-1★ 최초 상태에서 MCP 서버가 켜져 있고 포트가 127.0.0.1 로 보인다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await expect(page.locator(mcpToggle)).toBeVisible()
  await expect(page.locator(mcpToggle)).toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toContainText(/^127\.0\.0\.1:\d+/)
})

/**
 * MCP-2★ 끄기 전에 **무엇을 잃는지** 말한다. 겉보기엔 서버 하나 끄기지만 실제로는 아라의 손을
 * 자르는 일이라, 확인 없이 넘어가면 나중에 "아라가 왜 아무것도 못 하지"가 된다.
 */
test('MCP-2★ 끄려 하면 아라가 도구를 잃는다고 알리고, 취소하면 켜진 채로 남는다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  const dlg = dialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('아라')
  await expect(dlg).toContainText('도구')
  // 취소 = 아무 일도 없다.
  await dialogCancel(page)
  await expect(page.locator(mcpToggle)).toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toBeVisible()
})

// MCP-3 토큰 발급 — 입력칸에 값이 채워지고 "지금 복사하세요" 류 경고가 뜬다.
test('MCP-3 토큰을 발급하면 입력칸에 값이 채워지고 경고 문구가 뜬다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
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
  await page.click(`${drawer} [data-action="mcp.token.issue"]`)
  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).not.toHaveValue('')

  await page.click(`${drawer} .set-nav [data-section="general"]`)
  await page.click(`${drawer} .set-nav [data-section="mcp"]`)

  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).toHaveValue('')
  await expect(page.locator(`${drawer} input[data-field="mcp.token"]`)).toHaveAttribute('placeholder', /발급된 토큰 있음/)
})

// MCP-7 확인하고 끄면 포트·토큰 행이 사라진다(끄는 길 자체는 막지 않는다 — 경고만 한다).
test('MCP-7 확인 후 끄면 포트·토큰 행이 사라진다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toBeVisible()
  await page.click(mcpToggle)
  await dialogConfirm(page)
  await expect(page.locator(mcpToggle)).not.toHaveClass(/on/)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toHaveCount(0)
  await expect(page.locator(`${drawer} [data-field="mcp.token"]`)).toHaveCount(0)
})

// MCP-7b★ 끈 선택은 **재시작해도 유지된다** — 저장하지 않으면 매번 되살아나 "껐는데 왜 또"가 된다.
test('MCP-7b★ 끄고 새로고침해도 꺼진 채로 남는다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await page.click(mcpToggle)
  await dialogConfirm(page)
  await expect(page.locator(mcpToggle)).not.toHaveClass(/on/)

  await page.reload()
  await skipIntro(page)
  await openMcpSettings(page)
  await expect(page.locator(mcpToggle)).not.toHaveClass(/on/)
})

// MCP-13 서버가 켜진 상태에서도 데이터 범위 고지(.set-note[data-note="mcp.scope"])가 항상 보인다.
test('MCP-13 서버 켜짐 상태에서 데이터 범위 고지가 보인다', async ({ ara }) => {
  const { page } = ara
  await openMcpSettings(page)
  await expect(page.locator(`${drawer} [data-field="mcp.port"]`)).toBeVisible()
  await expect(page.locator(`${drawer} .set-note[data-note="mcp.scope"]`)).toBeVisible()
})

/**
 * MCP-28★ 2026-08-26 준영님 제보 — 아라에게 *"KVT 서버 열어달라"* 했더니 *"접속했습니다. 터미널
 * 열렸으니 바로 쓰시면 됩니다"* 라고 답했는데 **화면에 세션창이 안 떴다**.
 *
 * 원인은 접속 실패가 아니었다. 세션은 진짜로 살아 있었고, 렌더러 목록이 "내가 연 것"만 기억하는
 * 구조라 **렌더러가 열지 않은 세션은 영영 탭이 없었다**. 사람이 볼 수도 닫을 수도 없는 연결이다.
 *
 * 재현 방법: `window.ev.session.create` 를 **직접** 부른다. 이건 preload API 라 렌더러 store 를
 * 지나지 않는다 — MCP 툴이 main 에서 세션을 만드는 것과 화면 입장에서 똑같은 상황이고,
 * 그래서 탭이 생기는 길은 main 이 보내는 `session:opened` 알림 하나뿐이다.
 */
test('MCP-28★ 렌더러를 거치지 않고 main 에서 생긴 세션도 탭으로 나타난다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(0)

  const id = await page.evaluate(async () => {
    const r = await window.ev.session.create({
      type: 'local',
      title: '아라가 연 셸',
      serverKey: 'localhost',
      cwd: undefined,
      profileId: null,
      shell: undefined
    })
    return r.id
  })
  expect(id).toBeTruthy()

  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(1)
  await expect(page.locator('.term-tabbar .ttab')).toContainText('아라가 연 셸')
  // 탭만 있고 화면이 비면 반쪽이다 — 사람이 바로 쓸 수 있어야 "열렸다"가 참이 된다.
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
})
