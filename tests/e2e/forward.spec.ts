// W2 F8 자동 포트포워딩 — [모니터] 탭 행에서 터널을 만들고, 배지로 끄고, [열기]로 내장 브라우저까지.
// 원격은 ssh2 루프백 하네스다(exec = 포트 목록, direct-tcpip = 터널 목적지) — 실서버 접속 없음(DLP).
import { test, expect, connectNewSshProfile, dialogConfirm, makeTcpip, makeTelemetry, newLocalShell, openBottomTool, portRow, portRows, portsListing, reservedPort, type TcpipHarness, type TeleHarness, windowInfos } from './fixtures'
import type { Locator, Page } from '@playwright/test'

// 이 파일이 쓰는 ssh 팩토리 옵션만(전체 opts 타입을 끌고 오지 않는다 — monitor.spec.ts 와 같은 방식).
type SshFactory = (opts?: {
  password?: string
  execHandler?: TeleHarness['exec']
  tcpipHandler?: TcpipHarness['handler']
}) => Promise<{ port: number }>

// 행·목적지 셀렉터는 fixtures 의 공용 헬퍼로 모았다(2026-08-22 #106) — 포트 목록이 카드에서
// **표**로 바뀌었는데 이 파일만 옛 `.prow`/`.pfwd` 를 보고 있었다.
const rowFor = (page: Page, port: number): Locator => portRow(page, port)
/** 그 행의 "내 PC 에서 열린 주소" 칸 — 포워딩이 있으면 localhost:NNNN, 없으면 `.none`(—). */
const destOf = (row: Locator): Locator => row.locator('td.pt-dest .pdest:not(.none)')

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
  await openBottomTool(page, 'monitor')
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
  await expect(destOf(row)).toHaveCount(0)
  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)

  await row.locator('[data-action="forward.create"]').click()
  await expect(destOf(row)).toHaveCount(1, { timeout: 15_000 })
  // 표로 바뀌면서 목적지는 배지 글리프가 아니라 **주소 그대로** 적힌다(가로가 넉넉해졌다).
  await expect(destOf(row)).toHaveText(`localhost:${remote}`)
  await expect(destOf(row).locator('.pwarn')).toHaveCount(0) // 번호가 그대로면 경고가 없다

  const list = await page.evaluate(() => window.ev.forward.list())
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ sessionId, remotePort: remote, localPort: remote, exact: true })
  // 주소는 화면에 그대로 있다 — 예전처럼 툴팁에 숨기지 않는다.
})

// FWD-2 배지 클릭 = 해제(확인 다이얼로그 없음 — 되돌리기가 1클릭이다)
test('FWD-2 배지를 누르면 포워딩이 해제된다', async ({ ara, ssh }) => {
  const { page } = ara
  const remote = await reservedPort(2)
  const { row } = await monitorRow(page, ssh, 'fwd2', remote)
  await row.locator('[data-action="forward.create"]').click()
  await expect(destOf(row)).toHaveCount(1, { timeout: 15_000 })

  // 해제는 이제 행 오른쪽 [터널 끊기] 버튼이다(배지 클릭이 아니라) — [닫기]는 창만 닫으므로
  // 터널을 끊는 자리가 따로 있어야 한다.
  await row.locator('[data-action="forward.stop"]').click()
  await expect(destOf(row)).toHaveCount(0, { timeout: 15_000 })
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
  await openBottomTool(page, 'monitor')
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
  const dest = destOf(row)
  await expect(dest).toHaveCount(1, { timeout: 15_000 })
  await expect(dest.locator('.pwarn')).toHaveCount(1) // "요청한 번호가 아니다"를 말한다

  const list = await page.evaluate(() => window.ev.forward.list())
  expect(list).toHaveLength(1)
  expect(list[0].exact).toBe(false)
  expect(list[0].localPort).not.toBe(remote)
  await expect(dest).toContainText(`localhost:${list[0].localPort}`)
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
  await expect(destOf(row)).toHaveCount(1, { timeout: 15_000 })

  // 브라우저 창의 **제목은 고정**이다('A.R.A 브라우저') — 원격 페이지는 그 안의 탭(WebContentsView)에
  // 살고 창 자체는 우리 탭 줄이라 file: 주소다. 예전엔 창 하나에 페이지 하나여서 제목·주소로
  // 확인했는데, 탭이 생기면서 그 단서가 창 밖으로 옮겨 갔다(2026-08-22 #106).
  await expect.poll(async () => (await windowInfos(app)).map((w) => w.title), { timeout: 25_000 }).toContain(
    'A.R.A 브라우저'
  )
  // "그 주소가 지금 떠 있다"는 포트 행이 안다 — 버튼이 [열기]에서 [닫기]로 뒤집힌다(제보 1번).
  await expect(row.locator('[data-action="browser.close"]')).toHaveCount(1, { timeout: 15_000 })

  // 프로토콜 레벨 증거: 요청이 실제로 원격 127.0.0.1:<remotePort> 로 나갔다.
  // 탭이 생기는 것(위)과 그 탭이 실제로 요청을 보내는 것은 한 박자 떨어져 있다 — 기다렸다 본다.
  await expect.poll(() => tcpip.hits.length, { timeout: 20_000 }).toBeGreaterThan(0)
  expect(tcpip.hits[0]).toEqual({ destIP: '127.0.0.1', destPort: remote })
})
