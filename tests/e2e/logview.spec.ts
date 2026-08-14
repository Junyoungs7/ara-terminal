// W1 F13 로그 뷰어 — SFTP 트리 우클릭 [tail로 보기] → 메인 영역 하단 오버레이(`tail -n 100 -F`).
// 원격 tail 스트림은 ssh2 루프백 하네스의 exec 채널이 만든다(실서버 접속 없음 — DLP).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  connectNewSshProfile,
  makeTelemetry,
  newLocalShell,
  openFileTab,
  runCommand,
  type TeleHarness
} from './fixtures'

type SshFactory = (opts?: {
  password?: string
  sftpRoot?: string
  execHandler?: TeleHarness['exec']
}) => Promise<{ port: number }>

const slash = (p: string) => p.replace(/\\/g, '/')
const row = (page: Page, name: string) => page.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)
const body = (page: Page) => page.locator('.logview .lv-body')

function makeRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'ara-logremote-'))
  mkdirSync(join(root, '로그'))
  writeFileSync(join(root, 'access_20260803.log'), '요청 로그\n')
  writeFileSync(join(root, 'error_운영.log'), '오류 로그\n')
  writeFileSync(join(root, 'README_한글.md'), '# 한글 문서\n')
  return root
}

// SSH 접속 → [파일] 탭(원격 트리)까지.
async function openRemoteTree(
  page: Page,
  ssh: SshFactory,
  tele: TeleHarness,
  name: string
): Promise<{ remote: string; sessionId: string }> {
  const remote = makeRemote()
  const pw = `pw-${name}`
  const h = await ssh({ password: pw, sftpRoot: remote, execHandler: tele.exec })
  const sessionId = await connectNewSshProfile(page, { name, port: h.port, password: pw })
  // Ctrl+Shift+E 는 토글이다 — SSH 접속 직후엔 이미 [파일] 탭이라 오히려 닫힌다(sftp.spec.ts 주석 참조).
  await openFileTab(page)
  await expect(row(page, 'access_20260803.log')).toBeVisible({ timeout: 25_000 })
  return { remote, sessionId }
}

// 파일 행을 선택하고 우클릭해 메뉴를 연다.
async function openRowMenu(page: Page, name: string): Promise<void> {
  await row(page, name).click()
  await row(page, name).click({ button: 'right' })
  await expect(page.locator('.ctx-menu')).toBeVisible()
}

// [tail로 보기] → 뷰어가 뜨고 원격 tail 채널이 열릴 때까지.
async function startTail(page: Page, tele: TeleHarness, name: string): Promise<void> {
  const before = tele.tails.length
  await openRowMenu(page, name)
  await page.click('.ctx-menu .ctx-item[data-action="file.tail"]')
  await expect(page.locator('.logview')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => tele.tails.length, { timeout: 20_000 }).toBe(before + 1)
}

// LOG-1 원격 파일 우클릭 메뉴에 [tail로 보기] 가 있다
test('LOG-1 원격 로그 파일 우클릭에 [tail로 보기] 가 뜬다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log1')
  await openRowMenu(ara.page, 'access_20260803.log')
  // 라벨은 i18n `conn.menu.file.tail` 에서 온다. 두 번 바뀌었다:
  // "tail로 보기" → "실시간 확인"(문구 정리) → **"서버 로그 보기"**(#76 — "로그"라는 이름을 쓰는
  // 것이 둘이라, 찾는 사람이 "로그"로 찾을 수 있어야 한다).
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.tail"]')).toHaveText('서버 로그 보기')
})

// LOG-2 폴더·다중 선택에는 붙지 않는다(tail 은 파일 하나짜리 명령이다)
test('LOG-2 폴더와 다중 선택에는 [tail로 보기] 가 없다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log2')
  await openRowMenu(ara.page, '로그/')
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.tail"]')).toHaveCount(0)
  await ara.page.keyboard.press('Escape')

  await row(ara.page, 'access_20260803.log').click()
  await row(ara.page, 'error_운영.log').click({ modifiers: ['Control'] })
  await row(ara.page, 'error_운영.log').click({ button: 'right' })
  await expect(ara.page.locator('.ctx-menu')).toBeVisible()
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.tail"]')).toHaveCount(0)
})

// LOG-3 로컬 파일에는 붙지 않는다(tail 은 원격 셸에서 도는 명령)
test('LOG-3 로컬 세션 파일에는 [tail로 보기] 가 없다', async ({ ara }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ara-loglocal-'))
  writeFileSync(join(dir, 'local.log'), '로컬 로그\n')
  const id = await newLocalShell(ara.page)
  await runCommand(ara.page, id, `cd "${slash(dir)}"`)
  await openFileTab(ara.page)
  await expect(row(ara.page, 'local.log')).toBeVisible({ timeout: 25_000 })
  await openRowMenu(ara.page, 'local.log')
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.tail"]')).toHaveCount(0)
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.rename"]')).toHaveCount(1)
})

// LOG-4 뷰어가 열리고 한글이 깨지지 않는다 + 헤더에 경로
test('LOG-4 [tail로 보기] 가 로그 뷰어를 열고 한글을 그대로 보여 준다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log4')
  await startTail(ara.page, tele, 'access_20260803.log')
  // -n 0 이 맞다: 과거 줄은 뷰어가 SFTP 로 직접 읽고, tail 은 "지금부터 새로 붙는 줄"만 나른다
  // (둘 다 뱉으면 같은 줄이 두 번 보인다 — src/main/telemetry/LogTail.ts 머리주석). 옛 -n 100 을 물고 있었다.
  expect(tele.tails[0].command).toContain("tail -n 0 -F -- '/access_20260803.log'")
  await expect(ara.page.locator('.logview .lv-path')).toHaveText('/access_20260803.log')
  await expect(ara.page.locator('.logview .lv-live')).toContainText('실시간')

  tele.tails[0].write('2026-08-03 14:02:11 INFO  배포 스크립트 시작 (릴리스 v2.4.1)')
  tele.tails[0].write('2026-08-03 14:02:14 WARN  로그 디렉터리 용량 78%')
  await expect(body(ara.page)).toContainText('배포 스크립트 시작', { timeout: 15_000 })
  await expect(body(ara.page)).toContainText('로그 디렉터리 용량 78%')
})

// LOG-5 새 줄이 실시간으로 붙고 화면이 맨 아래를 따라간다
test('LOG-5 새 로그 줄이 붙고 자동으로 맨 아래로 스크롤한다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log5')
  await startTail(ara.page, tele, 'access_20260803.log')
  for (let i = 1; i <= 120; i++) tele.tails[0].write(`요청 처리 ${i}번째 줄`)
  await expect(body(ara.page)).toContainText('요청 처리 120번째 줄', { timeout: 15_000 })
  const atBottom = () =>
    body(ara.page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4)
  await expect.poll(atBottom, { timeout: 10_000 }).toBe(true)
})

// LOG-6 일시정지는 화면만 멈춘다(줄은 계속 쌓인다)
test('LOG-6 일시정지하면 화면이 따라가지 않는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log6')
  await startTail(ara.page, tele, 'access_20260803.log')
  for (let i = 1; i <= 120; i++) tele.tails[0].write(`정지전 ${i}`)
  await expect(body(ara.page)).toContainText('정지전 120', { timeout: 15_000 })

  await ara.page.click('.logview .lv-head .ts-btn:has-text("일시정지")')
  await expect(ara.page.locator('.logview .lv-dot.paused')).toHaveCount(1)
  await expect(ara.page.locator('.logview .lv-head .ts-btn').first()).toHaveText('재개')
  const frozen = await body(ara.page).evaluate((el) => el.scrollTop)

  for (let i = 1; i <= 120; i++) tele.tails[0].write(`정지중 ${i}`)
  // 줄은 계속 쌓이지만(멈춘 사이 로그를 버리지 않는다) 화면은 그 자리에 있다.
  await expect(body(ara.page)).toContainText('정지중 120', { timeout: 15_000 })
  expect(await body(ara.page).evaluate((el) => el.scrollTop)).toBe(frozen)
})

// LOG-7 재개하면 멈춘 동안 온 줄까지 포함해 맨 아래로 복귀
test('LOG-7 재개하면 밀린 줄까지 따라잡는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log7')
  await startTail(ara.page, tele, 'access_20260803.log')
  for (let i = 1; i <= 60; i++) tele.tails[0].write(`앞줄 ${i}`)
  await expect(body(ara.page)).toContainText('앞줄 60', { timeout: 15_000 })
  await ara.page.click('.logview .lv-head .ts-btn:has-text("일시정지")')
  for (let i = 1; i <= 120; i++) tele.tails[0].write(`밀린줄 ${i}`)
  await expect(body(ara.page)).toContainText('밀린줄 120', { timeout: 15_000 })

  await ara.page.click('.logview .lv-head .ts-btn:has-text("재개")')
  await expect(ara.page.locator('.logview .lv-dot.paused')).toHaveCount(0)
  await expect
    .poll(() => body(ara.page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4), {
      timeout: 10_000
    })
    .toBe(true)
})

// LOG-8 닫으면 원격 tail 채널까지 정리된다(서버에 프로세스를 남기지 않는다)
test('LOG-8 뷰어를 닫으면 원격 tail 채널이 닫힌다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log8')
  await startTail(ara.page, tele, 'access_20260803.log')
  expect(tele.tails[0].closed).toBe(false)
  await ara.page.click('.logview .lv-head .ts-btn[title="서버 로그 닫기"], .logview .lv-head .ts-btn[data-tip="서버 로그 닫기"]')
  await expect(ara.page.locator('.logview')).toHaveCount(0)
  await expect.poll(() => tele.tails[0].closed, { timeout: 15_000 }).toBe(true)
})

// LOG-9 다른 파일로 갈아타면 이전 스트림이 정리된다
test('LOG-9 다른 로그 파일로 갈아타면 이전 스트림이 닫힌다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log9')
  await startTail(ara.page, tele, 'access_20260803.log')
  tele.tails[0].write('첫 파일 내용')
  await expect(body(ara.page)).toContainText('첫 파일 내용', { timeout: 15_000 })

  await startTail(ara.page, tele, 'error_운영.log')
  await expect(ara.page.locator('.logview .lv-path')).toHaveText('/error_운영.log')
  await expect(body(ara.page)).not.toContainText('첫 파일 내용')
  tele.tails[1].write('두 번째 파일 내용')
  await expect(body(ara.page)).toContainText('두 번째 파일 내용', { timeout: 15_000 })
  await expect.poll(() => tele.tails[0].closed, { timeout: 15_000 }).toBe(true)
})

// LOG-10 tail 이 실패해도(없는 파일) 문구만 보이고 앱은 멀쩡하다
test('LOG-10 없는 파일이면 tail 오류가 본문에 보인다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await openRemoteTree(ara.page, ssh, tele, 'log10')
  await startTail(ara.page, tele, 'access_20260803.log')
  // tail 의 stderr 도 사용자가 봐야 할 내용이다 — 같은 본문으로 온다.
  tele.tails[0].writeErr("tail: cannot open '/access_20260803.log' for reading: No such file or directory")
  await expect(body(ara.page)).toContainText('cannot open', { timeout: 15_000 })
  await expect(ara.page.locator('.app')).toBeVisible()
  await expect(ara.page.locator('.dlg-overlay')).toHaveCount(0)
})
