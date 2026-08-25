// #125 아라 대화 v2 — 우측 레일의 대화 화면(B+C 혼합).
//
// **진짜 claude 를 띄우지 않는다.** 하네스는 늘 `ARA_AI_FAKE=1` 로 뜨고(fixtures.ts), 그 값이면
// AraChat 이 캔드 엔진(FakeEngine)을 붙인다 — F16 이 API 엔진에 쓰던 그 seam 을 CLI 엔진에도
// 같은 이름으로 뒀다. 여기서 보는 것은 배선이다: 사건 → 접기 규칙 → 그리기 → 되돌려 보내기.
// 접기 규칙 자체(무엇이 한 묶음이 되는가)는 tests/araChatItems.test.ts 가 순수 함수로 본다.
import type { Ara } from './fixtures'
import { test, expect } from './fixtures'
import { ARA_CHAT } from '../../src/shared/features'

test.beforeEach(() => {
  test.skip(!ARA_CHAT, '아라 대화 v2 숨김 — src/shared/features.ts 의 ARA_CHAT 을 켜면 돈다')
})

/**
 * 세션을 하나도 안 열고 레일을 연다 → **아라 폴더에서 바로 시작한다**(2026-08-25 준영님 결정:
 * 폴더를 묻지 않는다). 로컬 셸을 먼저 띄우면 cwd 가 셸 통합으로 뒤늦게 도착해 어느 폴더에서
 * 열릴지가 타이밍에 달린다 — 검사가 거기에 기대면 안 된다.
 */
async function openAra(ara: Ara): Promise<void> {
  await ara.app.evaluate(({ ipcMain }, dir) => {
    ipcMain.removeHandler('fs:pickDir')
    ipcMain.handle('fs:pickDir', () => ({ dir }))
  }, process.cwd())
  await ara.page.click('.activity-bar .act-item[data-activity="ai"]')
  await expect(ara.page.locator('.ara-panel .ara-hd .cwd')).toBeVisible()
}

test('ARA2-1★ 레일을 열면 대화가 시작되고, 보낸 말·도구 묶음·글·비용이 차례로 뜬다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // ① 열자마자 붙는다 — 사람이 [시작]을 한 번 더 누르게 하지 않는다.
  //    첫 줄은 "어디서 도는지"다(아라가 어느 폴더에 있는지 모르면 안 된다).
  await expect(panel.locator('.ara-note').first()).toContainText('도구 3개')
  await expect(panel.locator('.ara-hd .cwd')).toBeVisible()

  // ② 보낸 말은 즉시 뜬다(답을 기다리는 동안 화면이 비면 안 된다).
  const input = panel.locator('.ara-input')
  await input.fill('세션 목록 좀 봐 줘')
  await input.press('Enter')
  await expect(panel.locator('.ara-me')).toHaveText('세션 목록 좀 봐 줘')

  // ③ 잇따른 도구 둘이 **한 줄로 접혀** 있다(B안의 핵심). 펴면 이름과 요약이 보인다.
  const fold = panel.locator('.ara-fold')
  await expect(fold).toHaveCount(1)
  await expect(fold.locator('.hd .n')).toHaveText('도구 2개 썼습니다')
  await expect(fold.locator('.in')).toHaveCount(0)
  await fold.locator('.hd').click()
  await expect(fold.locator('.in .l')).toHaveCount(2)
  await expect(fold.locator('.in .l').first()).toContainText('mcp__ara__session_list')
  await expect(fold.locator('.in .l').first()).toContainText('세션 1개')

  // ④ 글과 비용·턴. 비용은 "이 대화가 얼마 썼나"라 늘 보여야 한다(설계 §4-4).
  await expect(panel.locator('.ara-ai')).toContainText('받은 말: 세션 목록 좀 봐 줘')
  await expect(panel.locator('.ara-bar .c')).toContainText('1턴')
  await expect(panel.locator('.ara-bar .c')).toContainText('$0.012')
})

test('ARA2-2 [중지]는 도는 동안에만 눌린다 · 닫았다 열어도 대화가 남는다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')
  const stop = panel.locator('.ara-bar .ara-btn')

  // 대기 중에는 멈출 것이 없다.
  await expect(stop).toBeDisabled()
  await panel.locator('.ara-input').fill('안녕')
  await panel.locator('.ara-input').press('Enter')
  await expect(panel.locator('.ara-ai')).toContainText('받은 말: 안녕')
  await expect(stop).toBeDisabled() // 턴이 끝나면 다시 잠긴다

  // 레일을 옮겼다 돌아와도 대화가 그대로다 — 언마운트하면 목록도 엔진도 새로 뜬다(#125 렌더 규칙).
  await page.click('.activity-bar .act-item[data-activity="preview"]')
  await expect(panel).toHaveCount(0)
  await page.click('.activity-bar .act-item[data-activity="ai"]')
  await expect(panel.locator('.ara-me')).toHaveText('안녕')
  await expect(panel.locator('.ara-fold')).toHaveCount(1)
})

test('ARA2-3★ 되묻기는 알약 버튼이고 숫자 키로도 고른다 — 답이 그대로 돌아간다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // 되묻기는 MCP 채널로 온다(ask_user 도구가 부른 것). 여기서는 그 push 만 흉내 낸다 —
  // 도구가 실제로 이 사건을 만드는지는 tests/askUser.test.ts 가 본다.
  const push = (askId: string): Promise<void> =>
    ara.app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0].webContents.send('mcp:ask', {
        askId: id,
        question: '어느 서버를 정리할까요?',
        options: ['dev-server (91%)', 'vgt-t001 (74%)', '둘 다'],
        multi: false,
        expiresAt: Date.now() + 300_000
      })
    }, askId)

  // 답을 가로챈다 — 실제로 무엇이 돌아갔는지 화면 말고 배선으로 본다.
  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('mcp:askAnswer')
    ;(globalThis as unknown as { __asks: unknown[] }).__asks = []
    ipcMain.handle('mcp:askAnswer', (_e, d) => {
      ;(globalThis as unknown as { __asks: unknown[] }).__asks.push(d)
      return { ok: true }
    })
  })

  await push('a1')
  const card = panel.locator('.ara-ask')
  await expect(card.locator('.q')).toHaveText('어느 서버를 정리할까요?')
  await expect(card.locator('.pill')).toHaveCount(3)
  await expect(card.locator('.meta')).toContainText('남음')

  // 마우스로 고르기.
  await card.locator('.pill').nth(1).click()
  await expect(panel.locator('.ara-ask')).toHaveCount(0)

  // 숫자 키로 고르기 — 마우스 없이도 답할 수 있어야 한다.
  await push('a2')
  await expect(panel.locator('.ara-ask')).toBeFocused() // 카드가 키를 받는다(입력칸이 아니라)
  await page.keyboard.press('3')
  await expect(panel.locator('.ara-ask')).toHaveCount(0)

  const sent = await ara.app.evaluate(() => (globalThis as unknown as { __asks: { askId: string; text: string }[] }).__asks)
  expect(sent).toEqual([
    { askId: 'a1', text: 'vgt-t001 (74%)' },
    { askId: 'a2', text: '둘 다' }
  ])
})

test('ARA2-5★ claude 가 없으면 두 갈래를 보여 준다 — 설치하거나 API 키로', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // 하네스에는 캔드 엔진이 붙어 있어 이 상태가 저절로 오지 않는다 — 사건만 흘려 넣는다.
  // "정말 없을 때 이 사건이 나오는가"는 tests/araChat.test.ts 가 where/which 를 가로채 본다.
  await ara.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ara:event', { t: 'noEngine' })
  })

  const box = panel.locator('.ara-empty')
  await expect(box).toContainText('Claude Code 가 없습니다')
  await expect(box.locator('.ara-cmd')).toContainText('@anthropic-ai/claude-code')
  // 입력칸은 잠긴다 — 답할 상대가 없는데 글을 받으면 안 된다.
  await expect(panel.locator('.ara-input')).toBeDisabled()

  // [API 키로 쓰기]가 실제로 그 엔진을 요청하는지 배선으로 본다(화면 문구가 아니라).
  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ara:open')
    ;(globalThis as unknown as { __opens: unknown[] }).__opens = []
    ipcMain.handle('ara:open', (_e, o) => {
      ;(globalThis as unknown as { __opens: unknown[] }).__opens.push(o)
      return { ok: true }
    })
  })
  await box.locator('.ara-btn.p').click()
  const opens = await ara.app.evaluate(() => (globalThis as unknown as { __opens: { engine?: string }[] }).__opens)
  expect(opens).toHaveLength(1)
  expect(opens[0].engine).toBe('api')
})

test('ARA2-4 폴더를 묻지 않는다 · 머리의 폴더를 눌러 옮긴다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // 폴더를 고르라는 화면이 **없다** — 열자마자 대화가 된다(2026-08-25 준영님 결정).
  await expect(panel.locator('.ara-empty')).toHaveCount(0)
  await expect(panel.locator('.ara-input')).toBeEnabled()

  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ara:open')
    ;(globalThis as unknown as { __opens: unknown[] }).__opens = []
    ipcMain.handle('ara:open', (_e, o) => {
      ;(globalThis as unknown as { __opens: unknown[] }).__opens.push(o)
      return { ok: true }
    })
  })
  await panel.locator('.ara-hd .cwd').click()
  const opens = await ara.app.evaluate(() => (globalThis as unknown as { __opens: { cwd?: string }[] }).__opens)
  expect(opens).toHaveLength(1)
  expect(opens[0].cwd).toBe(process.cwd()) // openAra 가 fs:pickDir 을 저장소 루트로 스텁해 뒀다
})

test('ARA2-6★ 막히면 그 자리에서 묻는다 — [이 대화 동안 허용]이 그 등급을 연다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // 하네스는 캔드 엔진이라 진짜로 막히지 않는다 — 사건만 흘려 넣는다. "정말 막혔을 때 이 사건이
  // 나오는가"는 tests/araChat.test.ts 가 실측 문구 그대로 확인한다.
  await ara.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ara:event', { t: 'blocked', tool: 'Write', cls: 'write' })
  })
  const box = panel.locator('.ara-block')
  await expect(box).toContainText('Write')

  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ara:allow')
    ;(globalThis as unknown as { __allows: unknown[] }).__allows = []
    ipcMain.handle('ara:allow', (_e, o) => {
      ;(globalThis as unknown as { __allows: unknown[] }).__allows.push(o)
      return { ok: true }
    })
  })
  await box.locator('.ara-btn.p').click()
  await expect(panel.locator('.ara-block')).toHaveCount(0)
  const allows = await ara.app.evaluate(() => (globalThis as unknown as { __allows: { cls?: string }[] }).__allows)
  expect(allows).toEqual([{ cls: 'write' }])
})
