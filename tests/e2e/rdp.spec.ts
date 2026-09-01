// RDP 프로필(src/renderer/components/ConnectionModal.tsx, ConnTree.tsx,
// src/main/ipc/registerRdpIpc.ts) — SSH/RDP 전환 · 트리 배지 · 축소 메뉴 · 내장 뷰 진입 · 복제.
//
// 2026-08-09: `rdp:launch`(mstsc 외부 실행)를 통째로 걷어냈다(A-40 — 준영님 "쓸 이유 없다"). 전에는
// 실제 mstsc 실행을 막으려 main 핸들러를 스텁으로 바꿔치기했는데, 이제 **채널 자체가 없어** 스텁이
// 필요 없다. RDP-6 은 "안 불렀다"가 아니라 "부를 수 없다"를 판정한다 — 더 강한 조건이다.
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, connModal, sessionIds, connectNewSshProfile, openConnTab } from './fixtures'

/** main 에 그 invoke 채널이 등록돼 있는가. 등록돼 있지 않으면 렌더러가 부를 방법이 없다. */
async function hasInvokeChannel(app: ElectronApplication, channel: string): Promise<boolean> {
  return app.evaluate(async ({ ipcMain }, ch) => {
    // 등록 여부를 직접 물을 API 가 없다 — 같은 이름으로 한 번 더 handle() 하면 이미 있을 때만 던진다.
    try {
      ipcMain.handle(ch, () => null)
    } catch {
      return true
    }
    ipcMain.removeHandler(ch) // 우리가 방금 심은 것은 걷어낸다
    return false
  }, channel)
}

// 라벨로 폼 입력칸을 찾는다(fixtures.ts 의 field() 와 같은 규칙 — 공유 파일은 건드리지 않고 로컬에 다시 둔다).
function field(page: Page, label: string) {
  return page.locator(`.prof-form .fld:has(> label:text-is("${label}")) input`).first()
}

// 연결 관리자에서 RDP 프로필을 새로 만들고 [저장 후 접속] 까지 누른다.
// 저장 즉시 내장 뷰가 뜬다(릴레이는 붙을 서버가 없어 곧 실패한다 — 여기서 보는 것은 그 앞단이다).
async function createRdpProfile(
  page: Page,
  f: { name: string; host?: string; port?: string; username?: string }
): Promise<void> {
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await page.click('.modal .prof-list .pl-add') // ＋ 새 프로필(2026-08-19 목록 아래로 옮겼다)
  await page.click('.prof-form .seg-ctl button:has-text("RDP")')
  await field(page, '연결 이름').fill(f.name)
  await field(page, '호스트').fill(f.host ?? '127.0.0.1')
  if (f.port) await field(page, '포트').fill(f.port)
  await field(page, '사용자').fill(f.username ?? 'dev')
  await page.click('.modal-ft .btn.pri')
  await expect(connModal(page)).toHaveCount(0, { timeout: 15_000 })
}

const srvNode = (page: Page, name: string) => page.locator(`.tree .srv-node:has(.sname:text-is("${name}"))`)

// RDP-1 유형을 RDP 로 바꾸면 인증 방식 선택이 사라지고(비밀번호뿐) 기본 포트가 3389 로 바뀐다.
// 2026-08-08: RDP 도 비밀번호를 저장할 수 있게 되어 [인증] 섹션 자체는 남는다 — 사라지는 것은
// "키/비밀번호" 방식 선택과 개인키 필드다.
test('RDP-1 유형을 RDP 로 바꾸면 인증 방식 선택이 사라지고 포트가 3389 로 바뀐다', async ({ ara }) => {
  const { page } = ara
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await expect(page.locator('.pf-sec-t:has-text("인증")')).toBeVisible()
  await expect(field(page, '포트')).toHaveValue('22')
  await expect(page.locator('.prof-form .seg-ctl button:has-text("비밀번호")')).toBeVisible()
  await page.click('.prof-form .seg-ctl button:has-text("RDP")')
  // 인증 섹션은 남고(비밀번호 저장용) 방식 선택 버튼만 사라진다.
  await expect(page.locator('.pf-sec-t:has-text("인증")')).toBeVisible()
  await expect(page.locator('.prof-form .seg-ctl button:has-text("비밀번호")')).toHaveCount(0)
  await expect(page.locator('.pf-hint')).toBeVisible()
  await expect(field(page, '포트')).toHaveValue('3389')
})

// RDP-3 저장한 RDP 서버는 사이드바 트리에 RDP 배지가 붙는다
test('RDP-3 저장한 RDP 서버는 트리에 RDP 배지가 붙는다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-badge' })
  await expect(srvNode(ara.page, 'rdp-badge').locator('.tbadge.rdp')).toBeVisible()
})

// RDP-4★ RDP 서버 더블클릭은 앱 세션(pty)을 만들지 않는다 — RDP 는 터미널 세션이 아니다(부정 조건)
test('RDP-4★ RDP 서버 더블클릭은 세션을 만들지 않는다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-launch' })
  const before = await sessionIds(ara.page)
  await srvNode(ara.page, 'rdp-launch').dblclick()
  await ara.page.waitForTimeout(1000) // 세션이 생긴다면 이 안에 생긴다 — 생기지 않는다는 것을 확인한다.
  expect(await sessionIds(ara.page)).toEqual(before)
})

// RDP-5 RDP 서버 우클릭 메뉴는 SSH 서버 메뉴보다 축소판이다(새 세션·호스트키 재설정 없음)
test('RDP-5 RDP 트리 메뉴는 새 세션·호스트키 재설정이 빠진 축소판이다', async ({ ara, ssh }) => {
  await createRdpProfile(ara.page, { name: 'rdp-menu' })
  const h = await ssh({ password: 'pw-rdp5' })
  await connectNewSshProfile(ara.page, { name: 'ssh-menu', port: h.port, password: 'pw-rdp5' })
  await openConnTab(ara.page)

  await srvNode(ara.page, 'ssh-menu').click({ button: 'right' })
  const sshActions = await ara.page.locator('.ctx-menu .ctx-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))
  // FB-monitor: 활성 SSH 세션이 있는 행에는 tmux 서브메뉴가 항목 맨 끝에 덧붙는다(RDP엔 안 붙는다 — 아래).
  // 2026-08-17(#95): [AI CLI 시작]이 **세션 행**으로 옮겨갔다 — 서버 행에서 열면 폴더를 다시
  // 골라야 하지만 세션 행에는 그 세션이 서 있는 폴더가 이미 있다(TREE_MENUS 주석).
  expect(sshActions).toEqual([
    'server.connect',
    'server.newSession',
    'server.edit',
    'server.duplicate',
    'server.forgetHostKey',
    'server.delete',
    'session.tmux'
  ])
  await ara.page.keyboard.press('Escape')
  await expect(ara.page.locator('.ctx-menu')).toHaveCount(0)

  await srvNode(ara.page, 'rdp-menu').click({ button: 'right' })
  const rdpActions = await ara.page.locator('.ctx-menu .ctx-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))
  expect(rdpActions).toEqual(['server.connect', 'server.edit', 'server.duplicate', 'server.delete'])
})

// RDP-6 더블클릭은 **앱 내장 뷰**를 열고 OS 클라이언트로는 갈 수 없다.
// 원래는 mstsc 실행 실패를 다이얼로그로 알리는 테스트였다. F25 로 진입점이 사라졌고(그때는 "안 부른다"를
// 셌다), 2026-08-09 A-40 결정으로 채널까지 없앴다 — 이제 "부를 수 없다"를 판정한다.
test('RDP-6 RDP 더블클릭은 앱 내장 뷰를 열고 OS 클라이언트를 실행하지 않는다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-inapp' })
  await srvNode(ara.page, 'rdp-inapp').dblclick()
  await expect(ara.page.locator('.rdp-view')).toBeVisible({ timeout: 15_000 })
  expect(await hasInvokeChannel(ara.app, 'rdp:launch')).toBe(false)
})

// RDP-8 RDP 서버 복제로 RDP 타입 사본이 만들어진다
test('RDP-8 RDP 서버를 복제하면 RDP 타입 사본이 생긴다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-dup' })
  await srvNode(ara.page, 'rdp-dup').click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="server.duplicate"]')
  await expect(srvNode(ara.page, 'rdp-dup 사본').locator('.tbadge.rdp')).toBeVisible({ timeout: 10_000 })
})

// ── 다중 모니터(2026-08-09) ───────────────────────────────────────────────────
// 검증 PC 는 모니터가 한 장이라 "여러 장에 걸친다"는 눈으로 볼 수 없다. 대신 **기계장치**를 본다:
// 창이 계산한 자리에 뜨는가 · 그 창이 #rdpwin 경로로 들어가는가 · 같은 서버를 두 번 펼치지 않는가.
// 실제 두 장 이상에서의 모습은 수동(RDPV-21).

type WinInfo = { url: string; bounds: { x: number; y: number; width: number; height: number } }

async function spanWindows(app: ElectronApplication): Promise<WinInfo[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().includes('rdpwin'))
      .map((w) => ({ url: w.webContents.getURL(), bounds: w.getBounds() }))
  )
}

// 렌더러의 "모니터 한 장이면 안 연다" 가드는 store/rdpSpanOpen.ts 에 있다(단위로 검증됨).
// 여기서는 그 가드를 지나 IPC 를 직접 불러 **창 자체**를 본다.
const profileIdByName = (page: Page, name: string): Promise<string> =>
  page.evaluate(async (n) => {
    const list = await window.ev.profile.list()
    return (list.find((p) => p.name === n)?.id as string) ?? ''
  }, name)


// 창 크기·좌표는 **정확히 같은 값으로 단정하지 않는다.** 분수 배율(이 PC 는 1707x1067 @ 1.5 배)에서는
// 1707 * 1.5 = 2560.5 처럼 정수 픽셀로 안 떨어져, DIP 로 되돌아올 때 1~2 어긋난다(2026-08-13 확인).
// 검사가 지키려는 뜻 — "주 모니터를 덮는다" · "크기가 복원된다" — 은 그 오차로 흔들리지 않는다.
const GEOM_TOL = 2
/** 오차 안이면 기대값으로 맞춰 준다 — poll 로 재시도하면서도 diff 는 읽을 수 있게 하려는 것이다. */
const snap = (actual: number, expected: number): number => (Math.abs(actual - expected) <= GEOM_TOL ? expected : actual)

// RDPV-21 다중 모니터 창이 주 모니터를 덮는 자리에 뜨고 #rdpwin 으로 들어간다.
test('RDPV-21 다중 모니터 창이 주 모니터를 덮는 자리에 뜬다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-span' })
  const id = await profileIdByName(ara.page, 'rdp-span')
  expect(id).not.toBe('')

  const res = await ara.page.evaluate((pid) => window.ev.rdp.openSpan(pid, 'rdp-span', []), id)
  expect(res.ok).toBe(true)

  await expect.poll(() => spanWindows(ara.app).then((w) => w.length), { timeout: 15_000 }).toBe(1)
  const wins = await spanWindows(ara.app)
  expect(wins[0].url).toContain('#rdpwin')
  // 계산한 원격 크기가 해시에 실린다 — 창의 렌더러가 이 값으로 접속한다.
  expect(wins[0].url).toMatch(/[?&]w=\d+/)
  expect(wins[0].url).toMatch(/[?&]h=\d+/)

  // 이 창은 **주 모니터 한 장**을 덮는다(나머지 모니터는 렌더러가 자식 창으로 연다 —
  // store/rdpMirror.ts). 작업표시줄까지 덮어야 하므로 작업 영역이 아니라 bounds 와 같아야 한다.
  const primary = await ara.app.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay()
    return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
  })
  // **재시도를 유지한 채** 허용 오차를 준다. 오차만 넣고 한 번만 읽었더니 창이 자리를 잡기 전에
  // 재던 순간이 있어 전체 스위트에서만 빨갰다(2026-08-13 — 단독 실행에서는 늘 통과해 더 헷갈렸다).
  await expect
    .poll(
      async () => {
        const b = (await spanWindows(ara.app))[0]?.bounds
        return b ? { x: b.x, y: b.y, width: snap(b.width, primary.width), height: snap(b.height, primary.height) } : null
      },
      { timeout: 10_000 }
    )
    .toEqual(primary)

  await ara.page.evaluate((pid) => window.ev.rdp.closeSpan(pid), id)
  await expect.poll(() => spanWindows(ara.app).then((w) => w.length)).toBe(0)
})

// RDPV-22 같은 서버를 두 번 펼치지 않는다 — 같은 계정으로 두 번 붙으면 서버가 앞 세션을 끊는다.
test('RDPV-22 같은 서버를 두 번 펼치면 창이 늘지 않는다', async ({ ara }) => {
  await createRdpProfile(ara.page, { name: 'rdp-span2' })
  const id = await profileIdByName(ara.page, 'rdp-span2')
  expect((await ara.page.evaluate((pid) => window.ev.rdp.openSpan(pid, 'rdp-span2', []), id)).ok).toBe(true)
  await expect.poll(() => spanWindows(ara.app).then((w) => w.length), { timeout: 15_000 }).toBe(1)
  const second = await ara.page.evaluate((pid) => window.ev.rdp.openSpan(pid, 'rdp-span2', []), id)
  expect(second.ok).toBe(false)
  expect(await spanWindows(ara.app)).toHaveLength(1)

  await ara.page.evaluate((pid) => window.ev.rdp.closeSpan(pid), id)
  await expect.poll(() => spanWindows(ara.app).then((w) => w.length)).toBe(0)
})

// RDPV-23 모니터가 한 장이면 [다중 모니터] 버튼은 창을 열지 않고 안내만 한다.
test('RDPV-23 모니터가 한 장이면 펼치지 않는다', async ({ ara }) => {
  const only = await ara.app.evaluate(({ screen }) => screen.getAllDisplays().length)
  test.skip(only > 1, '모니터가 여러 장인 환경 — 이 가드는 한 장일 때만 검증된다')

  await createRdpProfile(ara.page, { name: 'rdp-span3' })
  await srvNode(ara.page, 'rdp-span3').dblclick()
  await expect(ara.page.locator('.rdp-view')).toBeVisible({ timeout: 15_000 })
  // 2026-09-01: 헤더 버튼 여섯이 [옵션] 한 자리로 접혔다(좁은 창 줄바꿈·잘림) — [다중 모니터]도
  // 그 리스트 안에 있다. 버튼을 눌러 리스트를 연 뒤 항목을 고른다.
  await ara.page.click('.rdp-opt-btn')
  await ara.page.click('.ctx-menu .ctx-item[data-action="span"]')
  await expect(ara.page.locator('.pane-toast')).toBeVisible({ timeout: 5_000 })
  expect(await spanWindows(ara.app)).toHaveLength(0)
})
