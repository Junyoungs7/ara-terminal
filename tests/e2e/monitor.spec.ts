// W1 F9 원격 포트 모니터 — 사이드바 [모니터] 탭의 리슨 포트 목록(2.5초 폴링 + 수동 새로고침).
// 원격 응답은 ssh2 루프백 하네스의 exec 채널이 만든다(실서버 접속 없음 — DLP).
import {
  test,
  expect,
  NETSTAT_OUT,
  connectNewSshProfile,
  makeTelemetry,
  newLocalShell,
  openBottomTool,
  portNumbers,
  portRow,
  portRows,
  dialog,
  dialogCancel,
  dialogConfirm
} from './fixtures'
import type { Page } from '@playwright/test'
import type { TeleHarness } from './fixtures'

// SSH 접속 → [모니터] 아이콘(우측 액티비티 바, FB-ui2 이관) → 목록이 그려질 때까지.
async function openMonitor(page: Page, port: number, password: string, name: string): Promise<string> {
  const id = await connectNewSshProfile(page, { name, port, password })
  await openBottomTool(page, 'monitor')
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
  const rows = portRows(ara.page)
  await expect(rows).toHaveCount(5, { timeout: 30_000 })
  const first = rows.filter({ has: ara.page.locator('td.pt-port:text-is("8080")') })
  await expect(first.locator('td.pt-proto')).toHaveText('tcp')
  await expect(first.locator('td.pt-proc')).toHaveText('node')
  await expect(first.locator('td.pt-pid')).toHaveText('2451')
})

// MON-2 포트 번호 오름차순(사람이 포트를 찾는 순서)
test('MON-2 목록이 포트 번호 오름차순으로 정렬된다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon2')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  const ports = await portNumbers(ara.page)
  expect(ports).toEqual([...ports].sort((a, b) => a - b))
  // 22 는 tcp·tcp6 두 소켓이지만 **같은 프로세스라 한 행**이다(mergeProtos).
  expect(ports).toEqual([22, 443, 5432, 8080, 33060])
})

// MON-3 프로세스를 읽을 권한이 없어도 포트 행은 남는다
test('MON-3 권한 없는 소켓은 "권한 없음"으로 표시하고 행은 남긴다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon3')
  const row = portRows(ara.page).filter({ has: ara.page.locator('td.pt-port:text-is("33060")') })
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  await expect(row.locator('td.pt-proc')).toHaveText('권한 없음')
  await expect(row.locator('td.pt-pid')).toHaveText('—') // 없는 값은 빈칸이 아니라 대시로 그린다
})

// MON-4 IPv6 소켓은 tcp6 배지로 구분된다
test('MON-4 IPv6 리슨은 tcp6 배지로 구분된다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon4')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  // tcp6 는 이제 배지가 아니라 프로토콜 칸의 글자다 — 같은 포트의 두 소켓이 한 행으로 합쳐지면서
  // "어느 스택으로 떴는가"를 `tcp · tcp6` 로 함께 적는다(방화벽·바인드를 볼 때 그게 답이다).
  await expect(portRow(ara.page, 22).locator('td.pt-proto')).toHaveText('tcp · tcp6')
})

// MON-5 수동 새로고침 — 폴링 주기(2.5초)를 기다리지 않고 즉시 한 바퀴
test('MON-5 새로고침 버튼이 폴링 주기를 기다리지 않고 갱신한다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon5')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  const before = tele.rounds()
  await ara.page.click('.pmon [data-action="mon.refresh"]')
  // 폴링 주기보다 짧은 창 안에 한 바퀴가 더 나가야 "즉시"다.
  await expect.poll(() => tele.rounds(), { timeout: 1_500, intervals: [100] }).toBeGreaterThan(before)
  await expect(portRows(ara.page)).toHaveCount(5)
})

// MON-6 사용자 조작 없이 폴링만으로 새 포트가 나타난다
test('MON-6 새로 열린 포트가 폴링으로 저절로 나타난다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon6')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  tele.state.ports +=
    'LISTEN 0      128          0.0.0.0:9090       0.0.0.0:*     users:(("grafana",pid=3300,fd=9))\n'
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 20_000 })
  await expect(portRow(ara.page, 9090).locator('td.pt-proc')).toHaveText('grafana')
})

// BOTTOM-1★ 하단 패널 — 포트·세션 기록이 터미널 아래로 내려왔다 (#78, 2026-08-15)
// 왜 옮겼나: 포트 목록은 주소·포트·프로세스 3열을, 세션 기록은 로그 한 줄을 280~340px **세로**
// 레일에 넣고 있었다. 같은 성격의 프로세스·서비스 표는 아예 레일을 포기하고 떠 있는 창으로
// 빠져나갔다 — 같은 문제를 두 방법으로 푼 셈이었다. 하단은 세로만 먹으니 터미널 80칸이 안 줄고,
// 그래서 **우측 레일과 같이 열려도 된다**(레일이 하나만 열리는 #79 규칙은 우측에만 적용).
test('BOTTOM-1★ 하단 패널이 탭으로 열리고 우측 레일과 같이 떠 있는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)

  await openBottomTool(page, 'monitor')
  const bp = page.locator('.bottom-panel')
  await expect(bp).toBeVisible()
  await expect(bp.locator('.bp-tab.on')).toHaveAttribute('data-bottom', 'monitor')

  // 탭을 바꾸면 그 자리에서 갈린다(창이 새로 뜨지 않는다).
  await bp.locator('.bp-tab[data-bottom="log"]').click()
  await expect(bp.locator('.bp-tab.on')).toHaveAttribute('data-bottom', 'log')
  await expect(bp.locator('.log-panel.embedded')).toHaveCount(1)
  // 하단에 끼운 패널은 자기 제목줄을 안 그린다 — 그 자리는 하단 패널이 갖는다.
  await expect(bp.locator('.mon-name')).toHaveCount(0)

  // #83: 셋째 탭 — 시스템 모니터. 서버 자원이라 여기로 내려왔다(§4.8).
  await bp.locator('.bp-tab[data-bottom="sys"]').click()
  await expect(bp.locator('.monitor-panel.sysm.embedded')).toHaveCount(1)
  await expect(bp.locator('.mon-name')).toHaveCount(0)
  await expect(bp.locator('.log-panel')).toHaveCount(0) // 탭을 떠난 쪽은 그리지 않는다

  // ★ 우측 레일과 **같이** 열린다 — 세로만 먹으니 터미널 폭에 영향이 없다.
  //   (2.0: 미리보기가 지워져 오른쪽 레일은 [채팅] 하나다 — 그것을 연다.)
  await page.click('.tb-chat')
  await expect(page.locator('.ara-panel')).toBeVisible()
  await expect(bp).toBeVisible()

  const dims = await page.evaluate(() => {
    const doc = document.documentElement
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect()
    return { overflowX: doc.scrollWidth - doc.clientWidth, grid: r('.pane-grid')?.height ?? 0, bp: r('.bottom-panel')?.height ?? 0 }
  })
  expect(dims.overflowX).toBeLessThanOrEqual(1)
  expect(dims.grid).toBeGreaterThan(50)
  expect(dims.bp).toBeGreaterThan(50)

  // 하단바는 **덮는다** — 터미널 그리드 높이가 열기 전후로 같다(제보 ④).
  // (전에는 형제로 자리를 나눠 열 때마다 분할 칸이 찌그러졌다.)
  await expect(bp).toBeVisible()

  // 끄는 자리는 좌측 레일 [서버 도구] 토글(2.0) — 누르면 탭줄까지 통째로 사라진다.
  await page.click('.lrail-item[data-activity="bottombar"]')
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
})

// MON-7 로컬 세션에는 원격 포트가 없다 — 목록 대신 안내
test('MON-7 로컬 세션에서는 안내 문구만 보인다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await openBottomTool(ara.page, 'monitor')
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
  await expect(portRows(page)).toHaveCount(5, { timeout: 30_000 })

  // B 서버는 포트가 하나뿐이다.
  const teleB = makeTelemetry({
    ports: 'LISTEN 0      128          0.0.0.0:6379       0.0.0.0:*     users:(("redis",pid=77,fd=6))\n'
  })
  const hB = await ssh({ password: 'pw-monB', execHandler: teleB.exec })
  const idB = await connectNewSshProfile(page, { name: 'monB', port: hB.port, password: 'pw-monB' })

  await expect(portRows(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(portRows(page).locator('td.pt-port')).toHaveText('6379')

  // A 로 되돌아오면 A 의 목록. (B 폴링 중지는 tests/telemetry.test.ts '폴링 수명' 이 본다.)
  await page.locator(`.term-tabbar .ttab[data-session-id="${idA}"]`).click()
  await expect(portRows(page)).toHaveCount(5, { timeout: 20_000 })
  expect(idA).not.toBe(idB)
})

// MON-10 ss 가 없는 서버는 netstat 폴백 — 같은 목록이 나온다
test('MON-10 netstat 폴백 형식도 같은 목록으로 그려진다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ ports: NETSTAT_OUT })
  await connectWithTelemetry(ara.page, ssh, tele, 'mon10')
  await expect(portRows(ara.page)).toHaveCount(3, { timeout: 30_000 })
  expect(await portNumbers(ara.page)).toEqual([22, 443, 5432])
  await expect(portRow(ara.page, 443).locator('td.pt-proto')).toHaveText('tcp6')
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
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  const snap = (): Promise<string[]> => portRows(ara.page).allInnerTexts()
  const before = await snap()
  await portRows(ara.page).first().click()
  await ara.page.waitForTimeout(500)
  // 행 수·내용 그대로 · 포워딩 배지 안 생김 · 메뉴/다이얼로그 안 뜸
  expect(await snap()).toEqual(before)
  // 포워딩이 생기면 목적지 칸에 localhost:NNNN 이 뜬다 — 눌렀다고 생기면 안 된다.
  await expect(ara.page.locator('.bottom-panel .pmon .pdest:not(.none)')).toHaveCount(0)
  await expect(ara.page.locator('.dlg-overlay, .ctx-menu')).toHaveCount(0)
})

// MON-13 범위 입력 — 2026-08-18 에 [사용자 포트|전체] 세그를 **걷고** min–max 입력으로 바꿨다.
// 앱이 1024 라는 경계를 정해 놓고 그 아래를 기본으로 감췄는데, 정작 자주 찾는 22·443 이 거기
// 있었다. 이제 기본은 **전부 보여 주고**, 좁힐지는 사용자가 숫자로 정한다.
test('MON-13 기본은 전부 보여 주고, 범위를 입력하면 그만큼만 남는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon13')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })

  const spans = ara.page.locator('.pmon .pspan')
  await spans.first().fill('1024')
  await expect(portRows(ara.page)).toHaveCount(3)
  expect(await portNumbers(ara.page)).toEqual([5432, 8080, 33060])

  await spans.last().fill('9000')
  await expect(portRows(ara.page)).toHaveCount(2)
  expect(await portNumbers(ara.page)).toEqual([5432, 8080])

  // 비우면 제한이 풀린다(0 이 아니라 "제한 없음"이다).
  await spans.first().fill('')
  await spans.last().fill('')
  await expect(portRows(ara.page)).toHaveCount(5)
})

// MON-14 검색 — 포트 번호·프로세스명 부분일치.
test('MON-14 검색어로 포트 번호·프로세스명을 찾는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon14')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })

  await ara.page.fill('.pmon .sb-search input', '80')
  await expect(portRows(ara.page)).toHaveCount(1)
  // 번호 칸에는 `web` 배지가 함께 산다(8080·443 처럼 브라우저로 열어 볼 만한 포트) — 숫자만 본다.
  expect(await portNumbers(ara.page)).toEqual([8080])

  await ara.page.fill('.pmon .sb-search input', 'postgres')
  await expect(portRows(ara.page)).toHaveCount(1)
  expect(await portNumbers(ara.page)).toEqual([5432])

  // 시스템 포트도 이제 목록에 있다 — 검색으로 찾을 수 있어야 한다(그게 세그를 걷은 이유다).
  await ara.page.fill('.pmon .sb-search input', 'sshd')
  await expect(portRows(ara.page)).toHaveCount(1) // 22 tcp·tcp6 는 한 행이다

  await ara.page.fill('.pmon .sb-search input', '없는프로세스')
  await expect(portRows(ara.page)).toHaveCount(0)
  await expect(ara.page.locator('.pmon-list .sftp-empty')).toHaveText('검색·필터 결과가 없습니다')

  await ara.page.fill('.pmon .sb-search input', '')
  await expect(portRows(ara.page)).toHaveCount(5)
})

// MON-15 검색과 범위는 **함께** 좁힌다(AND) — 좁히는 도구지 넓히는 도구가 아니다.
test('MON-15 검색과 범위가 함께 걸린다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'mon15')
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })

  await ara.page.locator('.pmon .pspan').first().fill('1024')
  await ara.page.fill('.pmon .sb-search input', '2')
  // 1024 이상 **그리고** '2' 포함 → 5432 하나. 22 도 '2' 지만 범위 밖이라 빠진다(둘은 AND 다).
  expect(await portNumbers(ara.page)).toEqual([5432])
})

/**
 * MON-16★ 포트 행의 **[로그]** — 백그라운드 서버의 출력을 찾아 띄운다(2026-08-27 준영님 요청).
 *
 * > *"원격 서버에서 ai가 백그라운드로 띄운 서버의 로그를 실시간으로"*
 *
 * 갈래는 WSL 실측으로 정했다(`/proc/<pid>/fd/1`): 파일이면 그대로, tmux 면 pipe-pane 을 걸어
 * 파일을 만든 뒤, 그 밖이면 **원리상 못 본다**. 여기서는 세 갈래가 화면에서 각각 어떻게
 * 끝나는지를 본다 — 특히 **못 볼 때 빈손으로 돌려보내지 않는 것**이 중요하다.
 */
test('MON-16★ [로그] — 파일이면 바로 열고, tmux 면 물어보고, 못 보면 이유를 말한다', async ({ ara, ssh }) => {
  const { page } = ara
  const tele = makeTelemetry()
  const { port } = await ssh({ password: 'pw', execHandler: tele.exec })
  await openMonitor(page, port, 'pw', 'logsrv')
  await expect(portRows(page).first()).toBeVisible()

  // ① stdout 이 파일 → **[서버 로그] 탭**으로 넘어가며 뷰어가 뜬다(2026-08-27: 예전에는
  //    하단바를 덮는 오버레이였다 — "로그를 보면서 하단바를 못 쓴다"는 제보로 탭이 됐다).
  tele.state.trace = 'pid=2451\nfd1=/srv/app/out.log\npane=\ncmd=node server.js'
  await portRow(page, 8080).locator('[data-action="port.log"]').click()
  await expect(page.locator('.bp-tab.on[data-bottom="applog"]')).toBeVisible()
  await expect(page.locator('.logview')).toBeVisible()
  await expect(page.locator('.logview')).toContainText('out.log')

  // ★ 로그를 켜 둔 채 다른 탭으로 갔다 와도 그대로 있다 — 이것이 탭으로 내린 이유다.
  await openBottomTool(page, 'monitor')
  await expect(portRows(page).first()).toBeVisible()
  await openBottomTool(page, 'applog')
  await expect(page.locator('.logview')).toContainText('out.log')
  await page.locator('.logview .lv-head button').last().click() // [×] = 이 로그만 닫는다
  await openBottomTool(page, 'monitor')

  // ② tmux → 남의 팬을 건드리므로 **묻는다.** 취소하면 아무 일도 없다.
  tele.state.trace = 'pid=2451\nfd1=/dev/pts/6\npane=dev:0.1\ncmd=npm run dev'
  await portRow(page, 8080).locator('[data-action="port.log"]').click()
  await expect(dialog(page)).toContainText('tmux')
  await dialogCancel(page)
  await expect(page.locator('.logview')).toHaveCount(0)
  expect(tele.state.piped).toBeUndefined() // 취소했으면 명령이 나가지 않는다

  // 확인하면 pipe-pane 이 나가고 그 파일이 열린다.
  await portRow(page, 8080).locator('[data-action="port.log"]').click()
  await dialogConfirm(page)
  await expect(page.locator('.logview')).toBeVisible()
  expect(tele.state.piped).toContain("pipe-pane -o -t 'dev:0.1'")
  await page.locator('.logview .lv-head button').last().click()
  await openBottomTool(page, 'monitor')

  // ③ /dev/null → **못 본다.** 빈손으로 돌려보내지 않고 왜인지와 다음 수를 말한다.
  tele.state.trace = 'pid=2451\nfd1=/dev/null\npane=\ncmd=node server.js'
  await portRow(page, 8080).locator('[data-action="port.log"]').click()
  await expect(dialog(page)).toContainText('버리도록')
  await expect(dialog(page)).toContainText('2>&1')
  await dialogConfirm(page)
  await expect(page.locator('.logview')).toHaveCount(0)
})

/**
 * MON-17 [서버 로그] 탭의 입력칸 — 포트 표를 거치지 않고 **직접** 친다(2026-08-27 준영님 추가 요청:
 * *"여기에도 포트 번호를 치면 바로 연결되게"*). 경로를 알고 있으면 경로도 그대로 받는다.
 */
test('MON-17★ [서버 로그] 탭에 포트/경로를 직접 쳐도 같은 길로 열린다', async ({ ara, ssh }) => {
  const { page } = ara
  const tele = makeTelemetry()
  const { port } = await ssh({ password: 'pw', execHandler: tele.exec })
  await openMonitor(page, port, 'pw', 'logbox')
  await expect(portRows(page).first()).toBeVisible()
  await openBottomTool(page, 'applog')

  // ① 포트 번호 → 추적해서 찾은 파일이 열린다(포트 행 [로그] 와 같은 갈래를 지난다).
  tele.state.trace = 'pid=771\nfd1=/var/log/uvicorn.log\npane=\ncmd=uvicorn app:main'
  await page.getByTestId('applog-target').fill('8000')
  await page.getByTestId('applog-target').press('Enter')
  await expect(page.locator('.logview')).toContainText('uvicorn.log')
  await page.locator('.logview .lv-head button').last().click()

  // ② 절대 경로 → 찾을 것이 없다. 그대로 연다.
  await page.getByTestId('applog-target').fill('/home/jun/app.log')
  await page.locator('[data-action="applog.open"]').click()
  await expect(page.locator('.logview')).toContainText('/home/jun/app.log')
  await page.locator('.logview .lv-head button').last().click()

  // ③ 포트도 경로도 아닌 것은 조용히 무시하지 않고 무엇을 넣어야 하는지 말한다.
  // Enter 로 낸다 — 실측(2026-08-27): 다이얼로그가 그 타건을 [확인]으로 받아 떴다 사라졌다.
  // Dialog 가 자기를 연 키를 한 틱 무시하게 고쳤고, 이 줄이 그 회귀를 잡는다.
  await page.getByTestId('applog-target').fill('app.log')
  await page.getByTestId('applog-target').press('Enter')
  await expect(dialog(page)).toContainText('절대 경로')
  await dialogConfirm(page)
  await expect(page.locator('.logview')).toHaveCount(0)
})
