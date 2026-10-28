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
  // 2.0: 오른쪽 첫 칸은 UTF-8 이다 — 세션 수 칸은 라벨로 집는다.
  await expect(page.locator('.statusbar .sb-right .sb-seg:has(.lbl:text-is("세션")) .val')).toHaveText('1')
})

// LOCAL-2★ 빈 화면 안내 (#66-8, 2026-08-14)
// 이력이 두 번 뒤집힌 자리라 무엇을 지키는 검사인지 적어 둔다:
//  · 원래 여기 [로컬 셸]/[SSH 연결] **버튼**이 있었다 → UI-tabbar(2026-08-04)에서 "탭바 ＋ 와
//    완전히 같은 경로라 중복"으로 제거. 그때 LOCAL-2 도 함께 폐기됐다.
//  · 2026-08-13 감사가 다시 지적했다 — 화면의 70% 가 **한 글자도 없이** 비어 있다.
// 그래서 지금 지키는 성질은 "버튼이 있다"가 아니라 **"안내 문구가 있고, 버튼은 없다"** 이다.
// 버튼이 다시 생기면 이 검사가 깨진다(중복 진입점 재발 방지).
test('LOCAL-2★ 세션이 없으면 빈 화면이 다음 할 일을 안내한다(버튼은 두지 않는다)', async ({ ara }) => {
  const { page } = ara
  const guide = page.locator('.pane-grid .pane-empty')
  await expect(guide).toBeVisible()
  await expect(guide.locator('h2')).toHaveText('열린 세션이 없습니다')
  // 진입점을 말로 가리킨다 — 실제 컨트롤은 탭바 ＋ 하나뿐이어야 한다.
  await expect(guide).toContainText('＋')
  await expect(guide.locator('button')).toHaveCount(0)
  // 단축키 세 줄(새 셸·연결 관리자·통합 검색)이 함께 보인다.
  await expect(guide.locator('.pe-keys kbd')).toHaveCount(3)
  await expect(guide.locator('.pe-keys')).toContainText('Ctrl Shift T')
  // 다듬기 R1(리뷰 B10): F1 은 숨긴 기능까지 찾는 길이라고 말한다.
  await expect(guide.locator('.pe-keys')).toContainText('F1 숨긴 기능까지 검색')

  // 세션이 생기면 사라지고, 마지막 세션을 닫으면 다시 나온다.
  await newLocalShell(page)
  await expect(guide).toHaveCount(0)
  await page.click('.term-tabbar .ttab .tx')
  await dialogConfirm(page)
  await expect(page.locator('.pane-grid .pane-empty')).toBeVisible()
})

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
  // 맨 앞자리는 숫자(구)도 아이콘(구)도 아닌 **타입 배지**다(2026-08-14 준영님 제안).
  // `>_` 아이콘은 모든 셸 세션이 같아 아무 말도 안 했고, 타입은 행 끝에서 따로 말하고 있었다.
  await expect(page.locator('.sess-list .sess-node .sidx')).toHaveCount(0)
  await expect(page.locator('.sess-list .sess-node svg.sicon')).toHaveCount(0)
  await expect(page.locator('.sess-list .sess-node .sess-type')).toHaveCount(2)
  // 로컬 셸이므로 SYS.
  expect(await page.locator('.sess-list .sess-node .sess-type').allInnerTexts()).toEqual(['SYS', 'SYS'])

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
