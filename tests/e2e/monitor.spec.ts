// W1 F9 원격 포트 모니터 — 사이드바 [모니터] 탭의 리슨 포트 목록(2.5초 폴링 + 수동 새로고침).
// 원격 응답은 ssh2 루프백 하네스의 exec 채널이 만든다(실서버 접속 없음 — DLP).
import { test, expect, connectNewSshProfile, makeTelemetry, newLocalShell, portRows, showAllPorts, NETSTAT_OUT } from './fixtures'
import type { Page } from '@playwright/test'
import type { TeleHarness } from './fixtures'

// SSH 접속 → [모니터] 아이콘(우측 액티비티 바, FB-ui2 이관) → 목록이 그려질 때까지.
async function openMonitor(page: Page, port: number, password: string, name: string): Promise<string> {
  const id = await connectNewSshProfile(page, { name, port, password })
  await page.click('.act-item[data-activity="monitor"]')
  return id
}

// 픽스처 ssh 팩토리 중 이 파일이 쓰는 부분만(전체 opts 타입을 끌고 오지 않는다).
type SshFactory = (opts?: { password?: string; execHandler?: TeleHarness['exec'] }) => Promise<{ port: number }>

async function connectWithTelemetry(
  page: Page,
  ssh: SshFactory,
  tele: TeleHarness,
  name: string
): Promise<string> {
  const pw = `pw-${name}`
  const h = await ssh({ password: pw, execHandler: tele.exec })
  return openMonitor(page, h.port, pw, name)
}

// MON-1 [모니터] 탭에 리슨 포트가 뜬다(포트·프로토콜·프로세스·PID)
test('MON-1 [모니터] 탭이 원격 리슨 포트를 보여 준다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon1')
  await showAllPorts(ara.page) // FB-0003: 기본은 "사용자 포트만" — 전체 파싱 결과를 보려면 전체 보기로.
  const rows = portRows(ara.page)
  await expect(rows).toHaveCount(6, { timeout: 30_000 })
  const first = rows.filter({ has: ara.page.locator('.pport:text-is("8080")') })
  await expect(first.locator('.pproto')).toHaveText('tcp')
  await expect(first.locator('.pproc')).toHaveText('node')
  await expect(first.locator('.ppid')).toHaveText('2451')
})

// MON-2 포트 번호 오름차순(사람이 포트를 찾는 순서)
test('MON-2 목록이 포트 번호 오름차순으로 정렬된다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon2')
  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  const ports = (await ara.page.locator('.pmon-list .prow .pport').allTextContents()).map(Number)
  expect(ports).toEqual([...ports].sort((a, b) => a - b))
  expect(ports).toEqual([22, 22, 443, 5432, 8080, 33060])
})

// MON-3 프로세스를 읽을 권한이 없어도 포트 행은 남는다
test('MON-3 권한 없는 소켓은 "권한 없음"으로 표시하고 행은 남긴다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon3')
  const row = portRows(ara.page).filter({ has: ara.page.locator('.pport:text-is("33060")') })
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  await expect(row.locator('.pproc')).toHaveText('권한 없음')
  await expect(row.locator('.ppid')).toHaveText('')
})

// MON-4 IPv6 소켓은 tcp6 배지로 구분된다
test('MON-4 IPv6 리슨은 tcp6 배지로 구분된다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon4')
  await showAllPorts(ara.page) // tcp6 포트(22)는 시스템 포트라 기본값에서는 숨는다.
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  const v6 = ara.page.locator('.pmon-list .prow .pproto.v6')
  await expect(v6).toHaveCount(1)
  await expect(v6).toHaveText('tcp6')
})

// MON-5 수동 새로고침 — 폴링 주기(2.5초)를 기다리지 않고 즉시 한 바퀴
test('MON-5 새로고침 버튼이 폴링 주기를 기다리지 않고 갱신한다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon5')
  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  const before = tele.rounds()
  await ara.page.click('.pmon .sb-act')
  // 폴링 주기보다 짧은 창 안에 한 바퀴가 더 나가야 "즉시"다.
  await expect.poll(() => tele.rounds(), { timeout: 1_500, intervals: [100] }).toBeGreaterThan(before)
  await expect(portRows(ara.page)).toHaveCount(6)
})

// MON-6 사용자 조작 없이 폴링만으로 새 포트가 나타난다
test('MON-6 새로 열린 포트가 폴링으로 저절로 나타난다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon6')
  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  tele.state.ports +=
    'LISTEN 0      128          0.0.0.0:9090       0.0.0.0:*     users:(("grafana",pid=3300,fd=9))\n'
  await expect(portRows(ara.page)).toHaveCount(7, { timeout: 20_000 })
  await expect(
    portRows(ara.page).filter({ has: ara.page.locator('.pport:text-is("9090")') }).locator('.pproc')
  ).toHaveText('grafana')
})

// BOTTOM-1★ 하단 패널 — 포트·세션 기록이 터미널 아래로 내려왔다 (#78, 2026-08-15)
// 왜 옮겼나: 포트 목록은 주소·포트·프로세스 3열을, 세션 기록은 로그 한 줄을 280~340px **세로**
// 레일에 넣고 있었다. 같은 성격의 프로세스·서비스 표는 아예 레일을 포기하고 떠 있는 창으로
// 빠져나갔다 — 같은 문제를 두 방법으로 푼 셈이었다. 하단은 세로만 먹으니 터미널 80칸이 안 줄고,
// 그래서 **우측 레일과 같이 열려도 된다**(레일이 하나만 열리는 #79 규칙은 우측에만 적용).
test('BOTTOM-1★ 하단 패널이 탭으로 열리고 우측 레일과 같이 떠 있는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)

  await page.click('.act-item[data-activity="monitor"]')
  const bp = page.locator('.bottom-panel')
  await expect(bp).toBeVisible()
  await expect(bp.locator('.bp-tab.on')).toHaveAttribute('data-bottom', 'monitor')

  // 탭을 바꾸면 그 자리에서 갈린다(창이 새로 뜨지 않는다).
  await bp.locator('.bp-tab[data-bottom="log"]').click()
  await expect(bp.locator('.bp-tab.on')).toHaveAttribute('data-bottom', 'log')
  await expect(bp.locator('.log-panel.embedded')).toHaveCount(1)
  // 하단에 끼운 패널은 자기 제목줄을 안 그린다 — 그 자리는 하단 패널이 갖는다.
  await expect(bp.locator('.mon-name')).toHaveCount(0)

  // ★ 우측 레일과 **같이** 열린다 — 세로만 먹으니 터미널 폭에 영향이 없다.
  await page.click('.act-item[data-activity="preview"]')
  await expect(page.locator('.mini-rail')).toBeVisible()
  await expect(bp).toBeVisible()

  const dims = await page.evaluate(() => {
    const doc = document.documentElement
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect()
    return { overflowX: doc.scrollWidth - doc.clientWidth, grid: r('.pane-grid')?.height ?? 0, bp: r('.bottom-panel')?.height ?? 0 }
  })
  expect(dims.overflowX).toBeLessThanOrEqual(1)
  expect(dims.grid).toBeGreaterThan(50)
  expect(dims.bp).toBeGreaterThan(50)

  // 액티비티 바에서 같은 항목을 다시 누르면 닫힌다.
  await page.click('.act-item[data-activity="log"]')
  await expect(bp).toHaveCount(0)
})

// MON-7 로컬 세션에는 원격 포트가 없다 — 목록 대신 안내
test('MON-7 로컬 세션에서는 안내 문구만 보인다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await ara.page.click('.act-item[data-activity="monitor"]')
  // 이관 이력: 사이드바 탭(.sb-panel) → 우측 레일(.monitor-panel, FB-ui2) → **하단 패널**(#78).
  // 마지막 이동 이유: 주소·포트·프로세스 3열을 280px 세로 레일에 넣고 있었다.
  await expect(ara.page.locator('.bottom-panel .sb-placeholder')).toHaveText(
    'SSH 세션에서 원격 포트를 볼 수 있습니다'
  )
  await expect(portRows(ara.page)).toHaveCount(0)
})

// MON-8 세션을 바꾸면 목록도 그 서버의 것으로 갈린다
test('MON-8 세션을 전환하면 그 서버의 포트로 바뀐다', async ({ ara, ssh }) => {
  const { page } = ara
  const teleA = makeTelemetry()
  const idA = await connectWithTelemetry(page, ssh, teleA, 'monA')
  await showAllPorts(page) // PortMonitor 는 세션과 무관한 단일 인스턴스라 이 토글이 B→A 전환에도 유지된다.
  await expect(portRows(page)).toHaveCount(6, { timeout: 30_000 })

  // B 서버는 포트가 하나뿐이다.
  const teleB = makeTelemetry({
    ports: 'LISTEN 0      128          0.0.0.0:6379       0.0.0.0:*     users:(("redis",pid=77,fd=6))\n'
  })
  const hB = await ssh({ password: 'pw-monB', execHandler: teleB.exec })
  const idB = await connectNewSshProfile(page, { name: 'monB', port: hB.port, password: 'pw-monB' })

  await expect(portRows(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(portRows(page).locator('.pport')).toHaveText('6379')

  // A 로 되돌아오면 A 의 목록. (B 폴링 중지는 tests/telemetry.test.ts '폴링 수명' 이 본다.)
  await page.locator(`.term-tabbar .ttab[data-session-id="${idA}"]`).click()
  await expect(portRows(page)).toHaveCount(6, { timeout: 20_000 })
  expect(idA).not.toBe(idB)
})

// MON-10 ss 가 없는 서버는 netstat 폴백 — 같은 목록이 나온다
test('MON-10 netstat 폴백 형식도 같은 목록으로 그려진다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ ports: NETSTAT_OUT })
  await connectWithTelemetry(ara.page, ssh, tele, 'mon10')
  await showAllPorts(ara.page) // 22·443 은 시스템 포트라 기본값에서는 5432 하나만 보인다.
  await expect(portRows(ara.page)).toHaveCount(3, { timeout: 30_000 })
  expect(await ara.page.locator('.pmon-list .prow .pport').allTextContents()).toEqual(['22', '443', '5432'])
  await expect(
    portRows(ara.page).filter({ has: ara.page.locator('.pport:text-is("443")') }).locator('.pproto')
  ).toHaveClass(/v6/)
})

// MON-11 파싱할 수 없는 응답이 와도 앱은 멀쩡하다(빈 목록 + 안내)
test('MON-11 쓰레기 응답에도 앱이 죽지 않고 빈 목록을 보여 준다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ ports: 'ss: command not found\n???\n' })
  await connectWithTelemetry(ara.page, ssh, tele, 'mon11')
  await expect(ara.page.locator('.pmon-list .sftp-empty')).toHaveText('리슨 중인 포트가 없습니다', {
    timeout: 30_000
  })
  await expect(portRows(ara.page)).toHaveCount(0)
  // 앱은 계속 동작한다 — 오류 배너도, 크래시도 없다.
  await expect(ara.page.locator('.app')).toBeVisible()
  await expect(ara.page.locator('.dlg-overlay')).toHaveCount(0)
})

// MON-12 행 클릭은 아무 일도 하지 않는다(표시 전용 — 포트 포워딩은 Wave 2 F8)
//
// 2026-08-10: 판정을 innerHTML 통째 비교에서 **보이는 내용 비교**로 바꿨다. 전역 툴팁(store/tooltip.ts)이
// hover 450ms 뒤 `title` 을 떼어 `data-tip` 으로 옮기는데(네이티브 툴팁 억제), 클릭은 곧 hover 라
// 500ms 시점의 innerHTML 이 반드시 달라진다 — 화면에 보이는 것은 하나도 안 변했는데도 실패했다.
// 이 테스트가 지키려는 것은 "눌러도 아무 일이 안 일어난다"이지 속성 한 글자까지가 아니다.
test('MON-12 포트 행을 눌러도 아무 일도 일어나지 않는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon12')
  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  const snap = (): Promise<string[]> => portRows(ara.page).allInnerTexts()
  const before = await snap()
  await portRows(ara.page).first().click()
  await ara.page.waitForTimeout(500)
  // 행 수·내용 그대로 · 포워딩 배지 안 생김 · 메뉴/다이얼로그 안 뜸
  expect(await snap()).toEqual(before)
  await expect(ara.page.locator('.bottom-panel .pmon .pfwd')).toHaveCount(0)
  await expect(ara.page.locator('.dlg-overlay, .ctx-menu')).toHaveCount(0)
})

// MON-13 FB-0003: 기본값은 "사용자 포트만" — 시스템 포트(22·22·443)는 숨고 감춘 개수가 보인다.
test('MON-13 기본값은 사용자 포트만 보여주고 감춘 개수를 알려준다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon13')
  await expect(portRows(ara.page)).toHaveCount(3, { timeout: 30_000 })
  expect(await ara.page.locator('.pmon-list .prow .pport').allTextContents()).toEqual(['5432', '8080', '33060'])
  await expect(ara.page.locator('.pmon-hidden')).toHaveText('3개 숨김')
  await expect(ara.page.locator('.pmon-range button[data-value="user"]')).toHaveClass(/on/)
})

// MON-14 검색 — 포트 번호·프로세스명 부분일치, 필터가 이미 걸러낸 것 안에서만 찾는다.
test('MON-14 검색어로 포트 번호·프로세스명을 찾는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon14')
  await expect(portRows(ara.page)).toHaveCount(3, { timeout: 30_000 })

  await ara.page.fill('.pmon .sb-search input', '80')
  await expect(portRows(ara.page)).toHaveCount(1)
  await expect(portRows(ara.page).locator('.pport')).toHaveText('8080')

  await ara.page.fill('.pmon .sb-search input', 'postgres')
  await expect(portRows(ara.page)).toHaveCount(1)
  await expect(portRows(ara.page).locator('.pport')).toHaveText('5432')

  // 시스템 포트(sshd·22)는 기본 범위 필터가 이미 걸러냈다 — 검색해도 나오지 않는다.
  await ara.page.fill('.pmon .sb-search input', 'sshd')
  await expect(portRows(ara.page)).toHaveCount(0)
  await expect(ara.page.locator('.pmon-list .sftp-empty')).toHaveText('검색·필터 결과가 없습니다')

  await ara.page.fill('.pmon .sb-search input', '')
  await expect(portRows(ara.page)).toHaveCount(3)
})

// MON-15 범위 토글 — 전체 보기로 바꾸면 감춘 개수 안내가 사라지고 전부 보인다.
test('MON-15 전체 보기로 바꾸면 시스템 포트도 보이고 숨김 안내가 사라진다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon15')
  await expect(portRows(ara.page)).toHaveCount(3, { timeout: 30_000 })

  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6)
  await expect(ara.page.locator('.pmon-hidden')).toHaveCount(0)
  await expect(ara.page.locator('.pmon-range button[data-value="all"]')).toHaveClass(/on/)

  await ara.page.click('.pmon-range button[data-value="user"]')
  await expect(portRows(ara.page)).toHaveCount(3)
  await expect(ara.page.locator('.pmon-hidden')).toHaveText('3개 숨김')
})
