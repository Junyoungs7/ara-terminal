// 파일 탐색기 창(E1 + 탭, src/renderer/components/ExplorerView.tsx) — 진입/종료 · 좌측 탐색 창에서
// 서버 열기 · 탭 · 다중 선택 복사/붙여넣기(로컬→원격, 같은 서버 안).
// 2패널 모드(구 F20)는 없어졌다 — "복사 →/이동 →" 우클릭 항목 대신 클립보드가 그 자리를 대신한다.
// DLP: 전송은 전부 루프백(127.0.0.1) SSH 하네스와 OS 임시 디렉토리 사이에서만 한다(실서버·실데이터 금지).
import { cpSync, mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { ServerChannel } from 'ssh2'
import { test, expect, newLocalShell, runCommand, termText, connectNewSshProfile } from './fixtures'

// 같은 서버 안 복사(sftp:copyRemote)는 SFTP 가 아니라 **exec 으로 `cp`** 를 돌린다 — 이 하네스엔
// 진짜 셸이 없으므로 cp 한 줄만 흉내 낸다. 작은따옴표 인용을 실제로 풀어 보기 때문에 shQuote 조립이
// 깨지면(공백·따옴표 든 경로) 여기서 잡힌다 — 그게 이 경로에서 실제로 깨질 수 있는 부분이다.
function cpExec(root: string) {
  const real = (p: string): string => join(root, p.replace(/^\/+/, ''))
  return (command: string, stream: ServerChannel): void => {
    const m = /^cp -a -- (.+)$/.exec(command)
    // shQuote 는 '...' 로 감싸고 내부 ' 를 '\'' 로 탈출한다 — 그 규칙 그대로 되돌린다.
    const args = m ? [...m[1].matchAll(/'((?:[^']|'\\'')*)'/g)].map((x) => x[1].replace(/'\\''/g, "'")) : []
    const dest = args.pop()
    if (!dest || args.length === 0) {
      stream.stderr.write('cp: bad usage\n')
      stream.exit(1)
      stream.end()
      return
    }
    try {
      for (const src of args) cpSync(real(src), join(real(dest), basename(src)), { recursive: true })
      stream.exit(0)
    } catch (e) {
      stream.stderr.write(String(e) + '\n')
      stream.exit(1)
    }
    stream.end()
  }
}

// 원격 루트(ssh2 하네스) — tests/e2e/sftp.spec.ts 의 makeRemote() 패턴을 그대로 복사(공유 파일은 건드리지 않는다).
function makeRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'ara-exp-remote-'))
  writeFileSync(join(root, 'remote_readme.txt'), '원격 파일\n')
  return root
}

// 탐색기 탭의 FileTree 는 홈 디렉토리('.')에서 시작한다(즐겨찾기로 들어올 때만 goto 가 있다) —
// 그래서 로컬 픽스처는 홈 바로 아래에 둔다. ponytail: 실 홈에 쓴다(임의 경로로 점프하는 입구가
// 없다) — 각 테스트가 finally 에서 지운다.
function makeLocalFixture(prefix: string): string {
  return mkdtempSync(join(homedir(), prefix))
}

async function openExplorer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+O')
  await expect(page.locator('.exp-win')).toBeVisible({ timeout: 10_000 })
}

async function closeExplorer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+O')
  await expect(page.locator('.exp-win')).toHaveCount(0, { timeout: 10_000 })
}

/** 지금 보이는 탭의 파일 영역. 숨은 탭도 DOM 에 남아 있으므로(폴더를 기억하려고) :visible 로 고른다. */
const pane = (page: Page): Locator => page.locator('.exp-pane:visible')
const frow = (scope: Locator, name: string): Locator => scope.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)
const navNode = (page: Page, name: string): Locator => page.locator(`.exp-node:has(.nm:text-is("${name}"))`)
// 숨은 탭에도 툴바가 하나씩 있다(폴더를 기억하려고 마운트를 유지한다) — 보이는 탭으로 좁힌다.
const toolBtn = (page: Page, label: string): Locator => pane(page).locator(`.ftool .ftb:has(span:text-is("${label}"))`)

// 좌측 [서버] 목록에서 서버를 눌러 탭을 연다(접속 안 돼 있으면 그 자리에서 접속한다).
async function openServerTab(page: Page, profileName: string): Promise<void> {
  await navNode(page, profileName).click()
  await expect(page.locator(`.exp-tab.on:has(.exp-tab-nm:text-is("${profileName}"))`)).toBeVisible({ timeout: 30_000 })
}

// EXP-1 Ctrl+Shift+O 로 떠 있는 창이 열린다 — 본문(.middle)은 **가려지지 않는다**(구 전체화면 모드와 다름).
test('EXP-1 Ctrl+Shift+O 로 탐색기 창이 열리고 터미널 본문은 그대로 보인다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await openExplorer(ara.page)
  await expect(ara.page.locator('.exp-tab:not(.add)')).toHaveCount(1)
  await expect(ara.page.locator('.middle')).toBeVisible()
  // 열자마자 로컬 탭 한 장 — 예전엔 로컬 패널이 두 개 떴다(준영님 제보).
  await expect(ara.page.locator('.exp-tab.on .exp-tab-nm')).toHaveText('내 PC')
})

// EXP-2 View 메뉴에서도 같은 진입점으로 열린다
test('EXP-2 View 메뉴에서 탐색기를 연다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await ara.page.click('.tb-menu span:text-is("View")')
  await ara.page.click('.ctx-menu .ctx-item[data-action="explorer.toggle"]')
  await expect(ara.page.locator('.exp-win')).toBeVisible({ timeout: 10_000 })
})

// EXP-2b 우측 액티비티 바 아이콘으로도 연다(준영님 요청 진입점)
test('EXP-2b 우측 기능 바 아이콘으로 탐색기를 연다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await ara.page.click('.act-item[data-activity="explorer"]')
  await expect(ara.page.locator('.exp-win')).toBeVisible({ timeout: 10_000 })
  await ara.page.click('.act-item[data-activity="explorer"]')
  await expect(ara.page.locator('.exp-win')).not.toBeVisible() // #74: 창은 남고 숨는다
})

// EXP-13★ 떠 있는 창 둘이 겹치지 않고, 누르면 앞으로 온다 (#72, 2026-08-14)
// 예전엔 탐색기와 서버 콘솔이 **정확히 같은 좌표**에서 시작했고(둘 다 같은 initialRect) z-index 도
// 같아서(둘 다 95) 렌더 순서상 뒤인 콘솔이 항상 위였다 — 둘 다 열면 탐색기를 꺼낼 방법이 없었다.
test('EXP-13★ 탐색기와 콘솔이 어긋나 뜨고, 누른 창이 앞으로 온다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)

  await page.click('.act-item[data-activity="explorer"]')
  await expect(page.locator('.exp-win:not(.con-win)')).toBeVisible()
  await page.click('.act-item[data-activity="console"]')
  await expect(page.locator('.con-win')).toBeVisible()

  const box = async (sel: string) => (await page.locator(sel).boundingBox())!
  const exp = await box('.exp-win:not(.con-win)')
  const con = await box('.con-win')
  // ① 좌표가 겹치지 않는다(계단식) — 정확히 같은 자리면 아래 창이 있는지도 모른다.
  expect(exp.x).not.toBe(con.x)
  expect(exp.y).not.toBe(con.y)

  const zOf = (sel: string) =>
    page.locator(sel).evaluate((el) => Number(getComputedStyle(el as HTMLElement).zIndex) || 0)
  // ② 나중에 연 콘솔이 위다.
  expect(await zOf('.con-win')).toBeGreaterThan(await zOf('.exp-win:not(.con-win)'))

  // ③ 탐색기를 누르면 앞으로 온다 — 제목줄이 아니라 본문을 눌러도 된다.
  await page.locator('.exp-win:not(.con-win) .exp-tabs').click({ position: { x: 4, y: 4 } })
  expect(await zOf('.exp-win:not(.con-win)')).toBeGreaterThan(await zOf('.con-win'))
})

// EXP-3★ 탐색기는 xterm 을 파괴하지 않는다 — 닫으면 출력·활성 탭·패널이 그대로다.
test('EXP-3★ 탐색기를 열었다 닫아도 터미널 출력·활성 탭·패널이 그대로다', async ({ ara }) => {
  const id = await newLocalShell(ara.page)
  await runCommand(ara.page, id, 'echo EXP3_MARK')
  // /EXP3_MARK/ 하나만 기다리면 **입력 에코**("PS …> echo EXP3_MARK")에 걸린다 — 명령 결과와 다음
  // 프롬프트가 도착하기 전에 before 를 찍고, 탐색기를 여닫는 동안 그것들이 뒤늦게 붙어 마지막
  // 비교가 어긋났다(이 테스트가 간헐 실패하던 이유. 실측 8회 중 1회). 그래서 (1) 마크가 에코+출력
  // 둘 다 보이고 (2) 출력이 더 이상 변하지 않을 때까지 기다린 뒤 스냅샷을 찍는다.
  // 횟수로 세는 방식은 clipboard.spec.ts 가 쓰던 것과 같다.
  const marks = async (): Promise<number> => (await termText(ara.page, id)).split('EXP3_MARK').length - 1
  await expect.poll(marks, { timeout: 20_000, intervals: [200, 300, 500] }).toBe(2)
  let last = ''
  await expect
    .poll(
      async () => {
        const now = await termText(ara.page, id)
        const settled = now === last
        last = now
        return settled
      },
      { timeout: 20_000, intervals: [250, 250, 500] }
    )
    .toBe(true)
  const before = await termText(ara.page, id)
  const paneCountBefore = await ara.page.locator('.pane-grid .pane').count()

  await openExplorer(ara.page)
  await closeExplorer(ara.page)

  await expect(ara.page.locator(`.ttab.active[data-session-id="${id}"]`)).toBeVisible()
  expect(await ara.page.locator('.pane-grid .pane').count()).toBe(paneCountBefore)
  expect(await termText(ara.page, id)).toBe(before)
})

// EXP-4★ 좌측 [서버] 목록에서 서버를 누르면 탭이 열리고 원격 목록이 뜬다.
test('EXP-4★ 좌측 서버 목록에서 서버를 열면 탭이 생기고 원격 파일이 보인다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const h = await ssh({ password: 'pw-exp4', sftpRoot: remote })
  await connectNewSshProfile(ara.page, { name: 'exp4-remote', port: h.port, password: 'pw-exp4' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp4-remote')
  await expect(frow(pane(ara.page), 'remote_readme.txt')).toBeVisible({ timeout: 20_000 })
  // 로컬 탭 + 서버 탭 = 2장.
  await expect(ara.page.locator('.exp-tab:not(.add)')).toHaveCount(2)
})

// EXP-4b 같은 서버를 다시 눌러도 탭이 늘지 않는다(기존 탭으로 간다).
test('EXP-4b 같은 서버를 다시 눌러도 탭이 중복되지 않는다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-exp4b', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp4b-remote', port: h.port, password: 'pw-exp4b' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp4b-remote')
  await navNode(ara.page, 'exp4b-remote').click()
  await expect(ara.page.locator('.exp-tab:not(.add)')).toHaveCount(2)
})

// EXP-4c 탭 드래그로 순서를 바꾼다(준영님 요청 2026-08-13) — 터미널 탭바와 같은 손놀림.
test('EXP-4c★ 탭을 끌어다 놓으면 순서가 바뀐다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-exp4c', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp4c-remote', port: h.port, password: 'pw-exp4c' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp4c-remote')
  const names = () => ara.page.locator('.exp-tab:not(.add) .exp-tab-nm').allInnerTexts()
  const before = await names()
  expect(before).toHaveLength(2)
  // 두 번째(서버) 탭을 첫 번째 자리로.
  await ara.page.locator('.exp-tab:not(.add)').nth(1).dragTo(ara.page.locator('.exp-tab:not(.add)').nth(0))
  await expect.poll(names).toEqual([before[1], before[0]])
})

// EXP-4d 경로 표시줄 — 브레드크럼을 입력으로 바꿔 경로를 직접 치면 그 폴더로 간다(준영님 요청).
test('EXP-4d★ [경로 직접 입력]으로 경로를 쳐서 이동한다', async ({ ara }) => {
  const dir = makeLocalFixture('ara-exp4d-')
  try {
    mkdirSync(join(dir, '목표폴더'))
    writeFileSync(join(dir, '목표폴더', 'hit.txt'), 'hit\n')
    await newLocalShell(ara.page)
    await openExplorer(ara.page)
    const p = pane(ara.page)
    await p.locator('.sb-act[data-action="path.edit"]').click()
    const input = p.locator('.fpath-in')
    await expect(input).toBeVisible()
    await input.fill(join(dir, '목표폴더'))
    await input.press('Enter')
    await expect(frow(p, 'hit.txt')).toBeVisible({ timeout: 15_000 })
    // 이동한 뒤에는 다시 브레드크럼으로 돌아온다.
    await expect(p.locator('.fpath-in')).toHaveCount(0)
    await expect(p.locator('.fcrumb')).toContainText('목표폴더')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// EXP-5 로컬 탭에서 폴더를 더블클릭하면 브레드크럼·목록이 하위 폴더로 이동한다
test('EXP-5 로컬 탭에서 폴더를 더블클릭하면 하위로 이동한다', async ({ ara }) => {
  const dir = makeLocalFixture('ara-exp5-')
  try {
    mkdirSync(join(dir, '하위폴더'))
    writeFileSync(join(dir, '하위폴더', 'inner.txt'), 'inner\n')
    await newLocalShell(ara.page)
    await openExplorer(ara.page)
    const p = pane(ara.page)
    await frow(p, basename(dir) + '/').dblclick()
    await expect(frow(p, '하위폴더/')).toBeVisible({ timeout: 15_000 })
    await frow(p, '하위폴더/').dblclick()
    await expect(frow(p, 'inner.txt')).toBeVisible({ timeout: 15_000 })
    await expect(p.locator('.fcrumb')).toContainText(basename(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// EXP-6★ 다중 선택 → [복사] → 서버 탭에서 [붙여넣기]. 준영님 요구의 핵심 경로다.
test('EXP-6★ 로컬에서 파일 2개를 골라 복사하고 서버 탭에 붙여넣는다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  const dir = makeLocalFixture('ara-exp6-')
  try {
    // 8KB — 작게 유지한다(이 SFTP 하네스는 페이로드가 커질수록 완료 시점이 크게 흔들린다).
    writeFileSync(join(dir, 'one.bin'), Buffer.alloc(8 * 1024, 0x42))
    writeFileSync(join(dir, 'two.bin'), Buffer.alloc(8 * 1024, 0x43))
    const h = await ssh({ password: 'pw-exp6', sftpRoot: remote })
    await connectNewSshProfile(ara.page, { name: 'exp6-remote', port: h.port, password: 'pw-exp6' })
    await openExplorer(ara.page)

    // 로컬 탭에서 두 개 선택 → 복사.
    await ara.page.locator('.exp-tab:has(.exp-tab-nm:text-is("내 PC"))').click()
    const local = pane(ara.page)
    await frow(local, basename(dir) + '/').dblclick()
    await expect(frow(local, 'one.bin')).toBeVisible({ timeout: 15_000 })
    await frow(local, 'one.bin').click()
    await frow(local, 'two.bin').click({ modifiers: ['Control'] })
    await expect(ara.page.locator('.ftcount:visible')).toHaveText('2개 선택')
    await toolBtn(ara.page, '복사').click()

    // 서버 탭으로 옮겨 붙여넣기.
    await openServerTab(ara.page, 'exp6-remote')
    await expect(frow(pane(ara.page), 'remote_readme.txt')).toBeVisible({ timeout: 20_000 })
    await toolBtn(ara.page, '붙여넣기').click()

    await expect.poll(() => existsSync(join(remote, 'one.bin')), { timeout: 90_000 }).toBe(true)
    await expect.poll(() => existsSync(join(remote, 'two.bin')), { timeout: 90_000 }).toBe(true)
    expect(existsSync(join(dir, 'one.bin'))).toBe(true) // 복사 — 원본은 그대로.
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// EXP-7★ 같은 서버 안 복사 — 내려받았다 올리지 않고 서버에서 cp 를 돌린다(sftp:copyRemote).
test('EXP-7★ 같은 서버 안에서 복사·붙여넣기 하면 서버에서 바로 복사된다', async ({ ara, ssh }) => {
  const remote = makeRemote()
  mkdirSync(join(remote, 'dest'))
  const h = await ssh({ password: 'pw-exp7', sftpRoot: remote, execHandler: cpExec(remote) })
  await connectNewSshProfile(ara.page, { name: 'exp7-remote', port: h.port, password: 'pw-exp7' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp7-remote')
  const p = pane(ara.page)
  await expect(frow(p, 'remote_readme.txt')).toBeVisible({ timeout: 20_000 })
  await frow(p, 'remote_readme.txt').click()
  await toolBtn(ara.page, '복사').click()
  await frow(p, 'dest/').dblclick()
  await expect(p.locator('.fcrumb')).toContainText('dest', { timeout: 15_000 })
  await toolBtn(ara.page, '붙여넣기').click()
  await expect.poll(() => existsSync(join(remote, 'dest', 'remote_readme.txt')), { timeout: 60_000 }).toBe(true)
})

// EXP-8 툴바 버튼은 선택 상태를 따른다 — 아무것도 안 골랐으면 복사·삭제가 눌리지 않는다.
test('EXP-8 선택이 없으면 복사·삭제 버튼이 비활성이고, 하나 고르면 이름 변경까지 열린다', async ({ ara }) => {
  const dir = makeLocalFixture('ara-exp8-')
  try {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    await newLocalShell(ara.page)
    await openExplorer(ara.page)
    const p = pane(ara.page)
    await frow(p, basename(dir) + '/').dblclick()
    await expect(frow(p, 'a.txt')).toBeVisible({ timeout: 15_000 })

    await expect(toolBtn(ara.page, '복사')).toBeDisabled()
    await expect(toolBtn(ara.page, '삭제')).toBeDisabled()
    await expect(toolBtn(ara.page, '이름 변경')).toBeDisabled()

    await frow(p, 'a.txt').click()
    await expect(toolBtn(ara.page, '복사')).toBeEnabled()
    await expect(toolBtn(ara.page, '이름 변경')).toBeEnabled()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// EXP-9 탭 닫기 — 마지막 한 장은 닫히지 않는다(빈 창은 보여 줄 게 없다).
test('EXP-9 탭을 닫으면 이웃으로 옮겨가고, 마지막 한 장은 닫기 버튼이 없다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-exp9', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp9-remote', port: h.port, password: 'pw-exp9' })
  await openExplorer(ara.page)
  await expect(ara.page.locator('.exp-tab-x')).toHaveCount(0) // 한 장뿐이면 ✕ 자체가 없다
  await openServerTab(ara.page, 'exp9-remote')
  await expect(ara.page.locator('.exp-tab:not(.add)')).toHaveCount(2)

  await ara.page.locator('.exp-tab.on .exp-tab-x').click()
  await expect(ara.page.locator('.exp-tab:not(.add)')).toHaveCount(1)
  await expect(ara.page.locator('.exp-tab.on .exp-tab-nm')).toHaveText('내 PC')
  await expect(ara.page.locator('.exp-tab-x')).toHaveCount(0)
})

// EXP-10 창 최대화/복원 — 떠 있는 창이라 크기가 바뀐다(전체화면 오버레이가 아니다).
test('EXP-10 최대화하면 창이 화면을 채우고, 다시 누르면 원래 크기로 돌아온다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await openExplorer(ara.page)
  const win = ara.page.locator('.exp-win')
  const before = await win.boundingBox()
  await ara.page.locator('.exp-wbtn:not(.x)').click()
  const maxed = await win.boundingBox()
  expect(maxed!.width).toBeGreaterThan(before!.width)
  await ara.page.locator('.exp-wbtn:not(.x)').click()
  await expect.poll(async () => (await win.boundingBox())!.width, { timeout: 5_000 }).toBe(before!.width)
})

// EXP-11★ 서버 A → 서버 B. SFTP 에 서버 간 전송 op 가 없어 데이터는 우리를 거치지만, main 이 두
// 스트림을 바로 이어 붙인다(디스크 임시 파일 없음). 여기서 검증하는 것은 "두 커넥션이 섞이지 않고
// A 에서 읽어 B 에 쓴다"이다 — 방향이 뒤집히면 원본을 덮어쓸 수 있는 자리라 실물로 확인한다.
test('EXP-11★ 서버 A 의 파일을 서버 B 탭에 붙여넣는다(로컬 경유 없음)', async ({ ara, ssh }) => {
  const rootA = mkdtempSync(join(tmpdir(), 'ara-exp11a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'ara-exp11b-'))
  writeFileSync(join(rootA, 'payload.bin'), Buffer.alloc(8 * 1024, 0x45))
  const a = await ssh({ password: 'pw-a', sftpRoot: rootA })
  const b = await ssh({ password: 'pw-b', sftpRoot: rootB })
  await connectNewSshProfile(ara.page, { name: 'srv-a', port: a.port, password: 'pw-a' })
  await connectNewSshProfile(ara.page, { name: 'srv-b', port: b.port, password: 'pw-b' })
  await openExplorer(ara.page)

  await openServerTab(ara.page, 'srv-a')
  await expect(frow(pane(ara.page), 'payload.bin')).toBeVisible({ timeout: 20_000 })
  await frow(pane(ara.page), 'payload.bin').click()
  await toolBtn(ara.page, '복사').click()

  await openServerTab(ara.page, 'srv-b')
  await expect(pane(ara.page).locator('.sftp-empty')).toBeVisible({ timeout: 20_000 })
  await toolBtn(ara.page, '붙여넣기').click()

  // 크기까지 본다 — SFTP OPEN(w) 만으로도 빈 파일이 생기므로 "존재"만으로는 전송 성공이 아니다.
  await expect.poll(() => (existsSync(join(rootB, 'payload.bin')) ? statSync(join(rootB, 'payload.bin')).size : 0), { timeout: 90_000 }).toBe(8 * 1024)
  expect(existsSync(join(rootA, 'payload.bin'))).toBe(true) // 복사 — 출발지는 그대로.
  await expect(frow(pane(ara.page), 'payload.bin')).toBeVisible({ timeout: 20_000 })
})

// EXP-12 폴더는 서버 사이로 못 옮긴다(스트림 하나 = 파일 하나) — 조용히 실패하지 않고 알린다.
test('EXP-12 폴더만 골라 다른 서버에 붙여넣으면 안내가 뜬다', async ({ ara, ssh }) => {
  const rootA = mkdtempSync(join(tmpdir(), 'ara-exp12a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'ara-exp12b-'))
  mkdirSync(join(rootA, 'onlydir'))
  const a = await ssh({ password: 'pw-a12', sftpRoot: rootA })
  const b = await ssh({ password: 'pw-b12', sftpRoot: rootB })
  await connectNewSshProfile(ara.page, { name: 'a12', port: a.port, password: 'pw-a12' })
  await connectNewSshProfile(ara.page, { name: 'b12', port: b.port, password: 'pw-b12' })
  await openExplorer(ara.page)

  await openServerTab(ara.page, 'a12')
  await frow(pane(ara.page), 'onlydir/').click({ timeout: 20_000 })
  await toolBtn(ara.page, '복사').click()
  await openServerTab(ara.page, 'b12')
  await toolBtn(ara.page, '붙여넣기').click()
  await expect(pane(ara.page).locator('.sftp-err')).toContainText('폴더는', { timeout: 15_000 })
  expect(existsSync(join(rootB, 'onlydir'))).toBe(false)
})
