// F32 세션 창 떼어내기 — 탭을 별도 OS 창으로 빼서 다른 모니터에 놓는다.
//
// 준영님 요청(2026-08-17): "창을 떼서 스플릿 뿐만 아니라 다른 모니터 혹은 창을 아예 분리하는거지.
// 그리고 거기에도 분할을 할 수 있게. 그 창에서도 따로 하단바가 보이는거지."
//
// 이 파일이 **창 두 개**를 다루는 첫 e2e 다. Electron 앱의 두 번째 창은 `app.waitForEvent('window')`
// 로 잡는다(Playwright 가 BrowserWindow 하나를 Page 하나로 준다).
import { test, expect, newLocalShell, sessionList } from './fixtures'
import type { Page, ElectronApplication } from '@playwright/test'

/** 탭 우클릭 → [새 창으로 떼어내기]. 새로 뜬 창의 Page 를 돌려준다. */
async function detachTab(ara: { app: ElectronApplication; page: Page }, sessionId: string): Promise<Page> {
  const opened = ara.app.waitForEvent('window')
  await ara.page.locator(`.ttab[data-session-id="${sessionId}"]`).click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="session.detach"]')
  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  return win
}

// DETACH-1★ 떼어내면 **세션이 옮겨간다** — 본창에서 사라지고 새 창에 뜬다. 세션은 안 죽는다.
test('DETACH-1★ 탭을 새 창으로 떼어내면 세션이 그 창으로 옮겨간다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const b = await newLocalShell(page)
  await expect(page.locator('.ttab')).toHaveCount(2)

  const win = await detachTab(ara, a)

  // 본창에서는 그 탭이 사라진다(소유가 바뀌었으므로).
  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(0)
  await expect(page.locator(`.ttab[data-session-id="${b}"]`)).toHaveCount(1)

  // 새 창에 그 탭이 있다. **세션은 죽지 않았다** — main 의 세션 수가 그대로다.
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  expect((await sessionList(page)).length).toBe(2)
})

// DETACH-2★ 떼어낸 창에도 **하단바가 따로** 있다(준영님 요청의 핵심 중 하나).
test('DETACH-2★ 떼어낸 창에서 하단바를 따로 켠다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)

  // 본창의 하단바 상태와 무관하다 — 창마다 자기 것이다.
  await expect(win.locator('.bottom-panel')).toHaveCount(0)
  await win.click('.act-bottombar')
  await expect(win.locator('.bottom-panel')).toBeVisible()
  await expect(win.locator('.bottom-panel .bp-tab')).toHaveCount(8)
  // 본창은 그대로 꺼져 있다.
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
})

// DETACH-3★ 떼어낸 창에서도 **분할**이 된다(요청의 나머지 절반).
test('DETACH-3★ 떼어낸 창에서 분할한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  const b = await newLocalShell(page)
  const win = await detachTab(ara, b)
  await expect(win.locator('.pane-grid .pane')).toHaveCount(1, { timeout: 15_000 })

  // 이 창에 세션이 하나뿐이면 나눌 상대가 없다 — 새 셸을 하나 만들고 나눈다.
  await win.click('.tterm-add')
  await expect(win.locator('.ttab')).toHaveCount(2)
  await win.keyboard.press('Control+Shift+\\')
  await expect(win.locator('.pane-grid .pane')).toHaveCount(2)
})

// DETACH-4★ 창을 닫으면 세션은 **본창으로 돌아온다**(죽이지 않는다).
// 창 닫기는 실수로도 일어난다 — 그때 원격 작업이 통째로 끊기면 되돌릴 방법이 없다.
test('DETACH-4★ 떼어낸 창을 닫으면 세션이 본창으로 돌아온다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })

  await win.close()
  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  expect((await sessionList(page)).length).toBe(1)
})

// DETACH-5 떼어낸 창에는 **연결 트리·설정이 없다**(준영님 확정 구성 "작업 창").
// 설정 드로어가 두 창에 동시에 뜨는 상태를 만들지 않는 것이 이 선택의 이유다.
test('DETACH-5 떼어낸 창은 작업 창이다 — 트리·설정이 없다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)

  await expect(win.locator('.sidebar')).toHaveCount(0)
  await expect(win.locator('.act-item[data-activity="settings"]')).toHaveCount(0)
  await expect(win.locator('.act-item[data-activity="ai"]')).toHaveCount(0)
  // 있어야 하는 것: 탭바 · 분할 그리드 · 하단바 토글.
  await expect(win.locator('.term-tabbar')).toHaveCount(1)
  await expect(win.locator('.pane-grid')).toHaveCount(1)
  await expect(win.locator('.act-bottombar')).toHaveCount(1)
})
