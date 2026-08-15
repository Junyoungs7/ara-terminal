// W2 F8 자동 포트포워딩 — [모니터] 탭 행에서 터널을 만들고, 배지로 끄고, [열기]로 내장 브라우저까지.
// 원격은 ssh2 루프백 하네스다(exec = 포트 목록, direct-tcpip = 터널 목적지) — 실서버 접속 없음(DLP).
import {
  test,
  expect,
  browserWindows,
  connectNewSshProfile,
  dialogConfirm,
  reservedPort,
  makeTcpip,
  makeTelemetry,
  newLocalShell,
  portsListing,
  portRows,
  windowInfos,
  type TcpipHarness,
  type TeleHarness
} from './fixtures'
import type { Locator, Page } from '@playwright/test'

// 이 파일이 쓰는 ssh 팩토리 옵션만(전체 opts 타입을 끌고 오지 않는다 — monitor.spec.ts 와 같은 방식).
type SshFactory = (opts?: {
  password?: string
  execHandler?: TeleHarness['exec']
  tcpipHandler?: TcpipHarness['handler']
}) => Promise<{ port: number }>

const rowFor = (page: Page, port: number): Locator =>
  page.locator('.pmon-list .prow').filter({ has: page.locator(`.pport:text-is("${port}")`) })

// SSH 접속 → [모니터] 아이콘(우측 액티비티 바, FB-ui2 이관) → 그 포트 행이 그려질 때까지. 원격이 듣고
// 있는 포트 하나만 광고한다.
async function monitorRow(
  page: Page,
  ssh: SshFactory,
  name: string,
  remotePort: number,
  tcpip?: TcpipHarness
): Promise<{ sessionId: string; row: Locator }> {
  const password = `pw-${name}`
  const tele = makeTelemetry({ ports: portsListing(remotePort) })
  const h = await ssh({ password, execHandler: tele.exec, tcpipHandler: tcpip?.handler })
  const sessionId = await connectNewSshProfile(page, { name, port: h.port, password })
  await page.click('.act-item[data-activity="monitor"]')
  const row = rowFor(page, remotePort)
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  return { sessionId, row }
}

// FWD-1 행 [↗] 을 눌러야 터널이 생긴다(폴링이 포트를 발견했다고 저절로 열리지 않는다)
test('FWD-1 포트 행에서 포워딩을 만들면 요청한 번호로 열린다', async ({ ara, ssh }) => {
  const { page } = ara
  const remote = await reservedPort(1)
  const { sessionId, row } = await monitorRow(page, ssh, 'fwd1', remote)

  // 목록에 떠 있는 것만으로는 아무것도 열리지 않는다.
  await expect(row.locator('.pfwd')).toHaveCount(0)
  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)

  await row.locator('[data-action="forward.create"]').click()
  await expect(row.locator('.pfwd')).toHaveCount(1, { timeout: 15_000 })
  await expect(row.locator('.pfwd')).toHaveText('⇄') // 번호가 같으면 글리프만(사이드바가 좁다)
  await expect(row.locator('.pfwd')).not.toHaveClass(/warn/)

  const list = await page.evaluate(() => window.ev.forward.list())
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ sessionId, remotePort: remote, localPort: remote, exact: true })
  // 행 툴팁이 목적지를 들고 있다(배지를 줄인 대신).
  // hover 중이면 title 이 data-tip 으로 옮겨가 있다(전역 툴팁).
  await expect.poll(() => row.evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '')).toMatch(
    new RegExp(`localhost:${remote}`)
  )
})

// FWD-2 배지 클릭 = 해제(확인 다이얼로그 없음 — 되돌리기가 1클릭이다)
test('FWD-2 배지를 누르면 포워딩이 해제된다', async ({ ara, ssh }) => {
  const { page } = ara
  const remote = await reservedPort(2)
  const { row } = await monitorRow(page, ssh, 'fwd2', remote)
  await row.locator('[data-action="forward.create"]').click()
  await expect(row.locator('.pfwd')).toHaveCount(1, { timeout: 15_000 })

  await row.locator('.pfwd').click()
  await expect(row.locator('.pfwd')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.dlg-overlay')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.ev.forward.list())).toHaveLength(0)
  // 다시 [↗] 버튼으로 돌아온다.
  await expect(row.locator('[data-action="forward.create"]')).toHaveCount(1)
})

// FWD-4 탭 ×로 세션을 닫으면 그 세션의 터널도 함께 접힌다(리스너가 남지 않는다)
test('FWD-4 세션을 종료하면 포워딩이 정리된다', async ({ ara, ssh }) => {
  const { page } = ara
  const remote = await reservedPort(3)
  const { row } = await monitorRow(page, ssh, 'fwd4', remote)
  await row.locator('[data-action="forward.create"]').click()
  await expect.poll(() => page.evaluate(() => window.ev.forward.list())).toHaveLength(1)

  await page.click('.term-tabbar .ttab .tx')
  // SSH 세션은 탭 ×에 확인을 묻는다("연결이 끊기고 원격 작업도 중단됩니다"). 로컬 셸은 안 묻는다 —
  // 그래서 같은 모양인 LOCAL-6 는 통과하고 여기만 죽었다. 확인 없이는 오버레이가 탭을 덮어 클릭도 안 먹는다.
  await dialogConfirm(page)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.ev.forward.list()), { timeout: 20_000 }).toHaveLength(0)
})

// FWD-5 로컬 셸에는 원격 포트가 없다 — 포워딩 UI 자체가 뜨지 않는다
test('FWD-5 로컬 세션에는 포워딩 버튼이 없다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.act-item[data-activity="monitor"]')
  await expect(page.locator('.bottom-panel .sb-placeholder')).toBeVisible() // #78: 포트는 하단 패널
  await expect(portRows(page)).toHaveCount(0)
  await expect(page.locator('[data-action="forward.create"], [data-action="forward.open"]')).toHaveCount(0)
})

// FWD-6 그 번호가 이미 쓰이고 있으면 임의 포트로 열고 **그 사실을 표시한다**(조용히 넘어가지 않는다)
test('FWD-6 로컬 포트가 사용 중이면 다른 번호로 열고 배지에 알린다', async ({ ara, ssh, holdPort }) => {
  const { page } = ara
  const remote = await holdPort(0) // 테스트가 그 번호를 선점한 채로 시작한다
  const { row } = await monitorRow(page, ssh, 'fwd6', remote)

  await row.locator('[data-action="forward.create"]').click()
  const badge = row.locator('.pfwd')
  await expect(badge).toHaveCount(1, { timeout: 15_000 })
  await expect(badge).toHaveClass(/warn/)

  const list = await page.evaluate(() => window.ev.forward.list())
  expect(list).toHaveLength(1)
  expect(list[0].exact).toBe(false)
  expect(list[0].localPort).not.toBe(remote)
  await expect(badge).toHaveText(`⇄ :${list[0].localPort}`)
})

// BRW-1 [열기] → 내장 브라우저 창이 뜨고 제목은 오리진, 페이지는 **터널 너머** 원격이 그린다.
// 창 내부 보안 불변식(window.ev 부재·sandbox·전용 파티션 …)은 `npm run w2:browser` 가 담당한다.
test('BRW-1 [열기]가 터널 너머 페이지를 내장 브라우저로 띄운다', async ({ ara, ssh }) => {
  const { page, app } = ara
  const remote = await reservedPort(5)
  const tcpip = makeTcpip()
  const { row } = await monitorRow(page, ssh, 'brw1', remote, tcpip)
  // [열기]는 이제 **한 번**이다: 포워딩이 없으면 만들고 곧바로 브라우저를 연다(준영님 제보로 합친 UX
  // — PortMonitor.openPort). 예전 2단계(만들기 → 열기)를 전제하던 순서라 창 개수 단언이 어긋났다.
  expect(await windowInfos(app)).toHaveLength(1) // 클릭 전 — 아직 메인 창뿐
  await row.locator('[data-action="forward.create"]').click()
  await expect(row.locator('.pfwd')).toHaveCount(1, { timeout: 15_000 })

  const origin = `http://localhost:${remote}`
  await expect
    .poll(async () => (await browserWindows(app))[0]?.title ?? '', { timeout: 25_000 })
    .toContain(origin)
  const win = (await browserWindows(app))[0]
  expect(win.url).toContain(origin)
  expect(win.title).toContain('A.R.A 브라우저')

  // 프로토콜 레벨 증거: 요청이 실제로 원격 127.0.0.1:<remotePort> 로 나갔다.
  expect(tcpip.hits.length).toBeGreaterThan(0)
  expect(tcpip.hits[0]).toEqual({ destIP: '127.0.0.1', destPort: remote })
})
