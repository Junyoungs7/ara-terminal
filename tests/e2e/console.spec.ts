// F26 서버 콘솔 — 런치패드에서 프로세스 창을 열고, 정렬·검색하고, 행을 골라 종료하기까지.
// 원격 응답은 ssh2 루프백 하네스의 exec 채널이 만든다(실서버 접속 없음 — DLP).
//
// 이 파일이 지키는 가장 중요한 성질은 CON-6 이다: **취소하면 kill 이 원격에 나가지 않는다.**
// 다이얼로그가 떴는지가 아니라 하네스가 받은 명령 수를 세서 판정한다 — 화면과 무관하게 증명된다.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ServerChannel } from 'ssh2'
import {
  test,
  expect,
  connectNewSshProfile,
  dialog,
  dialogCancel,
  dialogConfirm,
  newLocalShell,
  sessionList,
  REPO_ROOT
} from './fixtures'

// 실기동 캡처 — 가짜 IPC 하네스가 아니라 이 스위트가 쓰는 **실제 main 프로세스·실제 remote:* 경로**를
// 지나온 화면이다(원격만 ssh2 루프백). 캡처가 곧 그 경로가 살아 있다는 증거다.
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(REPO_ROOT, 'agent_talk', name) })

// 실제 `ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args= --sort=-pcpu` 출력 모양.
// 좀비(Z) 한 줄과 고CPU(91.2%) 한 줄이 들어 있다 — 색 강조를 실물로 확인하려고.
const PS_OUT = `     1 root      91.2  0.1    12288 Ss  1902133 /sbin/init splash
  1234 jun       12.5  3.2  1048576 Sl    88213 node /srv/app/server.js --port 3000
  9999 postgres   0.3 18.4  6029312 Ss   902133 postgres: checkpointer
  4242 jun        0.0  0.0        0 Z         5 [worker] <defunct>
`

type PsHarness = {
  /** 다음 바퀴부터 반영되는 ps 출력. */
  state: { ps: string; killCode: number; killErr: string }
  /** 원격에 실제로 나간 kill 명령. 취소했으면 비어 있어야 한다. */
  kills: string[]
  /** ps 를 원격에서 돌린 횟수(폴링이 멈췄는지 판정). */
  rounds: () => number
  exec: (command: string, stream: ServerChannel) => void
}

function makePs(): PsHarness {
  const state = { ps: PS_OUT, killCode: 0, killErr: '' }
  const kills: string[] = []
  let rounds = 0
  const exec = (command: string, stream: ServerChannel): void => {
    if (command.startsWith('ps -eo')) {
      rounds++
      stream.write(state.ps)
    } else if (command.startsWith('kill -')) {
      kills.push(command)
      // 카탈로그의 kill 은 `2>&1` 이라 실서버에서도 오류가 stdout 으로 온다 — 그대로 흉내 낸다.
      if (state.killErr) stream.write(state.killErr + '\n')
      stream.exit(state.killCode)
      stream.end()
      return
    }
    // 셸 PID 질의(remoteCwd)·텔레메트리 수집 등 나머지는 조용히 성공으로 닫는다.
    stream.exit(0)
    stream.end()
  }
  return { state, kills, rounds: () => rounds, exec }
}

const rows = (page: Page) => page.locator('.con-row')
const row = (page: Page, pid: number) => page.locator(`.con-row[data-pid="${pid}"]`)

// SSH 접속 → 액티비티 바 [서버 콘솔] → 런치패드가 뜰 때까지.
async function openConsole(page: Page, name: string, port: number, password: string): Promise<void> {
  await connectNewSshProfile(page, { name, port, password })
  await page.click('.act-item[data-activity="console"]')
  await expect(page.locator('.con-win')).toBeVisible({ timeout: 10_000 })
}

// 런치패드에서 [프로세스] 를 눌러 탭으로 연다.
async function openProcessTab(page: Page): Promise<void> {
  await page.click('.con-app[data-tool="ps"]')
  await expect(page.locator('.exp-tab.on[data-tab="ps"]')).toBeVisible()
  await expect(rows(page)).toHaveCount(4, { timeout: 30_000 })
}

// CON-1 진입 — 아이콘 격자가 뜬다. **R3 에서 8칸이 전부 살아났다**(R1·R2 때는 3칸만 활성이고
// 5칸이 "추후" 였다). 파일·로그·포트·터미널은 콘솔 안에 탭으로 뜨지 않고 기존 창·패널을 연다(CON-22).
test('CON-1 액티비티 바에서 런치패드가 열리고 9칸이 전부 살아 있다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con1', execHandler: ps.exec })
  await openConsole(ara.page, 'con1', h.port, 'pw-con1')

  await expect(ara.page.locator('.con-app')).toHaveCount(9)
  for (const tool of ['files', 'ps', 'svc', 'disk', 'log', 'port', 'term', 'pkg', 'ctr']) {
    await expect(ara.page.locator(`.con-app[data-tool="${tool}"]`)).not.toHaveClass(/soon/)
  }
  // 죽은 칸이 하나도 없다 — 눌러도 아무 일 없는 칸을 남겨 두지 않는다.
  await expect(ara.page.locator('.con-app.soon')).toHaveCount(0)
  // 제목줄에 어느 서버를 만지고 있는지가 늘 보인다.
  await expect(ara.page.locator('.con-srv')).toHaveText('con1')
  // 떠 있는 창이다 — 뒤쪽 본문은 그대로 보인다(탐색기와 같은 규칙).
  await expect(ara.page.locator('.middle')).toBeVisible()
  await shot(ara.page, 'F26-R1-launchpad.png')
})

// CON-1b (R3 에서 뜻이 바뀜) 예전엔 "추후 칸은 눌러도 아무 일이 없다" 였다. 이제 추후 칸이 없다 —
// 대신 지켜야 할 성질은 **콘솔 안에 탭으로 뜨는 것은 원격 표 넷뿐**이라는 것이다.
// 파일·로그·포트·터미널은 기존 창·패널을 열고 콘솔은 닫힌다(CON-22·CON-23 이 그쪽을 본다).
test('CON-1b 콘솔 안에 탭으로 뜨는 것은 원격 표 넷뿐이다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con1b', execHandler: ps.exec })
  await openConsole(ara.page, 'con1b', h.port, 'pw-con1b')
  // 외부 도구 칸은 탭을 만들지 않는다.
  await ara.page.click('.con-app[data-tool="log"]')
  await ara.page.waitForTimeout(300)
  await expect(ara.page.locator('.exp-tab[data-tab="log"]')).toHaveCount(0)
})

// CON-2 아이콘 → 같은 창의 탭. 원격 ps 출력이 표로 그려진다.
test('CON-2 프로세스를 누르면 탭으로 열리고 원격 프로세스가 표에 보인다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con2', execHandler: ps.exec })
  await openConsole(ara.page, 'con2', h.port, 'pw-con2')
  await openProcessTab(ara.page)

  const r = row(ara.page, 1234)
  await expect(r.locator('.cuser')).toHaveText('jun')
  await expect(r.locator('.ccpu')).toHaveText('12.5')
  await expect(r.locator('.ccmd')).toHaveText('node /srv/app/server.js --port 3000')
  // 첫 화면은 CPU 내림차순 — ps 가 준 순서 그대로.
  expect(await ara.page.locator('.con-row .cpid').allTextContents()).toEqual(['1', '1234', '9999', '4242'])
  await row(ara.page, 1234).click() // 선택 상태·[종료]/[아라] 버튼이 켜진 모습까지 담는다
  await shot(ara.page, 'F26-R1-screenshot.png')
})

// CON-3 열 머리 클릭으로 정렬이 바뀐다(PID 오름차순 → 내림차순).
test('CON-3 열 머리를 누르면 그 열로 정렬된다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con3', execHandler: ps.exec })
  await openConsole(ara.page, 'con3', h.port, 'pw-con3')
  await openProcessTab(ara.page)

  await ara.page.click('.con-tbl th[data-col="pid"]')
  expect(await ara.page.locator('.con-row .cpid').allTextContents()).toEqual(['9999', '4242', '1234', '1'])
  await ara.page.click('.con-tbl th[data-col="pid"]')
  expect(await ara.page.locator('.con-row .cpid').allTextContents()).toEqual(['1', '1234', '4242', '9999'])
  // 폴링 한 바퀴가 더 돌아도 정렬은 유지된다(2.5초 주기).
  await ara.page.waitForTimeout(3_000)
  expect(await ara.page.locator('.con-row .cpid').allTextContents()).toEqual(['1', '1234', '4242', '9999'])
})

// CON-4 검색 — 명령·사용자 부분일치.
test('CON-4 검색어로 명령·사용자를 거른다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con4', execHandler: ps.exec })
  await openConsole(ara.page, 'con4', h.port, 'pw-con4')
  await openProcessTab(ara.page)

  await ara.page.fill('.con-field input', 'node')
  await expect(rows(ara.page)).toHaveCount(1)
  await expect(rows(ara.page).locator('.cpid')).toHaveText('1234')

  await ara.page.fill('.con-field input', 'jun')
  await expect(rows(ara.page)).toHaveCount(2)

  await ara.page.fill('.con-field input', '없는프로세스')
  await expect(rows(ara.page)).toHaveCount(0)
  await expect(ara.page.locator('.con-empty')).toHaveText('검색 결과가 없습니다')

  await ara.page.fill('.con-field input', '')
  await expect(rows(ara.page)).toHaveCount(4)
})

// CON-5 좀비·고CPU 는 색으로 눈에 띈다(클래스로 확인 — 실제 색은 토큰이 정한다).
test('CON-5 좀비와 고CPU 행이 색으로 구분된다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con5', execHandler: ps.exec })
  await openConsole(ara.page, 'con5', h.port, 'pw-con5')
  await openProcessTab(ara.page)

  await expect(row(ara.page, 4242)).toHaveClass(/zombie/)
  await expect(row(ara.page, 1)).toHaveClass(/hot/)
  await expect(row(ara.page, 1234)).not.toHaveClass(/hot|zombie/)
})

// CON-6★ 종료는 확인을 거친다 — **취소하면 원격에 kill 이 나가지 않는다**.
test('CON-6★ 종료 확인 다이얼로그를 취소하면 kill 이 나가지 않는다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con6', execHandler: ps.exec })
  await openConsole(ara.page, 'con6', h.port, 'pw-con6')
  await openProcessTab(ara.page)

  // 행을 고르기 전에는 [종료] 가 눌리지 않는다.
  await expect(ara.page.locator('.con-btn[data-action="ps.kill"]')).toBeDisabled()
  await row(ara.page, 1234).click()
  await ara.page.click('.con-btn[data-action="ps.kill"]')

  // 어떤 프로세스인지 다이얼로그에 박혀 있어야 한다(엉뚱한 행을 죽이지 않게).
  await expect(dialog(ara.page)).toContainText('1234')
  await expect(dialog(ara.page)).toContainText('node /srv/app/server.js --port 3000')
  await dialog(ara.page).locator('.modal-ft .btn.sec').click()

  await ara.page.waitForTimeout(1_500) // 폴링이 몇 바퀴 도는 동안에도 kill 은 없어야 한다
  expect(ps.kills).toEqual([])
})

// CON-7★ 확인하면 TERM 하나만 나간다(-KILL 은 자동으로 따라가지 않는다).
test('CON-7★ 확인하면 TERM 시그널 하나만 원격에 나간다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con7', execHandler: ps.exec })
  await openConsole(ara.page, 'con7', h.port, 'pw-con7')
  await openProcessTab(ara.page)

  await row(ara.page, 1234).click()
  await ara.page.click('.con-btn[data-action="ps.kill"]')
  await dialogConfirm(ara.page)

  await expect.poll(() => ps.kills, { timeout: 15_000 }).toEqual(['kill -TERM 1234 2>&1'])
})

// CON-8★ 실패하면 서버가 돌려준 사유를 그대로 보여 주고, 그때서야 강제 종료를 낸다.
test('CON-8★ 권한이 없으면 stderr 를 그대로 보여 주고 강제 종료를 따로 묻는다', async ({ ara, ssh }) => {
  const ps = makePs()
  ps.state.killCode = 1
  ps.state.killErr = 'kill: (1) - Operation not permitted'
  const h = await ssh({ password: 'pw-con8', execHandler: ps.exec })
  await openConsole(ara.page, 'con8', h.port, 'pw-con8')
  await openProcessTab(ara.page)

  await row(ara.page, 1).click()
  await ara.page.click('.con-btn[data-action="ps.kill"]')
  await dialogConfirm(ara.page)

  // 사유를 숨기지 않는다 — "실패했습니다"로 뭉개면 원인을 알 수 없다.
  await expect(dialog(ara.page)).toContainText('Operation not permitted', { timeout: 15_000 })
  expect(ps.kills).toEqual(['kill -TERM 1 2>&1'])

  // 강제 종료는 여기서만 나온다(첫 클릭에 -KILL 이 나가지 않는다).
  await dialog(ara.page).locator('.modal-ft .btn.sec:text-is("강제 종료(KILL)")').click()
  await expect.poll(() => ps.kills, { timeout: 15_000 }).toEqual([
    'kill -TERM 1 2>&1',
    'kill -KILL 1 2>&1'
  ])
})

// CON-8b★ [아라에게 물어보기] — 누를 때만, 고른 행 하나만 보낸다(§5 준영님 요청).
test('CON-8b★ 아라에게 물어보기는 고른 행 하나만 미리 보여 주고 확인해야 보낸다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con8b', execHandler: ps.exec })
  await openConsole(ara.page, 'con8b', h.port, 'pw-con8b')
  await openProcessTab(ara.page)

  await expect(ara.page.locator('.con-btn[data-action="ps.ask"]')).toBeDisabled()
  await row(ara.page, 1234).click()
  await ara.page.click('.con-btn[data-action="ps.ask"]')

  // 보낼 내용을 먼저 보여 준다 — 그 행만, 목록 전체가 아니다.
  await expect(dialog(ara.page)).toContainText('PID 1234')
  await expect(dialog(ara.page)).toContainText('node /srv/app/server.js')
  await expect(dialog(ara.page)).not.toContainText('postgres')
  // 취소하면 아라 패널은 열리지 않는다(명시적 제스처 — 기본 꺼짐).
  await dialog(ara.page).locator('.modal-ft .btn.sec').click()
  await expect(ara.page.locator('.ai-panel')).toHaveCount(0)

  await ara.page.click('.con-btn[data-action="ps.ask"]')
  await dialogConfirm(ara.page)
  await expect(ara.page.locator('.ai-panel')).toBeVisible()
  // 자동으로 보내지 않는다 — 입력칸에 얹어 주고 사람이 마무리한다.
  await expect(ara.page.locator('.ai-input')).toHaveValue(/PID 1234/)
})

// CON-8c★ 서버를 바꾸면 이전 서버의 목록·선택이 남지 않는다(엉뚱한 서버의 PID 를 죽이지 않게).
test('CON-8c★ 활성 세션을 바꾸면 이전 서버의 프로세스 목록이 사라진다', async ({ ara, ssh }) => {
  const { page } = ara
  const psA = makePs()
  const hA = await ssh({ password: 'pw-con8cA', execHandler: psA.exec })
  await openConsole(page, 'con8cA', hA.port, 'pw-con8cA')
  await openProcessTab(page)
  await row(page, 1234).click()
  await expect(page.locator('.con-btn[data-action="ps.kill"]')).toBeEnabled()

  // B 서버는 프로세스가 하나뿐이다.
  const psB = makePs()
  psB.state.ps = '  777 www-data 0.1 0.4 20480 Ss 400 nginx: worker process\n'
  const hB = await ssh({ password: 'pw-con8cB', execHandler: psB.exec })
  await connectNewSshProfile(page, { name: 'con8cB', port: hB.port, password: 'pw-con8cB' })

  await expect(page.locator('.con-srv')).toHaveText('con8cB')
  await expect(rows(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(rows(page).locator('.cpid')).toHaveText('777')
  // 선택도 함께 버린다 — A 의 1234 를 고른 채로 [종료] 가 살아 있으면 안 된다.
  await expect(page.locator('.con-btn[data-action="ps.kill"]')).toBeDisabled()
  expect(psA.kills).toEqual([])
})

// CON-9 창을 닫으면 원격 폴링이 멈춘다(unwatch).
test('CON-9 콘솔 창을 닫으면 ps 폴링이 멈춘다', async ({ ara, ssh }) => {
  const ps = makePs()
  const h = await ssh({ password: 'pw-con9', execHandler: ps.exec })
  await openConsole(ara.page, 'con9', h.port, 'pw-con9')
  await openProcessTab(ara.page)

  await ara.page.click('.act-item[data-activity="console"]') // 토글로 닫기
  await expect(ara.page.locator('.con-win')).toHaveCount(0)
  await ara.page.waitForTimeout(1_000) // 진행 중이던 마지막 바퀴가 끝날 시간
  const after = ps.rounds()
  await ara.page.waitForTimeout(6_000) // 주기(2.5초) 두 바퀴가 넘는 시간
  expect(ps.rounds()).toBe(after)
})

// CON-10 로컬 세션에는 원격 프로세스가 없다 — 목록 대신 안내(MON-7 과 같은 규칙).
test('CON-10 로컬 세션에서는 안내 문구만 보인다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await ara.page.click('.act-item[data-activity="console"]')
  await expect(ara.page.locator('.con-win .sb-placeholder')).toHaveText('SSH 세션에서 쓸 수 있습니다')
  await expect(ara.page.locator('.con-app')).toHaveCount(0)
})

// ── R2: 서비스 창 · 디스크 창 ───────────────────────────────────────────────
//
// CON-12/CON-13 이 이 라운드의 핵심이다 — **취소하면 systemctl 이 원격에 나가지 않는다**.
// CON-6 과 같은 방식으로, 다이얼로그가 떴는지가 아니라 하네스가 받은 명령 수로 판정한다.

// 실제 `systemctl list-units --type=service --all --no-pager --plain --no-legend` 출력 모양.
// 상태가 나쁜 유닛 앞에는 ● 가 붙어 나온다.
const SVC_OUT = `  ssh.service        loaded active   running OpenBSD Secure Shell server
● postgresql.service loaded failed   failed  PostgreSQL RDBMS
  cups.service       loaded inactive dead    CUPS Scheduler
  nginx.service      loaded active   running The nginx HTTP and reverse proxy server
`

// 실제 `df -PT` 출력 모양. 가상 파일시스템(tmpfs·devtmpfs·squashfs)이 섞여 있다 — 화면이 감춘다.
const DF_OUT = `Filesystem     Type     1024-blocks      Used Available Capacity Mounted on
/dev/sda1      ext4        41152812  13123456  25934567      34% /
/dev/sdb1      xfs        209715200 199229440  10485760      95% /data
tmpfs          tmpfs        3286916         0   3286916       0% /dev/shm
devtmpfs       devtmpfs     1643456         0   1643456       0% /dev
/dev/loop0     squashfs       66432     66432         0     100% /snap/core20/2015
`

// `du -x -d1 -k <path>` 응답표. 대상 폴더 자신도 한 줄로 들어 있다(실제 du 와 같게).
const DU: Record<string, string> = {
  '/data': '47185920\t/data/postgres\n2097152\t/data/logs\n125829120\t/data/backup\n175112192\t/data\n',
  '/data/backup':
    '104857600\t/data/backup/2026\n20971520\t/data/backup/2025\n125829120\t/data/backup\n',
  '/': '13123456\t/var\n1048576\t/etc\n14172032\t/\n'
}

type SysHarness = {
  state: { svc: string; df: string; actCode: number; actErr: string; hangDu: boolean }
  /** 원격에 실제로 나간 쓰기 명령(systemctl start/stop/restart). 취소했으면 비어 있어야 한다. */
  acts: string[]
  /** 원격에 나간 du 명령 — 파고들기가 경로를 제대로 이어 붙였는지 여기서 본다. */
  dus: string[]
  exec: (command: string, stream: ServerChannel) => void
}

function makeSys(): SysHarness {
  const state = { svc: SVC_OUT, df: DF_OUT, actCode: 0, actErr: '', hangDu: false }
  const acts: string[] = []
  const dus: string[] = []
  const exec = (command: string, stream: ServerChannel): void => {
    if (command.startsWith('systemctl list-units')) {
      stream.write(state.svc)
    } else if (command.startsWith('systemctl ')) {
      acts.push(command)
      // 카탈로그의 쓰기 명령은 `2>&1` 이라 실서버에서도 오류가 stdout 으로 온다 — 그대로 흉내 낸다.
      if (state.actErr) stream.write(state.actErr + '\n')
      stream.exit(state.actCode)
      stream.end()
      return
    } else if (command.startsWith('df ')) {
      stream.write(state.df)
    } else if (command.startsWith('du ')) {
      dus.push(command)
      if (state.hangDu) return // 답하지 않는 서버 — 서비스의 10초 상한에 걸린다
      stream.write(DU[/'([^']+)'/.exec(command)?.[1] ?? ''] ?? '')
    }
    // 셸 PID 질의(remoteCwd)·텔레메트리 수집 등 나머지는 조용히 성공으로 닫는다.
    stream.exit(0)
    stream.end()
  }
  return { state, acts, dus, exec }
}

const svcRows = (page: Page) => page.locator('.svc-row')
const svcRow = (page: Page, unit: string) => page.locator(`.svc-row[data-unit="${unit}"]`)
const dskRows = (page: Page) => page.locator('.dsk-row')
const dirRows = (page: Page) => page.locator('.dsk-dir')

// 런치패드에서 도구를 눌러 탭으로 연다.
async function openTool(page: Page, tool: string): Promise<void> {
  await page.click(`.con-app[data-tool="${tool}"]`)
  await expect(page.locator(`.exp-tab.on[data-tab="${tool}"]`)).toBeVisible()
}

// CON-11 서비스 표가 뜨고, 죽은 유닛이 맨 위로 온다(목록을 여는 이유가 대개 그것이다).
test('CON-11 서비스 표에서 failed 가 맨 위로 온다', async ({ ara, ssh }) => {
  const sys = makeSys()
  const h = await ssh({ password: 'pw-con11', execHandler: sys.exec })
  await openConsole(ara.page, 'con11', h.port, 'pw-con11')
  await openTool(ara.page, 'svc')

  await expect(svcRows(ara.page)).toHaveCount(4, { timeout: 30_000 })
  expect(await ara.page.locator('.svc-row .cunit').allTextContents()).toEqual([
    'postgresql.service',
    'nginx.service',
    'ssh.service',
    'cups.service'
  ])
  // 죽은 유닛은 색으로도 구분된다(실제 색은 토큰이 정한다 — 클래스로 확인).
  await expect(svcRow(ara.page, 'postgresql.service')).toHaveClass(/bad/)
  await expect(svcRow(ara.page, 'nginx.service')).not.toHaveClass(/bad/)
  await expect(svcRow(ara.page, 'nginx.service').locator('.con-dot')).toHaveClass(/ok/)

  // 검색은 유닛과 설명 양쪽에 걸린다.
  await ara.page.fill('.con-svc .con-field input', 'RDBMS')
  await expect(svcRows(ara.page)).toHaveCount(1)
  await ara.page.fill('.con-svc .con-field input', '')
  await expect(svcRows(ara.page)).toHaveCount(4)

  await svcRow(ara.page, 'postgresql.service').click()
  await shot(ara.page, 'F26-R2-service.png')
})

// CON-12★ 정지는 확인을 거친다 — **취소하면 원격에 systemctl 이 나가지 않는다**.
test('CON-12★ 정지 확인을 취소하면 원격에 명령이 나가지 않는다', async ({ ara, ssh }) => {
  const sys = makeSys()
  const h = await ssh({ password: 'pw-con12', execHandler: sys.exec })
  await openConsole(ara.page, 'con12', h.port, 'pw-con12')
  await openTool(ara.page, 'svc')
  await expect(svcRows(ara.page)).toHaveCount(4, { timeout: 30_000 })

  // 행을 고르기 전에는 세 버튼 모두 눌리지 않는다.
  for (const a of ['start', 'stop', 'restart']) {
    await expect(ara.page.locator(`.con-btn[data-action="svc.${a}"]`)).toBeDisabled()
  }
  await svcRow(ara.page, 'nginx.service').click()
  await ara.page.click('.con-btn[data-action="svc.stop"]')

  // 어떤 유닛인지 다이얼로그에 박혀 있어야 한다(엉뚱한 서비스를 세우지 않게).
  await expect(dialog(ara.page)).toContainText('nginx.service')
  await dialog(ara.page).locator('.modal-ft .btn.sec').click()

  await ara.page.waitForTimeout(1_500) // 폴링이 몇 바퀴 도는 동안에도 명령은 없어야 한다
  expect(sys.acts).toEqual([])
})

// CON-13★ 확인하면 그 유닛의 stop 하나만 나간다.
test('CON-13★ 확인하면 systemctl stop 이 하나만 원격에 나간다', async ({ ara, ssh }) => {
  const sys = makeSys()
  const h = await ssh({ password: 'pw-con13', execHandler: sys.exec })
  await openConsole(ara.page, 'con13', h.port, 'pw-con13')
  await openTool(ara.page, 'svc')
  await expect(svcRows(ara.page)).toHaveCount(4, { timeout: 30_000 })

  await svcRow(ara.page, 'nginx.service').click()
  await ara.page.click('.con-btn[data-action="svc.stop"]')
  await dialogConfirm(ara.page)

  await expect.poll(() => sys.acts, { timeout: 15_000 }).toEqual(['systemctl stop nginx.service 2>&1'])
  // 사용자가 새로고침을 누르지 않아도 바뀐 상태가 표에 나타난다(실행 직후 한 바퀴 + 폴링).
  sys.state.svc = SVC_OUT.replace(
    '  nginx.service      loaded active   running',
    '  nginx.service      loaded inactive dead   '
  )
  await expect(svcRow(ara.page, 'nginx.service').locator('.csub')).toHaveText('dead', { timeout: 15_000 })
  expect(sys.acts.length).toBe(1)
})

// CON-13b★ 실패하면 서버가 돌려준 사유를 그대로 보여 준다(권한 부족을 "실패"로 뭉개지 않는다).
test('CON-13b★ 권한이 없으면 서버 응답을 그대로 보여 준다', async ({ ara, ssh }) => {
  const sys = makeSys()
  sys.state.actCode = 1
  sys.state.actErr = 'Failed to stop nginx.service: Access denied'
  const h = await ssh({ password: 'pw-con13b', execHandler: sys.exec })
  await openConsole(ara.page, 'con13b', h.port, 'pw-con13b')
  await openTool(ara.page, 'svc')
  await expect(svcRows(ara.page)).toHaveCount(4, { timeout: 30_000 })

  await svcRow(ara.page, 'nginx.service').click()
  await ara.page.click('.con-btn[data-action="svc.restart"]')
  await dialogConfirm(ara.page)

  await expect(dialog(ara.page)).toContainText('Access denied', { timeout: 15_000 })
  expect(sys.acts).toEqual(['systemctl restart nginx.service 2>&1'])
})

// CON-14 systemd 가 없는 서버 — 빈 표가 아니라 안내 한 줄(CON-10 과 같은 결).
test('CON-14 systemd 가 없는 서버에는 안내가 뜬다', async ({ ara, ssh }) => {
  const sys = makeSys()
  sys.state.svc = 'bash: systemctl: command not found\n'
  const h = await ssh({ password: 'pw-con14', execHandler: sys.exec })
  await openConsole(ara.page, 'con14', h.port, 'pw-con14')
  await openTool(ara.page, 'svc')

  await expect(ara.page.locator('.con-svc .con-empty')).toHaveText('이 서버에는 systemd 가 없습니다', {
    timeout: 30_000
  })
  await expect(ara.page.locator('.con-svc .con-tbl')).toHaveCount(0)
})

// CON-14b★ 서버를 바꾸면 이전 서버의 목록·선택이 남지 않는다(A 에서 고른 유닛으로 B 를 세우지 않게).
test('CON-14b★ 활성 세션을 바꾸면 서비스 목록과 선택이 사라진다', async ({ ara, ssh }) => {
  const { page } = ara
  const sysA = makeSys()
  const hA = await ssh({ password: 'pw-con14bA', execHandler: sysA.exec })
  await openConsole(page, 'con14bA', hA.port, 'pw-con14bA')
  await openTool(page, 'svc')
  await expect(svcRows(page)).toHaveCount(4, { timeout: 30_000 })
  await svcRow(page, 'nginx.service').click()
  await expect(page.locator('.con-btn[data-action="svc.stop"]')).toBeEnabled()

  // B 서버에는 nginx 가 없다.
  const sysB = makeSys()
  sysB.state.svc = '  ssh.service   loaded active running OpenBSD Secure Shell server\n'
  const hB = await ssh({ password: 'pw-con14bB', execHandler: sysB.exec })
  await connectNewSshProfile(page, { name: 'con14bB', port: hB.port, password: 'pw-con14bB' })

  await expect(page.locator('.con-srv')).toHaveText('con14bB')
  await expect(svcRows(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.con-btn[data-action="svc.stop"]')).toBeDisabled()
  expect(sysA.acts).toEqual([])
  expect(sysB.acts).toEqual([])
})

// CON-15★ 디스크 — 마운트를 고르면 그 경로로 du 가 나가고, 폴더를 누르면 경로가 이어진다.
test('CON-15★ 마운트를 고르면 du 가 나가고 폴더를 누르면 한 단계 더 들어간다', async ({ ara, ssh }) => {
  const sys = makeSys()
  const h = await ssh({ password: 'pw-con15', execHandler: sys.exec })
  await openConsole(ara.page, 'con15', h.port, 'pw-con15')
  await openTool(ara.page, 'disk')

  // 가상 파일시스템(tmpfs·devtmpfs·squashfs)은 기본으로 감춘다 — 실디스크 둘만 남는다.
  await expect(dskRows(ara.page)).toHaveCount(2, { timeout: 30_000 })
  expect(await ara.page.locator('.dsk-row .cmount').allTextContents()).toEqual(['/', '/data'])
  await expect(ara.page.locator('.dsk-row[data-mount="/data"]')).toHaveClass(/crit/) // 95%
  await expect(ara.page.locator('.dsk-row[data-mount="/"]')).not.toHaveClass(/crit|warn/) // 34%

  // 고르기 전에는 du 가 나가지 않는다(무거운 명령이라 폴링도 하지 않는다).
  expect(sys.dus).toEqual([])
  await ara.page.click('.dsk-row[data-mount="/data"]')
  await expect(dirRows(ara.page)).toHaveCount(3, { timeout: 15_000 })
  // 큰 것부터, 자기 자신(/data)은 빠진다.
  expect(await ara.page.locator('.dsk-dir .pt').allTextContents()).toEqual([
    '/data/backup',
    '/data/postgres',
    '/data/logs'
  ])
  expect(sys.dus).toEqual(["du -x -d1 -k '/data' 2>/dev/null"])

  // 폴더를 누르면 그 경로로 한 단계 더 — 이게 "디스크 꽉 찼을 때 범인 찾기" 흐름이다.
  await ara.page.click('.dsk-dir[data-path="/data/backup"]')
  await expect(dirRows(ara.page)).toHaveCount(2, { timeout: 15_000 })
  await expect(ara.page.locator('.dsk-path')).toHaveText('/data/backup')
  expect(sys.dus[1]).toBe("du -x -d1 -k '/data/backup' 2>/dev/null")
  await shot(ara.page, 'F26-R2-disk.png')

  // [뒤로] 로 되돌아온다(2026-08-13 [상위로] 대체). 처음 자리까지 오면 더 갈 곳이 없다.
  const back = ara.page.locator('.con-btn[data-action="disk.back"]')
  await back.click()
  await expect(ara.page.locator('.dsk-path')).toHaveText('/data')
  await expect(back).toBeDisabled()
  expect(sys.dus[2]).toBe("du -x -d1 -k '/data' 2>/dev/null")

  // 체크박스를 켜면 감춰 둔 가상 파일시스템까지 보인다.
  await ara.page.click('.con-disk .fb-check input')
  await expect(dskRows(ara.page)).toHaveCount(5)
})

// CON-16 du 가 답하지 않으면 조용히 비우지 않는다 — 더 좁은 경로를 권한다(서비스 상한 10초).
test('CON-16 du 가 시간을 넘기면 안내를 띄운다', async ({ ara, ssh }) => {
  const sys = makeSys()
  sys.state.hangDu = true
  const h = await ssh({ password: 'pw-con16', execHandler: sys.exec })
  await openConsole(ara.page, 'con16', h.port, 'pw-con16')
  await openTool(ara.page, 'disk')
  await expect(dskRows(ara.page)).toHaveCount(2, { timeout: 30_000 })

  await ara.page.click('.dsk-row[data-mount="/"]')
  await expect(ara.page.locator('.con-disk .con-empty')).toHaveText('폴더 용량을 재는 중입니다')
  await expect(ara.page.locator('.con-disk .con-empty.bad')).toHaveText(
    '시간이 초과됐습니다 — 더 좁은 경로에서 다시 시도해 보세요',
    { timeout: 20_000 }
  )
})

// CON-17 [탐색기로 열기] — 새 창을 만들지 않고 기존 파일 탐색기 창을 그 서버로 연다.
test('CON-17 탐색기로 열기는 기존 탐색기 창을 그 서버로 연다', async ({ ara, ssh }) => {
  const sys = makeSys()
  const h = await ssh({ password: 'pw-con17', execHandler: sys.exec })
  await openConsole(ara.page, 'con17', h.port, 'pw-con17')
  await openTool(ara.page, 'disk')
  await expect(dskRows(ara.page)).toHaveCount(2, { timeout: 30_000 })

  // 경로를 고르기 전에는 열 곳이 없다.
  await expect(ara.page.locator('.con-btn[data-action="disk.explorer"]')).toBeDisabled()
  await ara.page.click('.dsk-row[data-mount="/data"]')
  await expect(dirRows(ara.page)).toHaveCount(3, { timeout: 15_000 })
  await ara.page.click('.con-btn[data-action="disk.explorer"]')

  // 콘솔 창도 .exp-win 껍데기를 쓴다 — 탐색기 창은 .con-win 이 아닌 쪽이다.
  const exp = ara.page.locator('.exp-win:not(.con-win)')
  await expect(exp).toBeVisible({ timeout: 15_000 })
  await expect(exp.locator('.exp-tab .exp-tab-nm', { hasText: 'con17' })).toBeVisible({ timeout: 15_000 })
})

// ── F26 R3: 서버 개요 · 설치된 프로그램 · 나머지 칸 편입 ─────────────────────

const OV_OUT = [
  'Ubuntu 22.04.4 LTS',
  '5.15.0-91-generic',
  'Linux',
  'dev-box',
  '1053492.31 2100.5'
].join('\n--ARA-OV--\n')

const PKG_OUT = [
  'node\t/home/jun/.nvm/versions/node/v20.11.1/bin/node\tv20.11.1\t1710374400',
  'npm\t/home/jun/.nvm/versions/node/v20.11.1/bin/npm\t10.2.4\t1710374400',
  'nginx\t/usr/sbin/nginx\tnginx version: nginx/1.24.0\t1699999999'
].join('\n')

type R3Harness = { probes: () => number; exec: (c: string, s: ServerChannel) => void }

function makeR3(): R3Harness {
  let probes = 0
  const exec = (command: string, stream: ServerChannel): void => {
    if (command.includes('--ARA-OV--')) stream.write(OV_OUT)
    else if (command.includes('b=node;')) {
      probes++
      // 실서버의 로그인 셸은 대개 bash 이고, **bash 내장 echo 는 `\t` 를 탭으로 바꾸지 않는다**.
      // 하네스가 늘 진짜 탭을 돌려주는 바람에 표가 통째로 비는 버그를 e2e 가 놓쳤다(2026-08-13).
      // 명령이 echo 를 쓰면 여기서도 bash 처럼 이스케이프를 그대로 흘려보낸다.
      stream.write(/echo\s+"/.test(command) ? PKG_OUT.replace(/\t/g, '\\t') : PKG_OUT)
    }
    stream.exit(0)
    stream.end()
  }
  return { probes: () => probes, exec }
}

// CON-18 런치패드 머리의 서버 개요 — 타일이 아니라 한 줄이다("접속 직후 화면").
test('CON-18 런치패드에 배포판·커널·가동 시간이 한 줄로 뜬다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw18', execHandler: makeR3().exec })
  await openConsole(ara.page, 'c18', h.port, 'pw18')
  const ov = ara.page.locator('.con-ov')
  await expect(ov).toBeVisible({ timeout: 20_000 })
  await expect(ov).toContainText('Ubuntu 22.04.4 LTS')
  await expect(ov).toContainText('커널 5.15.0-91-generic')
  await expect(ov).toContainText('가동 12일') // 1053492초 = 12일 track
  // 자원 사용량(CPU·메모리·디스크)은 여기 없다 — F29 사이드바가 유일한 집이다.
  await expect(ov).not.toContainText('%')
})

// CON-19 설치된 프로그램 — dpkg 목록에 없는 nvm node 가 잡히는 것이 이 기능의 존재 이유다.
test('CON-19 설치된 프로그램 표에 nvm 으로 깐 node 가 경로·버전·설치일과 함께 뜬다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw19', execHandler: makeR3().exec })
  await openConsole(ara.page, 'c19', h.port, 'pw19')
  await ara.page.click('.con-app[data-tool="pkg"]')
  await expect(ara.page.locator('.exp-tab.on[data-tab="pkg"]')).toBeVisible()

  const rowsPkg = ara.page.locator('.pkg-row:not(.missing)')
  await expect(rowsPkg).toHaveCount(3, { timeout: 20_000 })
  const nodeRow = ara.page.locator('.pkg-row', { hasText: 'node' }).first()
  await expect(nodeRow.locator('.pkg-path')).toContainText('.nvm') // 패키지 목록엔 없는 것
  await expect(nodeRow.locator('.pkg-ver')).toHaveText('v20.11.1')
  await expect(nodeRow.locator('.pkg-date')).toHaveText('2024-03-14')
  // 자기 이름 접두어는 걷어 낸다.
  await expect(ara.page.locator('.pkg-row', { hasText: 'nginx' }).first().locator('.pkg-ver')).toHaveText('nginx/1.24.0')
  await shot(ara.page, 'F26-R3-pkg.png')
})

// CON-20 폴링하지 않는다 — 설치 목록은 초 단위로 변하지 않는다.
test('CON-20 설치된 프로그램은 폴링하지 않고 [새로고침] 때만 다시 읽는다', async ({ ara, ssh }) => {
  const r3 = makeR3()
  const h = await ssh({ password: 'pw20', execHandler: r3.exec })
  await openConsole(ara.page, 'c20', h.port, 'pw20')
  await ara.page.click('.con-app[data-tool="pkg"]')
  await expect(ara.page.locator('.pkg-row:not(.missing)')).toHaveCount(3, { timeout: 20_000 })

  const first = r3.probes()
  await ara.page.waitForTimeout(6000) // 프로세스 폴링(2.5초) 두 바퀴 이상
  expect(r3.probes()).toBe(first) // 늘지 않았다

  await ara.page.locator('.pkg-wrap .con-btn').click()
  await expect.poll(() => r3.probes(), { timeout: 15_000 }).toBe(first + 1)
})

// CON-21 검색 · 없는 것도 보기
test('CON-21 프로그램 검색이 걸리고, 없는 것은 기본으로 숨는다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw21', execHandler: makeR3().exec })
  await openConsole(ara.page, 'c21', h.port, 'pw21')
  await ara.page.click('.con-app[data-tool="pkg"]')
  await expect(ara.page.locator('.pkg-row:not(.missing)')).toHaveCount(3, { timeout: 20_000 })

  // 기본: 못 찾은 것들은 안 보인다.
  await expect(ara.page.locator('.pkg-row.missing')).toHaveCount(0)
  await ara.page.locator('.con-check input[type="checkbox"]').check()
  await expect(ara.page.locator('.pkg-row.missing').first()).toBeVisible()

  await ara.page.locator('.pkg-wrap .con-field').fill('ngin')
  await expect(ara.page.locator('.pkg-row:not(.missing)')).toHaveCount(1)
})

// CON-22 나머지 칸은 콘솔 안에 다시 그리지 않고 **기존 창·패널**을 연다.
test('CON-22 [포트] 칸은 포트 모니터 패널을 열고 콘솔은 닫는다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw22', execHandler: makeR3().exec })
  await openConsole(ara.page, 'c22', h.port, 'pw22')

  await ara.page.click('.con-app[data-tool="port"]')
  // 기존 포트 모니터 패널이 뜬다(콘솔 안에 같은 화면을 두 번 만들지 않는다).
  await expect(ara.page.locator('.monitor-panel:not(.sysm)')).toBeVisible()
  // 방금 연 창을 콘솔이 덮지 않게 콘솔은 닫는다.
  await expect(ara.page.locator('.con-win')).toHaveCount(0)
  // 콘솔 안에 port 탭이 생기지는 않았다.
  await expect(ara.page.locator('.exp-tab[data-tab="port"]')).toHaveCount(0)
})

// CON-23★ [터미널] 칸은 **그 서버의** 새 세션을 연다.
// 2026-08-13 감사 전까지 이 검사는 "탭이 하나 늘었다"만 봤고, 그래서 실제로는 내 PC 로컬 셸이
// 열리는 결함을 못 잡았다(창 제목엔 서버 이름이 박혀 있는데). **무엇이 열렸는지**를 본다.
test('CON-23★ [터미널] 칸은 그 서버의 새 세션을 연다(로컬 셸이 아니다)', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw23', execHandler: makeR3().exec })
  await openConsole(ara.page, 'c23', h.port, 'pw23')
  const before = await ara.page.locator('.term-tabbar .ttab').count()

  await ara.page.click('.con-app[data-tool="term"]')
  await expect(ara.page.locator('.term-tabbar .ttab')).toHaveCount(before + 1, { timeout: 30_000 })
  await expect(ara.page.locator('.con-win')).toHaveCount(0)

  // 늘어난 세션이 **ssh** 여야 한다 — 여기가 이 검사의 요점이다.
  const types = (await sessionList(ara.page)).map((s) => s.type)
  expect(types.filter((t) => t === 'ssh')).toHaveLength(2)
  expect(types).not.toContain('local')
})

// ── F28 컨테이너 ────────────────────────────────────────────────────────────

// **실제 `--no-trunc` 출력과 같은 64자 id 다.** 짧은 가짜 id 를 쓰면 조작 명령의 인자 검증
// (validCtrId)이 통과하지 못해 e2e 만 초록인 채로 실서버에서 버튼이 죽는다 — pkg 빈 표 사고와 같은 함정.
const CTR_WEB = 'a1b2c3'.repeat(10) + 'aaaa'
const CTR_DB = 'd4e5f6'.repeat(10) + 'bbbb'
const CTR_OUT = [
  `${CTR_WEB}\tweb\tnginx:1.24\trunning\tUp 3 days\t0.0.0.0:80->80/tcp`,
  `${CTR_DB}\tdb\tpostgres:16\texited\tExited (0) 2 hours ago\t`
].join('\n')

type CtrHarness = {
  calls: () => number
  /** 목록 말고 실제로 나간 조작 명령(정지·제거·이미지 제거…) — 무엇이 나갔는지가 검증 대상이다. */
  acts: string[]
  /** 이 문자열이 든 명령을 실패로 돌려준다(런타임 거절 재현). */
  fail: { on: string; msg: string } | null
  exec: (c: string, s: ServerChannel) => void
}

function makeCtr(out: string): CtrHarness {
  let calls = 0
  const h: CtrHarness = {
    calls: () => calls,
    acts: [],
    fail: null,
    exec: (command: string, stream: ServerChannel): void => {
      if (command.includes('docker ps -a')) {
        calls++
        stream.write(out)
        stream.exit(0)
        stream.end()
        return
      }
      const m = /docker (\w+) (\S+)/.exec(command)
      if (m) {
        h.acts.push(m[1] + ' ' + m[2])
        if (h.fail && command.includes(h.fail.on)) {
          stream.write(h.fail.msg)
          stream.exit(1)
          stream.end()
          return
        }
      }
      stream.exit(0)
      stream.end()
    }
  }
  return h
}

// CON-24 컨테이너 표 — 멈춘 것이 위로 온다("왜 안 떠 있지"가 이 화면을 여는 이유).
test('CON-24 컨테이너 표에 멈춘 것이 위로 오고 실행 중은 점이 켜진다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw24', execHandler: makeCtr(CTR_OUT).exec })
  await openConsole(ara.page, 'c24', h.port, 'pw24')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.exp-tab.on[data-tab="ctr"]')).toBeVisible()

  const names = ara.page.locator('.ctr-row .ctr-name')
  await expect(names).toHaveCount(2, { timeout: 20_000 })
  await expect(names.first()).toHaveText('db') // 멈춘 것이 위
  await expect(ara.page.locator('.ctr-row').first()).toHaveClass(/down/)
  await expect(ara.page.locator('.ctr-row').nth(1).locator('.ctr-dot')).toHaveClass(/on/)
  await expect(ara.page.locator('.ctr-row').nth(1).locator('.ctr-ports')).toHaveText('0.0.0.0:80->80/tcp')
})

// CON-25 도커가 없는 서버는 **빈 표가 아니라 안내**다(systemd 없는 서버 처리와 같은 결).
test('CON-25 컨테이너 런타임이 없으면 빈 표가 아니라 안내가 뜬다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw25', execHandler: makeCtr('docker: command not found').exec })
  await openConsole(ara.page, 'c25', h.port, 'pw25')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.con-note')).toContainText('docker·podman', { timeout: 20_000 })
  await expect(ara.page.locator('.ctr-row')).toHaveCount(0)
})

// CON-26 검색은 이름·이미지·상태에 걸린다.
test('CON-26 컨테이너 검색이 이름·이미지에 걸린다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw26', execHandler: makeCtr(CTR_OUT).exec })
  await openConsole(ara.page, 'c26', h.port, 'pw26')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })
  await ara.page.locator('.pkg-wrap .con-field').fill('postgres')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(1)
  await expect(ara.page.locator('.ctr-name')).toHaveText('db')
})

// ── F28 R2 컨테이너 조작(준영님 요청 2026-08-13 — "도커 데스크톱처럼") ──────

const ctrRow = (page: Page, name: string) => page.locator(`.ctr-row[data-ctr="${name}"]`)
const ctrBtn = (page: Page, action: string) => page.locator(`.ctr-acts .con-btn[data-action="ctr.${action}"]`)

// CON-28★ 상태에 맞는 버튼만 열린다 — 눌러 봐야 런타임이 거절할 버튼은 내주지 않는다.
test('CON-28★ 컨테이너 상태에 따라 열리는 조작이 갈린다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw28', execHandler: makeCtr(CTR_OUT).exec })
  await openConsole(ara.page, 'c28', h.port, 'pw28')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })

  // 고르기 전에는 전부 잠겨 있다.
  for (const a of ['start', 'stop', 'pause', 'unpause', 'restart', 'rm', 'attach'])
    await expect(ctrBtn(ara.page, a)).toBeDisabled()

  // 돌고 있는 것: 정지·일시정지·재시작·접속. 시작·제거는 막힌다(rm -f 를 쓰지 않기로 했다).
  await ctrRow(ara.page, 'web').click()
  await expect(ctrBtn(ara.page, 'stop')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'pause')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'restart')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'attach')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'start')).toBeDisabled()
  await expect(ctrBtn(ara.page, 'rm')).toBeDisabled()

  // 멈춘 것: 시작·제거만. 접속은 막힌다(들어갈 셸이 없다).
  await ctrRow(ara.page, 'db').click()
  await expect(ctrBtn(ara.page, 'start')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'rm')).toBeEnabled()
  await expect(ctrBtn(ara.page, 'stop')).toBeDisabled()
  await expect(ctrBtn(ara.page, 'attach')).toBeDisabled()
  await shot(ara.page, 'F28-R2-ctr.png')
})

// CON-29★ 확인 다이얼로그를 취소하면 **명령이 나가지 않는다**. 쓰기 경로의 핵심 성질이다.
test('CON-29★ 정지를 취소하면 원격에 아무 명령도 나가지 않는다', async ({ ara, ssh }) => {
  const ctr = makeCtr(CTR_OUT)
  const h = await ssh({ password: 'pw29', execHandler: ctr.exec })
  await openConsole(ara.page, 'c29', h.port, 'pw29')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })
  await ctrRow(ara.page, 'web').click()

  await ctrBtn(ara.page, 'stop').click()
  await expect(dialog(ara.page)).toBeVisible()
  await expect(dialog(ara.page)).toContainText('web') // 무엇을 멈추는지가 문구에 박혀 있다
  await dialogCancel(ara.page)
  await ara.page.waitForTimeout(500)
  expect(ctr.acts).toEqual([])

  // 확인하면 그때 나간다 — 이름이 아니라 id 로 나간다.
  await ctrBtn(ara.page, 'stop').click()
  await dialogConfirm(ara.page)
  await expect.poll(() => ctr.acts, { timeout: 10_000 }).toEqual(['stop ' + CTR_WEB])
})

// CON-30 런타임이 거절하면 그 문장을 그대로 보여 준다(sudo 를 붙이거나 숨기지 않는다).
test('CON-30 이미지 제거가 거절되면 서버가 준 이유가 그대로 뜬다', async ({ ara, ssh }) => {
  const ctr = makeCtr(CTR_OUT)
  ctr.fail = { on: 'rmi', msg: 'Error response from daemon: conflict: image is being used' }
  const h = await ssh({ password: 'pw30', execHandler: ctr.exec })
  await openConsole(ara.page, 'c30', h.port, 'pw30')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })
  await ctrRow(ara.page, 'web').click()

  await ctrBtn(ara.page, 'rmi').click()
  await expect(dialog(ara.page)).toContainText('nginx:1.24')
  await dialogConfirm(ara.page)
  await expect(dialog(ara.page)).toContainText('image is being used', { timeout: 10_000 })
})

// CON-31★ [접속]만 exec 채널이 아니라 **터미널**로 간다 — docker exec -it 는 대화형이다.
test('CON-31★ [접속]은 컨테이너 셸 명령을 터미널로 보내고 콘솔을 닫는다', async ({ ara, ssh }) => {
  const ctr = makeCtr(CTR_OUT)
  // 화면이 아니라 **하네스 shell 채널이 실제로 받은 바이트**로 판정한다(F27 AICLI-5 와 같은 방식).
  const inputs: string[] = []
  const h = await ssh({ password: 'pw31', execHandler: ctr.exec, onShellData: (d) => inputs.push(d) })
  await openConsole(ara.page, 'c31', h.port, 'pw31')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })
  await ctrRow(ara.page, 'web').click()
  await ctrBtn(ara.page, 'attach').click()

  // 콘솔은 비켜 준다(방금 보낸 터미널을 덮고 있으면 한 번 더 치워야 한다).
  await expect(ara.page.locator('.con-win')).toHaveCount(0)
  await expect.poll(() => inputs.join(''), { timeout: 15_000 }).toContain('exec -it ' + CTR_WEB)
  // 줄이 실제로 실행되도록 CR 로 끝난다(LF 만 보내면 실행하지 않는 셸이 있다).
  expect(inputs.join('')).toContain('\r')
  // exec 채널로는 나가지 않았다 — 대화형이라 그 길로는 못 간다.
  expect(ctr.acts.filter((a) => a.startsWith('exec'))).toEqual([])
})

// CON-27 숨은 탭은 원격에 명령을 보내지 않는다(R1 CON-9 와 같은 규칙).
test('CON-27 컨테이너 탭을 닫으면 폴링이 멈춘다', async ({ ara, ssh }) => {
  const ctr = makeCtr(CTR_OUT)
  const h = await ssh({ password: 'pw27', execHandler: ctr.exec })
  await openConsole(ara.page, 'c27', h.port, 'pw27')
  await ara.page.click('.con-app[data-tool="ctr"]')
  await expect(ara.page.locator('.ctr-row')).toHaveCount(2, { timeout: 20_000 })

  await ara.page.click('.exp-tab[data-tab="ctr"] .exp-tab-x')
  await ara.page.waitForTimeout(300)
  const after = ctr.calls()
  await ara.page.waitForTimeout(11_000) // 폴링 2바퀴(5초) 이상
  expect(ctr.calls()).toBe(after)
})
