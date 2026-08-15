// 서버 작업대(#91, src/renderer/components/WorkbenchView.tsx) — 진입/종료 · 좌측에서 대상 고르기 ·
// 도구 탭 · 다중 선택 복사/붙여넣기(로컬→원격, 같은 서버 안) · 아라 연결점(WB, #88 R1) ·
// 탐색기 따라잡기(FM, #88 R2).
// 2패널 모드(구 F20)는 없어졌다 — "복사 →/이동 →" 우클릭 항목 대신 클립보드가 그 자리를 대신한다.
// (파일명이 explorer.spec.ts 인 것은 이력이다 — ExplorerView 는 #91 에서 WorkbenchView 로 흡수됐다.)
// DLP: 전송은 전부 루프백(127.0.0.1) SSH 하네스와 OS 임시 디렉토리 사이에서만 한다(실서버·실데이터 금지).
import { cpSync, mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { ServerChannel } from 'ssh2'
import { test, expect, newLocalShell, runCommand, termText, connectNewSshProfile, dialogConfirm } from './fixtures'

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

/**
 * 로컬 픽스처는 **OS 임시 폴더**에 만든다. 예전에는 홈 바로 아래에 만들었는데(트리가 홈에서
 * 시작하고 임의 경로로 점프할 입구가 없어서), 그러면 실행이 중간에 끊길 때마다 준영님 홈에
 * `ara-wb2-…` 같은 폴더가 남는다 — 실제로 남았다. 지금은 경로 줄(#59 [경로 입력])로 어디든
 * 갈 수 있으므로 gotoPath() 로 들어간다. 하네스는 사용자 PC 를 건드리지 않는다.
 */
function makeLocalFixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 경로 줄에 직접 쳐서 그 폴더로 간다(홈 밑이 아니어도 닿는다). */
async function gotoPath(page: Page, dir: string): Promise<void> {
  const p = pane(page)
  await p.locator('[data-action="path.edit"]').click()
  await p.locator('input[data-field="path"]').fill(dir)
  await p.locator('input[data-field="path"]').press('Enter')
  await expect(p.locator('.fcrumb')).toContainText(basename(dir), { timeout: 15_000 })
}

/**
 * #88 R1: 그 폴더에서 셸을 열면 프로세스가 cwd 로 **잡고 있어** 바로 지울 수 없다(Windows EBUSY).
 * 세션을 먼저 닫고 잠깐 재시도한다 — 홈 폴더에 테스트 잔여물을 남기지 않는다.
 */
async function cleanupFixture(page: Page, dir: string): Promise<void> {
  await page
    .evaluate(async () => {
      for (const s of await window.ev.session.list()) await window.ev.session.destroy(s.id)
    })
    .catch(() => {})
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await page.waitForTimeout(250)
    }
  }
  // 20번(5초)을 넘겨도 잡혀 있으면 그 사실을 드러낸다 — 조용히 남기지 않는다.
  rmSync(dir, { recursive: true, force: true })
}

async function openExplorer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+O')
  await expect(page.locator('.exp-win')).toBeVisible({ timeout: 10_000 })
}

async function closeExplorer(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+O')
  // #74: 창은 닫아도 언마운트하지 않는다(탭·경로를 기억한다) — 사라지는 게 아니라 숨는다.
  await expect(page.locator('.exp-win')).not.toBeVisible({ timeout: 10_000 })
}

/** 지금 보이는 탭의 파일 영역. 숨은 탭도 DOM 에 남아 있으므로(폴더를 기억하려고) :visible 로 고른다. */
const pane = (page: Page): Locator => page.locator('.exp-pane:visible')
const frow = (scope: Locator, name: string): Locator => scope.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)
const navNode = (page: Page, name: string): Locator => page.locator(`.exp-node:has(.nm:text-is("${name}"))`)
// 숨은 탭에도 툴바가 하나씩 있다(폴더를 기억하려고 마운트를 유지한다) — 보이는 탭으로 좁힌다.
const toolBtn = (page: Page, label: string): Locator => pane(page).locator(`.ftool .ftb:has(span:text-is("${label}"))`)

/**
 * #91: 위치 탭이 없어졌다 — 좌측이 **대상 하나**를 정하고 상단 탭은 **도구**다.
 * 서버를 고른 뒤 [파일] 도구를 연다(대상을 바꾸면 열린 도구가 접히므로 매번 연다).
 */
async function openServerTab(page: Page, profileName: string): Promise<void> {
  await navNode(page, profileName).click()
  await expect(page.locator('.wb-win .con-srv')).toHaveText(profileName, { timeout: 30_000 })
  await openFiles(page)
}

/** 지금 대상의 [파일] 도구를 연다(이미 열려 있으면 그 탭으로 간다). */
async function openFiles(page: Page): Promise<void> {
  const tab = page.locator('.wb-win .exp-tab[data-tab="files"]')
  if ((await tab.count()) === 0) await page.click('.wb-pad .con-app[data-tool="files"]')
  else await tab.click()
  await expect(page.locator('.wb-win .exp-tab.on[data-tab="files"]')).toBeVisible({ timeout: 30_000 })
}

/** 내 PC 를 고르고 [파일] 을 연다. */
async function openLocalFiles(page: Page): Promise<void> {
  await navNode(page, '홈 폴더').click()
  await openFiles(page)
}

// EXP-1 Ctrl+Shift+O 로 떠 있는 창이 열린다 — 본문(.middle)은 **가려지지 않는다**(구 전체화면 모드와 다름).
test('EXP-1 Ctrl+Shift+O 로 작업대가 열리고 터미널 본문은 그대로 보인다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await openExplorer(ara.page)
  await expect(ara.page.locator('.middle')).toBeVisible()
  // #91: 열자마자 [홈] 격자 하나. 대상은 **내 PC** 가 기본이고 제목줄에 찍힌다.
  await expect(ara.page.locator('.exp-tab')).toHaveCount(1)
  await expect(ara.page.locator('.exp-tab.on[data-tab="home"]')).toBeVisible()
  await expect(ara.page.locator('.wb-win .con-srv')).toHaveText('내 PC')
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

// EXP-13★ #91: 떠 있는 창이 **하나**가 됐다 — 탐색기와 서버 콘솔이 [서버 작업대]로 합쳐졌다.
// 원래 검사(둘이 같은 좌표에서 시작해 아래 창을 꺼낼 수 없던 문제, #72)는 창이 둘일 때의 것이다.
// 지금 지킬 성질은 "창이 정말 하나인가" — 둘로 되돌아가면 그 겹침 문제도 같이 돌아온다.
test('EXP-13★ 떠 있는 창은 작업대 하나뿐이다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)

  await page.click('.act-item[data-activity="explorer"]')
  await expect(page.locator('.wb-win')).toBeVisible()
  // 액티비티 바에 [서버 콘솔] 항목 자체가 없다(작업대에 흡수됐다).
  await expect(page.locator('.act-item[data-activity="console"]')).toHaveCount(0)
  await expect(page.locator('.exp-win')).toHaveCount(1)

  // 창을 눌러도(본문이든 탭바든) 살아 있고 앞으로 온다 — z 는 여전히 관리된다.
  await page.locator('.wb-win .exp-tabs').click({ position: { x: 4, y: 4 } })
  await expect(page.locator('.wb-win')).toBeVisible()
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
  // #91: 탭은 [홈]+[파일] 둘이고, **어느 서버인지는 제목줄**이 말한다(옛 위치 탭 대신).
  await expect(ara.page.locator('.exp-tab')).toHaveCount(2)
  await expect(ara.page.locator('.wb-win .con-srv')).toHaveText('exp4-remote')
  await expect(ara.page.locator(`.exp-node.on:has(.nm:text-is("exp4-remote"))`)).toBeVisible()
})

// EXP-4b #91: 대상은 **하나**다 — 같은 서버를 다시 눌러도 아무 일이 없고(열린 도구도 그대로),
// 다른 서버를 누르면 도구가 접히고 [홈] 으로 돌아간다(어느 서버 것인지 헷갈리지 않게).
test('EXP-4b 같은 서버를 다시 눌러도 그대로, 다른 서버면 [홈] 으로 돌아간다', async ({ ara, ssh }) => {
  const hA = await ssh({ password: 'pw-exp4bA', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp4bA', port: hA.port, password: 'pw-exp4bA' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp4bA')

  // 같은 서버 다시 — [파일] 탭이 그대로 열려 있다.
  await navNode(ara.page, 'exp4bA').click()
  await expect(ara.page.locator('.exp-tab.on[data-tab="files"]')).toBeVisible()
  await expect(ara.page.locator('.exp-tab')).toHaveCount(2)

  // 다른 대상(내 PC)으로 — 도구가 접히고 [홈] 이 활성이 된다.
  await navNode(ara.page, '홈 폴더').click()
  await expect(ara.page.locator('.exp-tab.on[data-tab="home"]')).toBeVisible()
  await expect(ara.page.locator('.exp-tab')).toHaveCount(1)
  await expect(ara.page.locator('.wb-win .con-srv')).toHaveText('내 PC')
})

// EXP-4c★ #91: 탭 드래그(위치 탭 순서 바꾸기, 2026-08-13)는 위치 탭과 함께 사라졌다.
// 그 자리를 잇는 성질: **도구 탭을 닫으면 [홈] 으로 돌아간다** — 돌아갈 곳이 없어지면 안 된다(#69).
test('EXP-4c★ 도구 탭을 닫으면 [홈] 으로 돌아간다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-exp4c', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp4c-remote', port: h.port, password: 'pw-exp4c' })
  await openExplorer(ara.page)
  await openServerTab(ara.page, 'exp4c-remote')

  await ara.page.click('.exp-tab[data-tab="files"] .exp-tab-x')
  await expect(ara.page.locator('.exp-tab')).toHaveCount(1)
  await expect(ara.page.locator('.exp-tab.on[data-tab="home"]')).toBeVisible()
  // [홈] 에는 닫기 버튼이 없다 — 마지막 한 장이자 돌아갈 곳이다.
  await expect(ara.page.locator('.exp-tab[data-tab="home"] .exp-tab-x')).toHaveCount(0)
})

// EXP-4d 경로 표시줄 — 브레드크럼을 입력으로 바꿔 경로를 직접 치면 그 폴더로 간다(준영님 요청).
test('EXP-4d★ [경로 직접 입력]으로 경로를 쳐서 이동한다', async ({ ara }) => {
  const dir = makeLocalFixture('ara-exp4d-')
  try {
    mkdirSync(join(dir, '목표폴더'))
    writeFileSync(join(dir, '목표폴더', 'hit.txt'), 'hit\n')
    await newLocalShell(ara.page)
    await openExplorer(ara.page)
    await openLocalFiles(ara.page)
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
    await openLocalFiles(ara.page)
    const p = pane(ara.page)
    await gotoPath(ara.page, dir)
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

    // #91: 위치 탭이 없다 — 좌측에서 [내 PC] 를 고르고 [파일] 을 연다.
    await openLocalFiles(ara.page)
    const local = pane(ara.page)
    await gotoPath(ara.page, dir)
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
    await openLocalFiles(ara.page)
    const p = pane(ara.page)
    await gotoPath(ara.page, dir)
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

// EXP-9 #91: [홈] 은 닫을 수 없다 — 마지막 한 장이자 **돌아갈 곳**이다(#69).
// 도구 탭을 닫으면 [홈] 으로 간다(옛 "이웃으로 옮겨간다"를 대신하는 규칙 — 도구는 서로 이웃이
// 아니라 전부 [홈] 에서 갈라져 나온 것이다).
test('EXP-9 도구 탭만 닫히고 [홈] 은 남는다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-exp9', sftpRoot: makeRemote() })
  await connectNewSshProfile(ara.page, { name: 'exp9-remote', port: h.port, password: 'pw-exp9' })
  await openExplorer(ara.page)
  await expect(ara.page.locator('.exp-tab-x')).toHaveCount(0) // [홈] 뿐이면 ✕ 자체가 없다
  await openServerTab(ara.page, 'exp9-remote')
  await expect(ara.page.locator('.exp-tab')).toHaveCount(2)

  await ara.page.locator('.exp-tab.on .exp-tab-x').click()
  await expect(ara.page.locator('.exp-tab')).toHaveCount(1)
  await expect(ara.page.locator('.exp-tab.on[data-tab="home"]')).toBeVisible()
  await expect(ara.page.locator('.exp-tab-x')).toHaveCount(0)
})

// EXP-10 창 최대화/복원 — 떠 있는 창이라 크기가 바뀐다(전체화면 오버레이가 아니다).
test('EXP-10 최대화하면 창이 화면을 채우고, 다시 누르면 원래 크기로 돌아온다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await openExplorer(ara.page)
  const win = ara.page.locator('.wb-win')
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

// ── #88 R1(2026-08-16) 아라 연결점 ────────────────────────────────────────────
// 준영님: "차이점은 우리 아라와 연결된다는 점이지."
// 윈도우 탐색기를 흉내 내는 것이 값어치가 아니라, **폴더를 찾은 다음 개발자가 하는 일**이
// 그 자리에서 바로 이어지는 것이 값어치다. 그래서 이 셋은 탐색기에 없는 것들이다.

test('WB-1★ 로컬 폴더 우클릭에 아라 연결점 셋이 있다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openExplorer(page)
  await openLocalFiles(page)

  await pane(page).locator('.ftree').click({ button: 'right', position: { x: 10, y: 4 } })
  const menu = page.locator('.ctx-menu')
  await expect(menu.locator('[data-action="file.terminal"]')).toBeVisible()
  await expect(menu.locator('[data-action="file.aicli"]')).toBeVisible()
  await expect(menu.locator('[data-action="file.saveWork"]')).toBeVisible()
  await page.keyboard.press('Escape')
})

// WB-2★ [여기서 터미널 열기] — 그 폴더를 cwd 로 새 셸. 탐색기에 없는 것이고 제일 자주 한다.
test('WB-2★ [여기서 터미널 열기]가 그 폴더에서 새 셸을 연다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-wb2-')
  try {
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)

    const before = await page.locator('.term-tabbar .ttab').count()
    await p.locator('.ftree').click({ button: 'right', position: { x: 10, y: 4 } })
    await page.click('.ctx-menu [data-action="file.terminal"]')

    // 새 세션이 생기고 창은 물러난다(터미널이 보여야 한다).
    await expect(page.locator('.term-tabbar .ttab')).toHaveCount(before + 1, { timeout: 30_000 })
    await expect(page.locator('.wb-win')).not.toBeVisible()
    // 그 폴더에서 시작했다 — 상태바 cwd 로 확인한다.
    await expect(page.locator('.statusbar .sb-seg.cwd .val')).toContainText(basename(dir), { timeout: 25_000 })
  } finally {
    await cleanupFixture(page, dir)
  }
})

// WB-3★ [아라에게 물어보기] — 고른 것의 **경로만** 아라 입력창에 얹는다.
// 내용을 통째로 싣지 않는다: #80 예산이 있고, 무엇이 가는지 사용자가 보고 고를 수 있어야 한다.
test('WB-3★ [아라에게 물어보기]가 경로를 아라 입력창에 얹는다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-wb3-')
  try {
    writeFileSync(join(dir, 'target.txt'), 'x\n')
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(frow(p, 'target.txt')).toBeVisible({ timeout: 15_000 })

    await frow(p, 'target.txt').click()
    await frow(p, 'target.txt').click({ button: 'right' })
    await page.click('.ctx-menu [data-action="file.askAi"]')

    await expect(page.locator('.ai-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.ai-panel .ai-input')).toHaveValue(/target\.txt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// WB-4★ #90 이후 [이 폴더에서 AI CLI 시작]이 **로컬에도** 붙는다.
// 그전에는 "이 창은 서버에 접속해서 시작"이라 원격 폴더에만 있었다 — 내 PC 에서도 되면서
// 그 전제가 사라졌다.
test('WB-4★ 로컬 폴더에서도 AI CLI 시작 창이 그 폴더로 열린다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-wb4-')
  try {
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)

    await p.locator('.ftree').click({ button: 'right', position: { x: 10, y: 4 } })
    await page.click('.ctx-menu [data-action="file.aicli"]')

    const modal = page.locator('.aicli-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    // 대상은 내 PC, 폴더는 방금 보던 곳.
    await expect(modal.locator('.dd-val').first()).toHaveText('내 PC')
    await expect(modal.locator('input.dlg-input').first()).toHaveValue(new RegExp(basename(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── #88 R2(2026-08-16) 탐색기 따라잡기 ────────────────────────────────────────
// 준영님: "실제 finder, 윈도우 파일 탐색기에서 제공하는 기능은 모두 제공해야하지."
// 하나하나는 작지만, 없으면 "이건 탐색기가 아니다"가 되는 칸들이다.

// 보기 서브메뉴 항목 하나를 고른다(정렬·숨김은 탐색기처럼 빈 영역 우클릭 안에 있다).
async function pickView(page: Page, action: string): Promise<void> {
  await pane(page).locator('.ftree').click({ button: 'right', position: { x: 10, y: 4 } })
  await page.locator('.ctx-menu [data-action="file.view"]').hover()
  await page.click(`.ctx-submenu [data-action="${action}"]`)
}

// FM-1★ 숨김 토글. 기본은 **보인다** — 여기 오는 사람은 .git·.env 를 찾으러 온다.
test('FM-1★ 숨김 항목을 감췄다 다시 본다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-fm1-')
  try {
    writeFileSync(join(dir, '.env'), 'X=1\n')
    writeFileSync(join(dir, 'plain.txt'), 'x\n')
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(frow(p, '.env')).toBeVisible({ timeout: 15_000 })

    await pickView(page, 'file.hidden')
    await expect(frow(p, '.env')).toHaveCount(0)
    await expect(frow(p, 'plain.txt')).toBeVisible()
    // 왜 줄었는지 상태 표시줄이 말한다 — 안 그러면 파일이 사라진 것으로 보인다.
    await expect(p.locator('.fstat')).toContainText('숨김 1')

    await pickView(page, 'file.hidden')
    await expect(frow(p, '.env')).toBeVisible()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// FM-2★ 정렬 — 같은 기준을 다시 고르면 방향이 뒤집힌다(탐색기 열 머리글과 같은 규칙).
// 폴더는 방향과 무관하게 늘 위다.
test('FM-2★ 크기순으로 정렬하고 방향을 뒤집는다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-fm2-')
  try {
    writeFileSync(join(dir, 'small.txt'), 'a')
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(5_000))
    mkdirSync(join(dir, 'adir'))
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(frow(p, 'big.txt')).toBeVisible({ timeout: 15_000 })
    const order = (): Promise<string[]> => p.locator('.ftree .frow .fn').allInnerTexts()

    await pickView(page, 'file.sort.size')
    expect(await order()).toEqual(['adir/', 'small.txt', 'big.txt'])

    await pickView(page, 'file.sort.size')
    expect(await order()).toEqual(['adir/', 'big.txt', 'small.txt']) // 뒤집혀도 폴더는 위
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// FM-3★ 잘라내기 → 붙여넣기 = **이동**. 복사+휴지통이 아니다(원본이 휴지통에 쌓이면 안 된다).
test('FM-3★ 잘라내기로 파일을 다른 폴더로 옮긴다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-fm3-')
  try {
    writeFileSync(join(dir, 'move_me.txt'), 'hello\n')
    mkdirSync(join(dir, 'dest'))
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(frow(p, 'move_me.txt')).toBeVisible({ timeout: 15_000 })

    await frow(p, 'move_me.txt').click()
    await toolBtn(page, '잘라내기').click()
    await frow(p, 'dest/').dblclick()
    await expect(p.locator('.fcrumb')).toContainText('dest', { timeout: 15_000 })
    await toolBtn(page, '붙여넣기').click()
    await expect(frow(p, 'move_me.txt')).toBeVisible({ timeout: 15_000 })

    expect(existsSync(join(dir, 'dest', 'move_me.txt'))).toBe(true)
    expect(existsSync(join(dir, 'move_me.txt'))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// FM-4★ 새 파일 + 상태 표시줄. 폴더만 만들 수 있는 파일 관리자는 반쪽이다.
test('FM-4★ 새 파일을 만들고 상태 표시줄이 개수를 센다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-fm4-')
  try {
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(p.locator('.fstat')).toContainText('0개 항목', { timeout: 15_000 })

    await toolBtn(page, '새 파일').click()
    await page.fill('.dlg-input', '메모.txt')
    await dialogConfirm(page)
    await expect(frow(p, '메모.txt')).toBeVisible({ timeout: 15_000 })
    await expect(p.locator('.fstat')).toContainText('1개 항목')

    await frow(p, '메모.txt').click()
    await expect(p.locator('.fstat')).toContainText('1개 선택')
    expect(existsSync(join(dir, '메모.txt'))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// FM-5★ 이름 검색(이 폴더 안) + 뒤로/앞으로. 브레드크럼·[상위로]가 못 하는 것: 왔던 자리로 돌아오기.
test('FM-5★ 이름으로 거르고, 뒤로·앞으로 오간다', async ({ ara }) => {
  const { page } = ara
  const dir = makeLocalFixture('ara-fm5-')
  try {
    writeFileSync(join(dir, 'alpha.txt'), 'a')
    writeFileSync(join(dir, 'beta.txt'), 'b')
    mkdirSync(join(dir, 'sub'))
    await newLocalShell(page)
    await openExplorer(page)
    await openLocalFiles(page)
    const p = pane(page)
    await gotoPath(page, dir)
    await expect(frow(p, 'beta.txt')).toBeVisible({ timeout: 15_000 })

    await p.locator('[data-action="file.filter"]').click()
    await p.locator('input[data-field="filter"]').fill('alp')
    await expect(frow(p, 'beta.txt')).toHaveCount(0)
    await expect(frow(p, 'alpha.txt')).toBeVisible()
    await expect(p.locator('.fstat')).toContainText('검색 결과')

    // 폴더를 옮기면 검색어는 저절로 털린다 — 남아 있으면 새 폴더가 비어 보인다.
    await p.locator('input[data-field="filter"]').press('Escape')
    await frow(p, 'sub/').dblclick()
    await expect(p.locator('.fcrumb')).toContainText('sub', { timeout: 15_000 })
    await expect(p.locator('input[data-field="filter"]')).toHaveCount(0)

    await p.locator('[data-action="hist.back"]').click()
    await expect(frow(p, 'beta.txt')).toBeVisible({ timeout: 15_000 })
    await p.locator('[data-action="hist.fwd"]').click()
    await expect(p.locator('.fcrumb')).toContainText('sub', { timeout: 15_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// FM-6★ 원격은 **현행 유지**다. 잘라내기·새 파일·[윈도우 탐색기에서 보기]는 로컬 전용 —
// 원격 파일은 실체가 이 PC 에 없고, 반쯤 올라간 파일을 원본 삭제로 갚을 수 없다.
test('FM-6★ 원격 메뉴에는 로컬 전용 항목이 없다', async ({ ara, ssh }) => {
  const { page } = ara
  const remote = makeRemote()
  try {
    const h = await ssh({ password: 'pw-fm6', sftpRoot: remote })
    await connectNewSshProfile(page, { name: 'fm6', port: h.port, password: 'pw-fm6' })
    await openExplorer(page)
    await openServerTab(page, 'fm6')
    const p = pane(page)
    await expect(frow(p, 'remote_readme.txt')).toBeVisible({ timeout: 20_000 })

    await p.locator('.ftree').click({ button: 'right', position: { x: 10, y: 4 } })
    const menu = page.locator('.ctx-menu')
    await expect(menu.locator('[data-action="file.paste"]')).toBeVisible()
    await expect(menu.locator('[data-action="file.cut"]')).toHaveCount(0)
    await expect(menu.locator('[data-action="file.newFile"]')).toHaveCount(0)
    await expect(menu.locator('[data-action="file.reveal"]')).toHaveCount(0)
    // 보기(정렬·숨김)는 원격에도 있다 — 목록을 어떻게 볼지는 화면의 문제라 백엔드와 무관하다.
    await expect(menu.locator('[data-action="file.view"]')).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    rmSync(remote, { recursive: true, force: true })
  }
})
