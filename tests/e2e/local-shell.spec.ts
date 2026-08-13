// 로컬 셸 (스펙 AC #2, #5 / F2 · R1 · R3 · FIX-ux1)
import {
  test,
  expect,
  dialogConfirm,
  newLocalShell,
  runCommand,
  sessionList,
  termText,
  expectTermText,
  openConnTab
} from './fixtures'

// LOCAL-1 탭바 ＋ 클릭으로 로컬 셸을 연다(원클릭, UI-tabbar)
test('LOCAL-1 탭바 ＋ → 로컬 셸이 열리고 탭·패널·상태바가 함께 생긴다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.pane-grid .pane')).toHaveCount(0)
  await newLocalShell(page)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(1)
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
  await expect(page.locator('.statusbar .sb-right .sb-seg').first().locator('.val')).toHaveText('1')
})

// LOCAL-2 는 "가운데 빈 상태 안내 버튼" 자체가 없어져 폐기됐다 — scenarios.md 에 사유 기록(UI-tabbar).

// LOCAL-3 Ctrl+Shift+T 로 세션을 추가한다(탭만 늘고 패널은 교체)
test('LOCAL-3 Ctrl+Shift+T 로 새 세션을 추가한다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.keyboard.press('Control+Shift+T')
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(2)
  // 패널은 1개 — 새 세션이 포커스 패널을 차지한다(분할이 아니다).
  await expect(page.locator('.pane-grid .pane')).toHaveCount(1)
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveCount(1)
})

// LOCAL-4 한글 입출력 무결(스펙 AC #5)
test('LOCAL-4 한글 명령·출력이 깨지지 않는다', async ({ ara }) => {
  const id = await newLocalShell(ara.page)
  await runCommand(ara.page, id, 'echo 한글출력_무결성_확인')
  await expectTermText(ara.page, id, /한글출력_무결성_확인/)
  // 유니코드 11 폭 계산(R3.4) — 한글이 2칸으로 계산돼야 표·박스가 어긋나지 않는다.
  const unicode = await ara.page.evaluate((sid) => window.__evTerm(sid)?.unicode, id)
  expect(unicode).toBe('11')
})

// LOCAL-5 창 리사이즈 후에도 출력이 유지된다(conpty 리플로우 차단 — FIX-ux1)
test('LOCAL-5 창을 좁혀도 로컬 셸 출력이 깨지지 않는다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await runCommand(page, id, 'echo 리사이즈_기준선')
  await expectTermText(page, id, /리사이즈_기준선/)

  // 로컬 셸은 conpty 리플로우를 끈다(windowsMode) — 원격 pty 에는 적용하지 않는다.
  if (process.platform === 'win32') {
    expect(await page.evaluate((sid) => window.__evTerm(sid)?.windowsMode, id)).toBe(true)
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(820, 900)
  })
  await page.waitForTimeout(1200)
  expect(await termText(page, id)).toMatch(/리사이즈_기준선/)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 900)
  })
  await page.waitForTimeout(800)
  expect(await termText(page, id)).toMatch(/리사이즈_기준선/)
})

// LOCAL-6 탭 × = 세션 종료 → 빈 상태로 복귀
test('LOCAL-6 탭 ×로 세션을 종료하면 패널도 함께 정리된다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.term-tabbar .ttab .tx')
  // 2026-08-11 준영님 결정: 로컬 셸도 종료 확인을 묻는다(예전엔 SSH 만 물었다).
  await dialogConfirm(page)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(0)
  await expect(page.locator('.pane-grid .pane')).toHaveCount(0)
  await expect.poll(async () => (await sessionList(page)).length).toBe(0)
})

// LOCAL-7 OSC7 셸 통합으로 cwd 가 추적되고 상태바에 뜬다
test('LOCAL-7 cd 하면 상태바 경로가 따라온다(OSC7)', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  const dir = process.platform === 'win32' ? 'C:/Windows' : '/tmp'
  await runCommand(page, id, `cd "${dir}"`)
  await expect(page.locator('.statusbar .sb-seg.cwd .val')).toContainText(
    process.platform === 'win32' ? 'Windows' : 'tmp',
    { timeout: 20_000 }
  )
  const sessions = await sessionList(page)
  expect((sessions[0].cwd ?? '').toLowerCase()).toContain(process.platform === 'win32' ? 'windows' : 'tmp')
})

// LOCAL-4 사이드바 하위 세션 표시 — 숫자 대신 세션 아이콘, 그리고 줄을 가르는 세로 줄기.
// 준영님 지적: "세션 숫자 대신 아이콘", "같은 서버 하위 세션별로 구분감이 없다".
// 로컬 그룹도 서버 그룹과 같은 .sess-list 를 쓰므로 여기서 함께 검증된다(SSH 하네스 불필요).
test('LOCAL-4 하위 세션은 숫자가 아니라 아이콘으로 표시되고 세로 줄기로 갈린다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await newLocalShell(page)
  await openConnTab(page)

  const rows = page.locator('.sess-list .sess-node')
  await expect(rows).toHaveCount(2)
  // 숫자 배지는 사라지고 세션 아이콘(Lucide svg)이 그 자리에 있다.
  await expect(page.locator('.sess-list .sess-node .sidx')).toHaveCount(0)
  await expect(page.locator('.sess-list .sess-node svg.sicon')).toHaveCount(2)

  // 줄기(세로선)가 실제로 그려진다 — 이게 "구분감"의 실체다.
  const guide = await page.locator('.sess-list').first().evaluate((el) => {
    const cs = getComputedStyle(el, '::before')
    return { w: cs.width, bg: cs.backgroundColor }
  })
  expect(guide.w).toBe('1px')
  expect(guide.bg).not.toBe('rgba(0, 0, 0, 0)')

  // 가지(가로 획)는 없어야 한다. 준영님 제보(2026-08-11): 바로 뒤 프롬프트 아이콘(❱_)과 붙어
  // `- >_` 로 읽혀 화살표처럼 보였다. 되살아나면 같은 착시가 돌아오므로 부재를 검증한다.
  const elbow = await rows.first().evaluate((el) => getComputedStyle(el, '::before').content)
  expect(elbow).toBe('none')
})
