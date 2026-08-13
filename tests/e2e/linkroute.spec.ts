// W2 F8 터미널 링크 라우팅 — 원격 셸이 찍은 `http://localhost:…` 의 localhost 는 **원격의** localhost 다.
// Ctrl+클릭이 그것을 포워딩 + 내장 브라우저로 보내고, 나머지는 예전처럼 OS 기본 브라우저로 보낸다.
//
// OS 브라우저는 절대 실제로 띄우지 않는다(spyShell 이 main 에서 가로챈다) — 검증 세션 오염 방지.
import {
  test,
  expect,
  browserWindows,
  connectNewSshProfile,
  ctrlClickLink,
  dialog,
  dialogConfirm,
  reservedPort,
  makeTcpip,
  newLocalShell,
  runCommand,
  sendInput,
  spyCalls,
  spyShell,
  windowInfos
} from './fixtures'
import type { Page } from '@playwright/test'

// D4(`agent_talk/FIX-w2sec-done.md`) 이후: oauth 링크는 포워딩을 만들기 **전에** 확인 다이얼로그를
// 띈다(어느 포트가 열리고 어디로 연결되는지 보여 준다) — 취소하면 forward.create 자체가 불리지 않는다.
async function confirmOauthDialog(page: Page, port: number, origin: string): Promise<void> {
  await expect(dialog(page)).toBeVisible({ timeout: 20_000 })
  await expect(dialog(page)).toContainText('이 링크는 원격 포트를 내 PC 로 엽니다')
  await expect(dialog(page).locator('.dlg-detail .dlg-v').nth(0)).toHaveText(String(port))
  await expect(dialog(page).locator('.dlg-detail .dlg-v').nth(1)).toHaveText(origin)
  await dialogConfirm(page)
}

// 원격 셸이 URL 을 화면에 찍게 한다(하네스는 받은 입력을 그대로 에코한다 — 원격이 출력한 것과 같다).
async function printRemote(page: Page, sessionId: string, url: string): Promise<void> {
  await sendInput(page, sessionId, url + '\r\n')
}

// LINK-1 SSH 세션의 loopback URL → 포워딩이 생기고 내장 브라우저가 터널 입구를 연다
test('LINK-1 원격 localhost 링크를 Ctrl+클릭하면 터널을 뚫고 내장 브라우저로 연다', async ({ ara, ssh }) => {
  const { page, app } = ara
  await spyShell(app)
  const tcpip = makeTcpip()
  const remote = await reservedPort(11)
  const h = await ssh({ password: 'pw-link1', tcpipHandler: tcpip.handler })
  const sid = await connectNewSshProfile(page, { name: 'link1', port: h.port, password: 'pw-link1' })

  const url = `http://localhost:${remote}/preview`
  await printRemote(page, sid, url)
  await ctrlClickLink(page, url)

  await expect.poll(() => page.evaluate(() => window.ev.forward.list()), { timeout: 20_000 }).toHaveLength(1)
  const fwd = (await page.evaluate(() => window.ev.forward.list()))[0]
  expect(fwd.remotePort).toBe(remote)

  // 창은 터널 입구(localhost:<localPort>)를 열고 경로는 원본 그대로 유지한다.
  await expect.poll(async () => (await browserWindows(app))[0]?.url ?? '', { timeout: 25_000 }).toContain(
    `http://localhost:${fwd.localPort}/preview`
  )
  expect(tcpip.hits[0]).toEqual({ destIP: '127.0.0.1', destPort: remote })
  // OS 기본 브라우저로는 새어 나가지 않았다.
  expect((await spyCalls(app)).external).toEqual([])
})

// LINK-2 로컬 셸의 localhost 는 진짜 내 PC 다 — 종전대로 OS 브라우저로 간다
test('LINK-2 로컬 셸의 localhost 링크는 OS 기본 브라우저로 간다', async ({ ara }) => {
  const { page, app } = ara
  await spyShell(app)
  const sid = await newLocalShell(page)
  const port = await reservedPort(12)
  const url = `http://localhost:${port}/local`
  await runCommand(page, sid, `echo ${url}`)
  await ctrlClickLink(page, url)

  await expect.poll(async () => (await spyCalls(app)).external, { timeout: 20_000 }).toEqual([url])
  expect(await browserWindows(app)).toHaveLength(0)
  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)
})

// LINK-3 loopback 이 아닌 주소는 SSH 세션에서도 OS 브라우저로 간다(터널을 팔 이유가 없다)
test('LINK-3 외부 https 링크는 OS 기본 브라우저로 간다', async ({ ara, ssh }) => {
  const { page, app } = ara
  await spyShell(app)
  const h = await ssh({ password: 'pw-link3' })
  const sid = await connectNewSshProfile(page, { name: 'link3', port: h.port, password: 'pw-link3' })

  const url = 'https://docs.example.com/guide'
  await printRemote(page, sid, url)
  await ctrlClickLink(page, url)

  await expect.poll(async () => (await spyCalls(app)).external, { timeout: 20_000 }).toEqual([url])
  expect(await browserWindows(app)).toHaveLength(0)
  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)
})

// OAUTH-1 인증 URL 안에 박힌 redirect_uri 의 콜백 포트를 **그 번호 그대로** 뚫고 원본 URL 을 연다.
// 인증 서버 역할은 연결이 거부되는 루프백 주소(127.0.0.2)가 맡는다 — 실제 외부 요청은 나가지 않는다.
//
// D4 이후: Ctrl+클릭은 먼저 확인 다이얼로그를 띄운다 — 열릴 로컬 포트·브라우저로 열 주소를 보여 주고
// 확인해야 그 다음(forward.create)으로 넘어간다.
test('OAUTH-1 redirect_uri 의 콜백 포트를 그대로 포워딩하고 원본 URL 을 연다', async ({ ara, ssh }) => {
  const { page, app } = ara
  await spyShell(app)
  const h = await ssh({ password: 'pw-oauth1' })
  const sid = await connectNewSshProfile(page, { name: 'oauth1', port: h.port, password: 'pw-oauth1' })

  const cb = await reservedPort(21)
  const url =
    `http://127.0.0.2:8080/o/oauth2/auth?client_id=cli&` +
    `redirect_uri=http%3A%2F%2Flocalhost%3A${cb}%2Fcallback`
  await printRemote(page, sid, url)
  await ctrlClickLink(page, url)
  await confirmOauthDialog(page, cb, 'http://127.0.0.2:8080')

  await expect.poll(() => page.evaluate(() => window.ev.forward.list()), { timeout: 20_000 }).toHaveLength(1)
  const fwd = (await page.evaluate(() => window.ev.forward.list()))[0]
  // 콜백은 그 번호로 돌아온다 — 임의 포트로 폴백하면 인증이 영영 끝나지 않는다.
  expect(fwd).toMatchObject({ sessionId: sid, remotePort: cb, localPort: cb, exact: true })

  // 창은 **원본** 인증 URL 을 연다(터널 입구가 아니다 — 리다이렉트가 그리로 돌아온다).
  await expect.poll(async () => (await browserWindows(app))[0]?.url ?? '', { timeout: 25_000 }).toBe(url)
  expect((await spyCalls(app)).external).toEqual([])
})

// OAUTH-2 콜백 포트가 이미 쓰이고 있으면 조용히 임의 포트로 넘어가지 않는다 — 왜 막혔는지 알린다.
// D4 확인 다이얼로그를 먼저 통과해야(연결하고 열기) forward.create 가 시도되고, 그제서야 실패 사유가 뜬다.
test('OAUTH-2 콜백 포트가 사용 중이면 창을 열지 않고 사유를 알린다', async ({ ara, ssh, holdPort }) => {
  const { page, app } = ara
  await spyShell(app)
  const h = await ssh({ password: 'pw-oauth2' })
  const sid = await connectNewSshProfile(page, { name: 'oauth2', port: h.port, password: 'pw-oauth2' })

  const cb = await holdPort(0) // 다른 프로그램이 콜백 포트를 물고 있는 상황
  const url =
    `http://127.0.0.2:8080/o/oauth2/auth?client_id=cli&` +
    `redirect_uri=http%3A%2F%2Flocalhost%3A${cb}%2Fcallback`
  await printRemote(page, sid, url)
  await ctrlClickLink(page, url)
  await confirmOauthDialog(page, cb, 'http://127.0.0.2:8080')

  await expect(dialog(page)).toBeVisible({ timeout: 20_000 })
  await expect(dialog(page)).toContainText('포트 포워딩을 만들 수 없습니다')
  await expect(dialog(page)).toContainText(`로컬 ${cb} 포트가 이미 사용 중입니다`)
  await expect(dialog(page).locator('.dlg-detail .dlg-v')).toHaveText(String(cb))

  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)
  expect(await windowInfos(app)).toHaveLength(1) // 내장 브라우저 창은 뜨지 않았다
  expect((await spyCalls(app)).external).toEqual([])
})

// OAUTH-3 ★(D4 신규) 확인 다이얼로그에서 취소하면 포워딩 자체를 시도하지 않고 아무것도 열리지 않는다
test('OAUTH-3 확인 다이얼로그를 취소하면 포워딩도 브라우저도 열리지 않는다', async ({ ara, ssh }) => {
  const { page, app } = ara
  await spyShell(app)
  const h = await ssh({ password: 'pw-oauth3' })
  const sid = await connectNewSshProfile(page, { name: 'oauth3', port: h.port, password: 'pw-oauth3' })

  const cb = await reservedPort(22)
  const url =
    `http://127.0.0.2:8080/o/oauth2/auth?client_id=cli&` +
    `redirect_uri=http%3A%2F%2Flocalhost%3A${cb}%2Fcallback`
  await printRemote(page, sid, url)
  await ctrlClickLink(page, url)

  await expect(dialog(page)).toBeVisible({ timeout: 20_000 })
  await dialog(page).locator('.modal-ft .btn.sec').click({ delay: 0 }) // 취소
  await expect(dialog(page)).toHaveCount(0)

  // forward.create 이전에 return 하므로 흔적이 전혀 없어야 한다.
  expect(await page.evaluate(() => window.ev.forward.list())).toHaveLength(0)
  expect(await windowInfos(app)).toHaveLength(1) // 내장 브라우저 창 없음(메인 창 하나뿐)
  expect((await spyCalls(app)).external).toEqual([])
})
