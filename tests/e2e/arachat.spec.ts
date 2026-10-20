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
  // 세션이 없으니 아라 폴더에서 열린다 — 머리에는 경로 대신 [폴더 고르기]가 뜬다(#137).
  await expect(ara.page.locator('.ara-panel .ara-path .cwd.home')).toBeVisible()
}

test('ARA2-1★ 레일을 열면 대화가 시작되고, 보낸 말·도구 묶음·글·비용이 차례로 뜬다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // ① 열자마자 붙는다 — 사람이 [시작]을 한 번 더 누르게 하지 않는다.
  //    v2: 시작 안내 줄은 없다 — 폴더는 경로 줄이, 엔진·모델은 선택기가 말한다.
  await expect(panel.locator('.ara-note')).toHaveCount(0)
  await expect(panel.locator('.ara-path .cwd')).toBeVisible()
  await expect(panel.locator('.ara-ustrip')).toHaveText('—')

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
  // v2: 비용은 머리 아래 사용량 줄(한도가 없으면 이번 대화 토큰 · 추정 비용).
  await expect(panel.locator('.ara-ustrip')).toContainText('한도 확인 불가')
  await expect(panel.locator('.ara-ustrip')).toContainText('$0.01')
})

test('ARA2-2 [중지]는 도는 동안에만 눌린다 · 닫았다 열어도 대화가 남는다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')
  // #137: 보내기와 중지가 **같은 버튼**이다(상용 서비스 배치) — 도는 중에만 [중지]가 된다.
  const send = panel.locator('.ara-send')

  // 대기 중이고 쓴 것도 없으면 누를 것이 없다.
  await expect(send).toBeDisabled()
  await expect(send).not.toHaveClass(/stop/)
  await panel.locator('.ara-input').fill('안녕')
  await panel.locator('.ara-input').press('Enter')
  await expect(panel.locator('.ara-ai')).toContainText('받은 말: 안녕')
  // 턴이 끝나면 [중지]가 아니게 되고, 입력칸이 비어 있으니 다시 잠긴다.
  await expect(send).not.toHaveClass(/stop/)
  await expect(send).toBeDisabled()

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

test('ARA2-5★ claude 가 없으면 **알리고 API 로 넘어간다** · 스위치로 되돌린다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // 하네스에는 캔드 엔진이 붙어 있어 이 상태가 저절로 오지 않는다 — 사건만 흘려 넣는다.
  // "정말 없을 때 이 사건이 나오고 API 로 넘어가는가"는 tests/araChat.test.ts 가 본다.
  await ara.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ara:event', { t: 'noEngine' })
  })

  // 조용히 바꾸지 않는다 — 왜 넘어갔는지 한 줄로 남는다(설치 명령까지).
  const note = panel.locator('.ara-note.bad')
  await expect(note).toContainText('Claude Code 가 없어')
  await expect(note).toContainText('@anthropic-ai/claude-code')
  // 입력칸은 잠기지 않는다 — API 로 대화는 된다.
  await expect(panel.locator('.ara-input')).toBeEnabled()

  // 선택기 메뉴의 엔진 항목 — 지금과 다른 엔진을 고르면 새 대화로 다시 연다(배선으로 확인).
  const sel = panel.locator('.ara-sel')
  await expect(sel.locator('.en')).toHaveText('Claude Code') // 아직 opened 가 안 왔으니 표시는 cli 다
  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ara:open')
    ;(globalThis as unknown as { __opens: unknown[] }).__opens = []
    ipcMain.handle('ara:open', (_e, o) => {
      ;(globalThis as unknown as { __opens: unknown[] }).__opens.push(o)
      return { ok: true }
    })
  })
  await sel.click()
  await panel.locator('.ara-pick-menu [data-engine="api"]').click()
  const opens = await ara.app.evaluate(() => (globalThis as unknown as { __opens: { engine?: string }[] }).__opens)
  expect(opens).toHaveLength(1)
  expect(opens[0].engine).toBe('api') // cli 표시 상태에서 누르면 api 를 요청한다
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
  await panel.locator('.ara-path .cwd').click()
  const opens = await ara.app.evaluate(() => (globalThis as unknown as { __opens: { cwd?: string }[] }).__opens)
  expect(opens).toHaveLength(1)
  expect(opens[0].cwd).toBe(process.cwd()) // openAra 가 fs:pickDir 을 저장소 루트로 스텁해 뒀다
})


test('ARA2-6★ [계획 먼저] → 계획이 나오면 승인 줄 → [이대로 진행]', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')
  const chip = panel.locator('.ara-chip.plan')

  // 켜기 — 상태가 화면이 아니라 main 에서 온다(planMode 사건). 화면이 스스로 짐작하지 않는다.
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')

  // 계획이 나오기 전에는 승인 줄이 없다.
  await expect(panel.locator('.ara-plan')).toHaveCount(0)

  await panel.locator('.ara-input').fill('로그 정리 계획 세워 줘')
  await panel.locator('.ara-input').press('Enter')
  await expect(panel.locator('.ara-plan')).toBeVisible() // 턴이 끝나면 선다

  await ara.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ara:approvePlan')
    ;(globalThis as unknown as { __approve: number }).__approve = 0
    ipcMain.handle('ara:approvePlan', () => {
      ;(globalThis as unknown as { __approve: number }).__approve += 1
      return { ok: true }
    })
  })
  await panel.locator('.ara-plan .ara-btn.p').click()
  expect(await ara.app.evaluate(() => (globalThis as unknown as { __approve: number }).__approve)).toBe(1)
})

test('ARA2-7★ 모델을 고른다 · 폭을 끌어 넓힌다 · 답변이 마크다운으로 그려진다', async ({ ara }) => {
  const { page } = ara
  await openAra(ara)
  const panel = page.locator('.ara-panel')

  // ① 모델 — 기본은 "고르지 않음"(사용자의 ~/.claude 그대로). 고르면 그 이름이 칩에 박힌다.
  const chip = panel.locator('.ara-sel .md')
  await expect(chip).toHaveText('기본값')
  await panel.locator('.ara-sel').click()
  await panel.locator('.ara-pick-menu [data-model="haiku"]').click()
  await expect(panel.locator('.ara-pick-menu')).toHaveCount(0)
  await expect(chip).toHaveText('Haiku') // main 이 알려 준 값이다(화면이 짐작하지 않는다)

  // ② 폭 — 고정이 아니다. 왼쪽 손잡이를 끌면 넓어진다.
  const before = (await panel.boundingBox())!.width
  const grip = panel.locator('.ara-grip')
  const g = (await grip.boundingBox())!
  await page.mouse.move(g.x + 2, g.y + 100)
  await page.mouse.down()
  await page.mouse.move(g.x - 160, g.y + 100, { steps: 8 })
  await page.mouse.up()
  const after = (await panel.boundingBox())!.width
  expect(after).toBeGreaterThan(before + 100)

  // ③ 마크다운 — 코드블록·목록·굵게가 글자 그대로가 아니라 **모양**으로 나온다.
  await ara.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ara:event', {
      t: 'text',
      text:
        '## 결과\n\n**둘** 중 하나:\n\n- 지우기\n- 두기\n\n| 이름 | 크기 |\n|---|---|\n| /var/log | 22G |\n| /var/lib | 9G |\n\n```bash\ndu -x -d1 /var\n```\n\n<script>alert(1)</script>'
    })
  })
  await expect(panel.locator('.md h2')).toHaveText('결과')
  await expect(panel.locator('.md ul li')).toHaveCount(2)
  await expect(panel.locator('.md-pre code')).toContainText('du -x -d1 /var')
  await expect(panel.locator('.ara-ai strong')).toHaveText('둘')

  // ④ 표는 **표로** 나온다(2026-08-25 제보: 파이프 글자가 그대로 보였다).
  await expect(panel.locator('.md-table th')).toHaveCount(2)
  await expect(panel.locator('.md-table tbody tr')).toHaveCount(2)
  await expect(panel.locator('.md-table tbody tr').first()).toContainText('/var/log')

  // ⑤★ 원문 HTML 은 **글자로** 남는다 — rehype-raw 를 안 넣는다(답변 속 태그가 진짜 태그가 되면 안 된다).
  await expect(panel.locator('.ara-ai script')).toHaveCount(0)
  await expect(panel.locator('.ara-ai')).toContainText('alert(1)')

  // ⑥ 도는 동안 점이 움직인다 — 상태줄 글자만으로는 눈에 안 걸린다.
  await expect(panel.locator('.ara-think')).toBeVisible()
})

/**
 * ARA2-8★ 지난 대화 목록(2026-08-26 준영님 요청 + 제보).
 *
 * 요청은 *"이전 대화 라는 버튼으로 누르면 대화창에서 뜨지 말고 팝업으로"* 였고, 제보는
 * *"이전 대화 목록 누르면 아무것도 안나와"* 였다. 둘 다 여기서 지킨다.
 *
 * **실제 홈을 건드리지 않는다.** CLI 대화 기록은 `~/.claude/projects/` 에 있어서 거기에 시험용
 * 파일을 심으면 사용자 PC 를 더럽힌다. API 기록은 `userData/ara-chats/` — 테스트가 만든 임시
 * 폴더 안이라 마음껏 심을 수 있고, 목록은 두 저장소를 합쳐 보여 주므로 같은 화면을 검사한다.
 */
test('ARA2-8★ [지난 대화] 버튼 → 팝업에 목록 · 이름 붙이기 · 이어서 열기', async ({ userDataDir, launch }) => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const id = 'aaaaaaaa-1111-2222-3333-444444444444'
  const dir = join(userDataDir, 'ara-chats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'user', message: { content: '지난번 배포 점검' }, at: Date.now() }),
      JSON.stringify({ type: 'assistant', message: { content: '디스크 78% 였습니다.' }, at: Date.now() })
    ].join('\n') + '\n',
    'utf8'
  )

  const a = await launch(userDataDir)
  await a.page.click('.activity-bar .act-item[data-activity="ai"]')
  await expect(a.page.locator('.ara-panel')).toBeVisible()

  // ① 버튼이 **글자로** 보인다 — 아이콘만 뒀더니 무엇인지 안 읽혔다(준영님 제보).
  const btn = a.page.locator('.ara-panel [data-action="ara.chats"]')
  await expect(btn).toContainText('지난 대화')

  // ② 누르면 **팝업**이 뜨고 목록이 비어 있지 않다(제보의 그 자리).
  await btn.click()
  const modal = a.page.locator('.overlay.open .modal.ara-chats')
  await expect(modal).toBeVisible()
  const row = modal.locator(`.ac-row[data-chat="${id}"]`)
  await expect(row).toBeVisible()
  // 이름이 없으면 첫 질문이 제목이다. API 기록이므로 배지가 붙는다.
  await expect(row.locator('.ac-t')).toHaveText('지난번 배포 점검')
  await expect(row.locator('.sess-type')).toHaveText('API')

  // ②b [새 대화] 는 목록 옆에 있다 — 이어 가던 것을 놓고 빈 판에서 시작한다.
  await expect(a.page.locator('.ara-panel [data-action="ara.chats.new"]')).toContainText('새 대화')

  // ③ 이름을 붙이면 목록이 그 이름으로 바뀐다.
  await row.locator('[data-action="ara.chats.rename"]').click()
  await row.locator('.ac-name').fill('금요일 배포')
  await row.locator('.ac-name').press('Enter')
  await expect(modal.locator(`.ac-row[data-chat="${id}"] .ac-t`)).toHaveText('금요일 배포')

  /**
   * ④★ **고르면 지난 말들이 화면에 뜬다**(2026-08-26 제보: *"클릭하면 여전히 아무것도 안나와"*).
   *
   * `--resume` 은 문맥만 이어받고 지난 메시지를 다시 보내 주지 않는다 — 그래서 이어서 열면 아라는
   * 앞 얘기를 아는데 **화면만 비어 있었다.** 기록을 읽어 채우는 것이 이 검사의 대상이다.
   */
  await modal.locator(`.ac-row[data-chat="${id}"] .ac-open`).click()
  await expect(a.page.locator('.overlay.open .modal.ara-chats')).toHaveCount(0)
  await expect(a.page.locator('.ara-panel .ara-me')).toContainText('지난번 배포 점검')
  await expect(a.page.locator('.ara-panel .ara-ai').first()).toContainText('디스크 78% 였습니다')

  // ⑤ 이름은 재기동 후에도 남는다(workspace.json 에 저장 — CLI 에는 대화 이름이 없다).
  await a.app.close()
  const b = await launch(userDataDir)
  await b.page.click('.activity-bar .act-item[data-activity="ai"]')
  await b.page.locator('.ara-panel [data-action="ara.chats"]').click()
  await expect(b.page.locator(`.overlay.open .modal.ara-chats .ac-row[data-chat="${id}"] .ac-t`)).toHaveText('금요일 배포')
})
