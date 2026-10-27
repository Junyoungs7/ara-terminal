// F32 세션 창 떼어내기 — 탭을 별도 OS 창으로 빼서 다른 모니터에 놓는다.
//
// 준영님 요청(2026-08-17): "창을 떼서 스플릿 뿐만 아니라 다른 모니터 혹은 창을 아예 분리하는거지.
// 그리고 거기에도 분할을 할 수 있게. 그 창에서도 따로 하단바가 보이는거지."
//
// 이 파일이 **창 두 개**를 다루는 첫 e2e 다. Electron 앱의 두 번째 창은 `app.waitForEvent('window')`
// 로 잡는다(Playwright 가 BrowserWindow 하나를 Page 하나로 준다).
import { test, expect, newLocalShell, sessionList, connModal, dialogAlt, dialogCancel, dialogConfirm } from './fixtures'
import type { Page, ElectronApplication } from '@playwright/test'
import { BOTTOM_IDS } from '../../src/shared/types'

/**
 * **어느 아라 창 위도 아닌** 화면 좌표. 2026-08-23(제보 5)부터 main 이 "다른 아라 창 위에 놓았나"를
 * 좌표로 가르기 때문에, 새 창을 기대하는 검사는 그 판정에 걸리지 않는 점을 골라야 한다
 * (창이 둘 이상 떠 있으면 옆 창 위에 떨어지기 쉽다).
 */
async function pointOutsideWindows(app: ElectronApplication): Promise<{ x: number; y: number }> {
  const boxes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const top = Math.min(...boxes.map((b) => b.y))
  return { x: right + 60, y: top + 40 }
}

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
  const mainBefore = await page.locator('.bottom-panel').count()
  await win.click('.act-bottombar')
  await expect(win.locator('.bottom-panel')).toBeVisible()
  // 개수를 손으로 박지 않는다 — F26 이 ps·svc·disk 를 더했을 때 8 이 낡아 이 검사만 깨졌다
  // (지키려는 성질은 "떼어낸 창도 **같은** 하단바를 갖는다"이지 "탭이 여덟"이 아니다).
  await expect(win.locator('.bottom-panel .bp-tab')).toHaveCount(BOTTOM_IDS.length)
  // 저쪽을 켜도 이쪽은 안 움직인다. **"본창은 꺼져 있다"를 박지 않는다** — 2026-08-24~2.0 이전엔
  // 본창 하단바가 첫 세션에 자동으로 열렸다(2.0 에서 걷음). 지킬 성질은 독립성이다.
  expect(await page.locator('.bottom-panel').count()).toBe(mainBefore)
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

/**
 * 창 닫기를 사람이 누른 것처럼 시작한다 — 창 버튼(네이티브 X)은 Playwright 가 못 누르므로
 * 같은 자리로 들어가는 `window:close` 를 부른다. **그 창이 닫히는지**가 이 호출의 첫 시험이다
 * (예전엔 이 채널이 무조건 본창을 닫았다 — 떼어낸 창이 스스로 닫으려다 앱을 끝내던 결함).
 */
async function askClose(win: Page): Promise<void> {
  await win.evaluate(() => void window.ev?.window.close())
}

// DETACH-4★ 창을 닫으면 **무엇이 사라지는지 먼저 보여 주고 묻는다**(2026-08-22 준영님 결정).
// [본창으로 보내기] = 예전 기본값. 창 닫기는 실수로도 일어나므로 이 탈출구는 남겨 둔다.
test('DETACH-4★ 떼어낸 창을 닫으면 물어보고, [본창으로 보내기]면 세션이 돌아온다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })

  await askClose(win)
  // 목록이 보인다 — "세션 1개"가 아니라 그 세션의 이름이 있어야 무엇을 잃는지 안다.
  // 부하가 걸린 전체 실행에서는 창 사이 왕복(close → 물음 → 렌더)이 기본 타임아웃을 넘긴다.
  await expect(win.locator('.dlg-overlay .dlg-detail .dlg-row')).toHaveCount(1, { timeout: 15_000 })
  await dialogAlt(win) // [본창으로 보내기]

  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  expect((await sessionList(page)).length).toBe(1)
})

// DETACH-6★ [종료하고 닫기] 는 실제로 **세션을 죽인다** — 본창에 되돌아오지 않는다.
test('DETACH-6★ 확인하면 그 창의 세션이 종료된다', async ({ ara }) => {
  const { page } = ara
  const keep = await newLocalShell(page)
  const gone = await newLocalShell(page)
  const win = await detachTab(ara, gone)
  await expect(win.locator(`.ttab[data-session-id="${gone}"]`)).toHaveCount(1, { timeout: 15_000 })

  await askClose(win)
  await dialogConfirm(win) // [종료하고 닫기]

  // 본창에는 남긴 세션 하나뿐 — 죽은 세션은 탭으로도 main 목록으로도 돌아오지 않는다.
  await expect(page.locator(`.ttab[data-session-id="${gone}"]`)).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator(`.ttab[data-session-id="${keep}"]`)).toHaveCount(1)
  await expect.poll(async () => (await sessionList(page)).length, { timeout: 15_000 }).toBe(1)
})

// DETACH-7 취소하면 아무 일도 없다 — 창도 세션도 그대로다.
test('DETACH-7 닫기를 취소하면 창이 그대로 남는다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })

  await askClose(win)
  await dialogCancel(win)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1)
  expect((await sessionList(page)).length).toBe(1)
})

// DETACH-8★ 탭을 **창 밖에** 끌어다 놓으면 새 창이 뜬다(2026-08-22 준영님 제보 4·31).
// 진짜 OS 드래그는 자동화로 못 한다 — 브라우저가 드래그 끝에 원본 탭으로 보내는 그 이벤트를
// 그대로 만든다: 아무도 받지 않았고(dropEffect 'none'), 커서는 창 밖(화면 좌표).
// 그 두 값을 읽는 규칙 자체는 tests/tabDetach.test.ts 가 따로 본다.
test('DETACH-8★ 탭을 창 밖에 놓으면 새 창으로 떼어낸다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const opened = ara.app.waitForEvent('window')
  const at = await pointOutsideWindows(ara.app)

  await page.locator(`.ttab[data-session-id="${a}"]`).evaluate((el, p) => {
    el.dispatchEvent(
      new DragEvent('dragend', {
        bubbles: true,
        dataTransfer: new DataTransfer(), // dropEffect 기본값이 'none' — 아무도 안 받은 상태 그대로다
        screenX: p.x,
        screenY: p.y
      })
    )
  }, at)

  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(0)
  expect((await sessionList(page)).length).toBe(1) // 세션은 죽지 않았다
})

// DETACH-9★ **받는 자리가 아니면 전부 새 창**(2026-08-23 준영님 제보 5 — 규칙이 뒤집혔다).
// 크롬과 같다: 탭 줄과 페이지(우리는 터미널 칸)만 받고, 사이드바·하단바·상태바·다른 앱 위·
// 바탕화면은 전부 창이 된다. 그전에는 "창 밖 좌표 + 아무도 안 받음"으로 쟀는데, 다른 앱이 텍스트
// 드롭을 받아 버려서 **바탕화면에서만** 창이 떴다.
test('DETACH-9★ 사이드바에 놓아도 새 창이 뜬다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const opened = ara.app.waitForEvent('window')

  // 창 **안**(사이드바 자리)에 놓는다 — 받는 자리가 아니므로 새 창이 맞다.
  await page.locator(`.ttab[data-session-id="${a}"]`).evaluate((el) => {
    el.dispatchEvent(
      new DragEvent('dragend', {
        bubbles: true,
        // 다른 앱이 받아 준 경우까지 흉내 낸다: dropEffect 가 'none' 이 아니어도 새 창이어야 한다.
        dataTransfer: Object.assign(new DataTransfer(), { dropEffect: 'move' }),
        screenX: window.screenX + 40,
        screenY: window.screenY + Math.floor(window.outerHeight / 2)
      })
    )
  })

  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(0)
})

// DETACH-9b 탭바·터미널 칸에 놓은 것은 그 자리가 처리한다 — 새 창이 뜨면 안 된다.
test('DETACH-9b 탭바에 놓으면 새 창이 뜨지 않는다(순서 바꾸기)', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  const b = await newLocalShell(page)
  const before = ara.app.windows().length

  // 탭바가 drop 을 처리하면 그 표시가 남고, 뒤이은 dragend 는 새 창을 만들지 않는다.
  await page.locator('.term-tabbar .tt-scroll').evaluate((el, id) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', id)
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    document.querySelector(`.ttab[data-session-id="${id}"]`)!.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: dt, screenX: 0, screenY: 0 })
    )
  }, b)

  await page.waitForTimeout(700)
  expect(ara.app.windows().length).toBe(before)
  await expect(page.locator('.ttab')).toHaveCount(2)
})

// DETACH-10 떼어낸 창에서 **또** 밖으로 끌어내면 세 번째 창으로 간다.
// 메뉴로 "떼어내기"를 다시 누르면 그 창을 앞으로 가져올 뿐이지만(같은 뜻이라), 끌어다 놓은 것은
// "저기에 두겠다"는 다른 뜻이다. 옛 창에 껍데기 탭이 남지 않는 것까지 본다.
test('DETACH-10 떼어낸 창에서 다시 끌어내면 또 다른 창으로 간다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const first = await detachTab(ara, a)
  await expect(first.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })

  const opened = ara.app.waitForEvent('window')
  const at = await pointOutsideWindows(ara.app)
  await first.locator(`.ttab[data-session-id="${a}"]`).evaluate((el, p) => {
    el.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer(), screenX: p.x, screenY: p.y })
    )
  }, at)

  const second = await opened
  await second.waitForLoadState('domcontentloaded')
  await expect(second.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  // 첫 창은 빈 창이 되어 스스로 닫힌다 — 남아 있더라도 그 탭은 없어야 한다.
  if (!first.isClosed()) await expect(first.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(0)
  expect((await sessionList(page)).length).toBe(1)
})

// ── 2026-08-23 크롬식 창 관리 — 탭을 **다른 창으로** 옮긴다 ─────────────────────────────
// 준영님: "크롬처럼 창 관리를 하게 해줘." 창 밖에 놓으면 새 창(DETACH-8), **다른 창의 탭바에
// 놓으면 그 창으로 합쳐진다** — 이게 나머지 절반이다.

/** 그 창의 탭바 위로 세션 하나를 끌고 간다(놓지는 않는다) — 받아 줄 것인지 표시가 뜨는 자리. */
async function dragTabOver(win: Page, sessionId: string): Promise<void> {
  await win.locator('.term-tabbar .tt-scroll').evaluate((el, id) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', id)
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, sessionId)
}

/** 그 창의 탭바에 세션 하나를 떨어뜨린다(진짜 창 사이 드래그는 자동화로 못 한다 — 받는 쪽이
 *  실제로 보는 것은 text/plain 하나뿐이라 그것만 만들어 준다). */
async function dropTabOn(win: Page, sessionId: string): Promise<void> {
  await dragTabOver(win, sessionId)
  await win.locator('.term-tabbar .tt-scroll').evaluate((el, id) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', id)
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, sessionId)
}

// DETACH-11★ 떼어낸 창의 탭을 **본창 탭바**에 놓으면 본창으로 돌아온다(그리고 빈 창은 닫힌다).
test('DETACH-11★ 다른 창의 탭바에 놓으면 그 창으로 합쳐진다', async ({ ara }) => {
  const { page } = ara
  const keep = await newLocalShell(page)
  const moved = await newLocalShell(page)
  const win = await detachTab(ara, moved)
  await expect(win.locator(`.ttab[data-session-id="${moved}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('.ttab')).toHaveCount(1) // 본창엔 keep 하나만 남아 있다

  // 끌고 오는 동안 "여기 놓으면 받는다"가 보인다(놓기 전 표시 — 크롬의 삽입 자리에 해당).
  await dragTabOver(page, moved)
  await expect(page.locator('.term-tabbar .tt-scroll.adopting')).toHaveCount(1)

  await dropTabOn(page, moved)
  await expect(page.locator('.term-tabbar .tt-scroll.adopting')).toHaveCount(0) // 놓으면 걷힌다

  // 본창이 받았다 — 탭이 둘, 받은 탭이 활성(크롬도 끌어다 놓은 탭을 띄운다).
  await expect(page.locator(`.ttab[data-session-id="${moved}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('.ttab.active')).toHaveAttribute('data-session-id', moved)
  await expect(page.locator('.ttab')).toHaveCount(2)
  // 빈 창은 스스로 닫힌다(마지막 탭이 떠났다).
  await expect.poll(() => win.isClosed(), { timeout: 15_000 }).toBe(true)
  // 세션은 둘 다 살아 있다 — 옮긴 것이지 다시 만든 것이 아니다.
  expect((await sessionList(page)).length).toBe(2)
  expect(keep).not.toBe(moved)
})

// DETACH-12 본창 → 떼어낸 창 방향도 같다. 창을 두 개 띄워 놓고 오가는 것이 목적이니 한쪽만
// 되면 반쪽이다.
test('DETACH-12 본창 탭을 떼어낸 창으로 보낸다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const b = await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator('.ttab')).toHaveCount(1, { timeout: 15_000 })

  await dropTabOn(win, b)

  await expect(win.locator(`.ttab[data-session-id="${b}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(win.locator('.ttab')).toHaveCount(2)
  await expect(page.locator('.ttab')).toHaveCount(0) // 본창은 비었다(창은 남는다 — 본창이니까)
  expect((await sessionList(page)).length).toBe(2)
})

// DETACH-13 자기 창 탭바에 자기 탭을 놓는 것은 **순서 바꾸기**다 — 병합 경로로 새지 않는다.
test('DETACH-13 자기 탭을 자기 탭바에 놓으면 순서만 바뀐다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const b = await newLocalShell(page)
  await expect(page.locator('.ttab')).toHaveCount(2)

  await dropTabOn(page, a) // 이미 이 창 것 → 가져올 것이 없다
  await expect(page.locator('.ttab')).toHaveCount(2)
  expect((await sessionList(page)).length).toBe(2)
  expect(a).not.toBe(b)
})

/**
 * DETACH-14★ 되돌리기가 **RDP 탭을 지우지 않는다**(2026-09-01 준영님 제보 ②).
 *
 * 되돌리기는 `session:moved` → refreshFromMain 을 태우는데, 그것이 이 창의 목록을 main 스냅샷으로
 * 통째로 덮었다. RDP 세션은 pty 가 없어 main 에 없다 → 목록에서 사라지고 → RdpView 가 언마운트되며
 * 릴레이까지 끊겼다. **터미널만 멀쩡했던 이유가 그 차이다** — 그래서 검사도 둘을 한 화면에 둔다.
 *
 * 붙을 RDP 서버는 없다(릴레이가 곧 실패한다). 상관없다 — 이 결함은 접속 상태와 무관하게
 * "탭이 목록에서 빠지는가"이고, 그것이 곧 화면이 사라지는 경로다.
 */
test('DETACH-14★ 떼어낸 창을 되돌려도 본창의 RDP 탭이 살아 있다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  // 연결 관리자에서 RDP 프로필 만들기 — rdp.spec.ts 와 같은 절차를 로컬에 다시 둔다
  // (이 파일의 관례: 공유 파일(fixtures)은 건드리지 않는다).
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await page.click('.modal .prof-list .pl-add')
  await page.click('.prof-form .seg-ctl button:has-text("RDP")')
  const field = (label: string) => page.locator(`.prof-form .fld:has(> label:text-is("${label}")) input`).first()
  await field('연결 이름').fill('rdp-detach')
  await field('호스트').fill('127.0.0.1')
  await field('사용자').fill('dev')
  await page.click('.modal-ft .btn.pri') // [저장 후 접속] — 저장 즉시 내장 뷰가 뜬다
  await expect(connModal(page)).toHaveCount(0, { timeout: 15_000 })
  const rdpTab = page.locator('.ttab[data-session-id^="rdp:"]')
  await expect(rdpTab).toHaveCount(1, { timeout: 15_000 })

  // 셸만 떼어냈다 돌려보낸다. RDP 탭은 처음부터 끝까지 본창 것이다.
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(rdpTab).toHaveCount(1) // 떼어내기는 원래 멀쩡했다(그쪽은 목록을 덮지 않는다)
  await askClose(win)
  await expect(win.locator('.dlg-overlay .dlg-detail .dlg-row')).toHaveCount(1, { timeout: 15_000 })
  await dialogAlt(win) // [본창으로 보내기]

  await expect(page.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(rdpTab).toHaveCount(1) // ★ 예전엔 여기서 0 이 됐다
  await expect(page.locator('.rdp-view')).toHaveCount(1)
})

// DETACH-5 떼어낸 창에는 **연결 트리·설정이 없다**(준영님 확정 구성 "작업 창").
// 설정 드로어가 두 창에 동시에 뜨는 상태를 만들지 않는 것이 이 선택의 이유다.
test('DETACH-5 떼어낸 창은 작업 창이다 — 트리·설정이 없다', async ({ ara }) => {
  const { page } = ara
  const a = await newLocalShell(page)
  const win = await detachTab(ara, a)

  await expect(win.locator('.sidebar')).toHaveCount(0)
  // 2.0: 본창의 설정은 좌측 레일, 채팅은 타이틀바 [채팅] — 어느 클래스로도 이 창엔 없어야 한다.
  await expect(win.locator('[data-activity="settings"]')).toHaveCount(0)
  await expect(win.locator('[data-activity="ai"], .tb-chat')).toHaveCount(0)
  // 있어야 하는 것: 탭바 · 분할 그리드 · 하단바 토글.
  await expect(win.locator('.term-tabbar')).toHaveCount(1)
  await expect(win.locator('.pane-grid')).toHaveCount(1)
  await expect(win.locator('.act-bottombar')).toHaveCount(1)
})
