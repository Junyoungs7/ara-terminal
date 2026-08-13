// F27 AI CLI 한 번에 시작 — 진입점 넷에서 창이 열리고, 그 창이 보여 준 줄이 **그대로** 원격 셸로 간다.
//
// 이 파일이 지키는 가장 중요한 성질은 AICLI-5 다: **"보낼 명령" 줄과 실제 전송 문자열이 같다.**
// 화면 텍스트를 읽어 두고, ssh2 루프백 하네스가 shell 채널로 실제로 받은 바이트와 대조한다
// (`--dangerously-skip-permissions` 는 권한 확인을 끄는 플래그라 무엇이 실행되는지 감추면 안 된다).
//
// 그다음이 AICLI-7 이다: CLI 가 없는 서버면 **아무것도 전송하지 않는다** — 다이얼로그가 떴는지가
// 아니라 하네스가 받은 입력 수를 세서 판정한다(F26 CON-6/CON-7 과 같은 방식).
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, openConnTab, openFileTab, REPO_ROOT } from './fixtures'

const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(REPO_ROOT, 'agent_talk', name) })

type CliHarness = {
  /** installed=false 면 `command -v` 가 빈 출력 + 종료코드 1 — 실제로 없는 서버와 같다. */
  state: { installed: boolean }
  /** shell 채널로 실제로 들어온 입력. 전송이 없었으면 비어 있어야 한다. */
  inputs: string[]
  /** 원격에 나간 `command -v` 명령들. */
  which: string[]
  exec: (command: string, stream: ServerChannel) => void
  onShellData: (data: string) => void
}

function makeCli(installed = true): CliHarness {
  const h: CliHarness = {
    state: { installed },
    inputs: [],
    which: [],
    exec: (command, stream) => {
      if (command.startsWith('command -v')) {
        h.which.push(command)
        if (h.state.installed) stream.write('/usr/local/bin/claude\n')
        stream.exit(h.state.installed ? 0 : 1)
        stream.end()
        return
      }
      stream.exit(0)
      stream.end()
    },
    onShellData: (d) => h.inputs.push(d)
  }
  return h
}

const modal = (page: Page) => page.locator('.aicli-modal')
const preview = (page: Page) => page.locator('.aicli-modal .aicli-cmd')
const pathInput = (page: Page) => page.locator('.aicli-modal input.dlg-input').first()
const startBtn = (page: Page) => page.locator('.aicli-modal [data-action="aicli.start"]')

// 접속 + AI CLI 창을 단축키로 연다(가장 짧은 경로 — 진입점 자체는 AICLI-1~4 가 따로 본다).
async function connectAndOpen(page: Page, name: string, port: number, password: string): Promise<void> {
  await connectNewSshProfile(page, { name, port, password })
  await page.keyboard.press('Control+Shift+L')
  await expect(modal(page)).toBeVisible({ timeout: 10_000 })
}

// AICLI-1 진입점 ① 탭바 ＋ 우클릭.
test('AICLI-1 탭바 ＋ 메뉴에서 창이 열린다', async ({ ara, ssh }) => {
  const cli = makeCli()
  await ssh({ password: 'pw-a1', execHandler: cli.exec })
  await ara.page.click('.tterm-add', { button: 'right' })
  await expect(ara.page.locator('.ctx-menu [data-action="aicli.start"]')).toBeVisible()
  await ara.page.click('.ctx-menu [data-action="aicli.start"]')
  await expect(modal(ara.page)).toBeVisible()
  // 저장해 둔 것이 하나도 없어도 창은 열린다 — 저장은 전제가 아니다.
  await expect(ara.page.locator('.aicli-none')).toBeVisible()
})

// AICLI-2 진입점 ② 단축키. 치트시트에도 실려 있어야 한다("구현된 것만 싣는다" 규칙).
test('AICLI-2 Ctrl+Shift+L 로 열리고 치트시트에 실려 있다', async ({ ara }) => {
  await ara.page.keyboard.press('Control+Shift+L')
  await expect(modal(ara.page)).toBeVisible()
  await ara.page.keyboard.press('Escape')
  await expect(modal(ara.page)).toHaveCount(0)
  await ara.page.keyboard.press('?')
  await expect(ara.page.locator('.cheatsheet')).toContainText('AI CLI 시작')
  await expect(ara.page.locator('.cheatsheet')).toContainText('Ctrl+Shift+L')
})

// AICLI-3 진입점 ④ 서버 트리 우클릭 — 그 서버가 이미 정해진 채로 열린다.
test('AICLI-3 서버 우클릭이면 서버가 채워진 채로 열린다', async ({ ara, ssh }) => {
  const cli = makeCli()
  const h = await ssh({ password: 'pw-a3', execHandler: cli.exec })
  await connectNewSshProfile(ara.page, { name: 'a3srv', port: h.port, password: 'pw-a3' })
  await openConnTab(ara.page)
  await ara.page.locator('.srv-node').first().click({ button: 'right' })
  await ara.page.click('.ctx-menu [data-action="aicli.start"]')
  await expect(modal(ara.page)).toBeVisible()
  await expect(modal(ara.page).locator('.dd-val')).toHaveText(['a3srv', 'Claude Code'])
})

// AICLI-4 진입점 ③ 파일 트리 폴더 우클릭 — 그 폴더가 채워진 채로 열린다.
test('AICLI-4 원격 폴더 우클릭이면 폴더가 채워진 채로 열린다', async ({ ara, ssh }) => {
  const root = mkdtempSync(join(tmpdir(), 'ara-aicli-'))
  const cli = makeCli()
  const h = await ssh({ password: 'pw-a4', execHandler: cli.exec, sftpRoot: root })
  await connectNewSshProfile(ara.page, { name: 'a4srv', port: h.port, password: 'pw-a4' })
  await openFileTab(ara.page)
  // 트리에서 새 폴더를 하나 만들고 그 폴더를 우클릭한다(실사용 경로 — "찾기"가 이 자리다).
  await ara.page.locator('.sb-panel.active .ftree').click({ button: 'right' })
  await ara.page.click('.ctx-menu [data-action="file.mkdir"]')
  await dialog(ara.page).locator('.dlg-input').fill('erp')
  await dialog(ara.page).locator('.modal-ft .btn.pri').click()
  const folder = ara.page.locator('.sb-panel.active .ftree .frow:has(.fn:text-is("erp/"))')
  await expect(folder).toBeVisible({ timeout: 20_000 })

  await folder.click({ button: 'right' })
  await ara.page.click('.ctx-menu [data-action="file.aicli"]')
  await expect(modal(ara.page)).toBeVisible()
  await expect(pathInput(ara.page)).toHaveValue('/erp')
  await expect(preview(ara.page)).toHaveText("cd '/erp' && claude --dangerously-skip-permissions -r")
})

// AICLI-5★ 화면이 보여 준 줄 = 원격 셸이 실제로 받은 줄.
test('AICLI-5 [시작]은 "보낼 명령" 줄을 글자 하나 다르지 않게 전송한다', async ({ ara, ssh }) => {
  const cli = makeCli()
  const h = await ssh({
    password: 'pw-a5',
    execHandler: cli.exec,
    onShellData: cli.onShellData,
    sftpRoot: mkdtempSync(join(tmpdir(), 'ara-aicli-')),
    // 셸이 준비됐다는 신호(원격 /proc cwd)를 실제로 내보내는 서버 — waitShellReady 가 이걸 기다린다.
    procCwd: { pid: 4242, initial: '/home/tester' }
  })
  await connectAndOpen(ara.page, 'a5srv', h.port, 'pw-a5')

  await pathInput(ara.page).fill('~/projects/신규 작업')
  // 물결표는 따옴표 밖이다 — `cd '~/x'` 는 홈으로 펼쳐지지 않아 실패한다.
  const shown = (await preview(ara.page).textContent()) ?? ''
  expect(shown).toBe("cd ~/'projects/신규 작업' && claude --dangerously-skip-permissions -r")

  const before = cli.inputs.length
  await startBtn(ara.page).click()
  await expect(modal(ara.page)).toHaveCount(0)
  // 새 세션이 열린다(하던 작업 세션을 빼앗지 않는다).
  await expect.poll(async () => (await ara.page.evaluate(() => window.ev.session.list())).length, {
    timeout: 30_000
  }).toBe(2)
  await expect.poll(() => cli.inputs.slice(before).join(''), { timeout: 30_000 }).toBe(shown + '\r')
  // 실행 전에 설치 확인이 딱 한 번 나갔다.
  expect(cli.which).toEqual(['command -v claude 2>/dev/null'])
})

// AICLI-6 최근 목록은 시작한 뒤에 저절로 쌓이고, 누르면 폼을 채운다(바로 실행하지 않는다).
test('AICLI-6 최근 목록이 쌓이고 누르면 폼이 채워진다', async ({ ara, ssh }) => {
  const cli = makeCli()
  const h = await ssh({
    password: 'pw-a6',
    execHandler: cli.exec,
    onShellData: cli.onShellData,
    sftpRoot: mkdtempSync(join(tmpdir(), 'ara-aicli-')),
    procCwd: { pid: 4243 }
  })
  await connectAndOpen(ara.page, 'a6srv', h.port, 'pw-a6')
  await pathInput(ara.page).fill('~/erp')
  await startBtn(ara.page).click()
  await expect.poll(() => cli.inputs.join(''), { timeout: 30_000 }).toContain("cd ~/'erp' && claude")

  // 다시 열면: 마지막 조합이 미리 채워져 있고(= Enter 두 번), 최근 목록에 그 줄이 있다.
  await ara.page.keyboard.press('Control+Shift+L')
  await expect(modal(ara.page)).toBeVisible()
  await expect(pathInput(ara.page)).toHaveValue('~/erp')
  const rows = ara.page.locator('.aicli-rrow')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('a6srv')
  await expect(rows.first()).toContainText('claude --dangerously-skip-permissions -r')

  // 폴더만 바꿔 쓰는 일이 잦다 — 최근 줄을 눌러도 실행하지 않고 폼만 채운다.
  const sent = cli.inputs.length
  await pathInput(ara.page).fill('~/다른곳')
  await rows.first().click()
  await expect(pathInput(ara.page)).toHaveValue('~/erp')
  await expect(modal(ara.page)).toBeVisible()
  expect(cli.inputs.length).toBe(sent)
  await shot(ara.page, 'F27-screenshot.png')
})

// AICLI-7★ CLI 가 없는 서버 — 안내가 뜨고 **원격에는 아무것도 안 나간다**.
test('AICLI-7 CLI 가 없으면 안내하고 실행하지 않는다', async ({ ara, ssh }) => {
  const cli = makeCli(false)
  const h = await ssh({
    password: 'pw-a7',
    execHandler: cli.exec,
    onShellData: cli.onShellData,
    sftpRoot: mkdtempSync(join(tmpdir(), 'ara-aicli-')),
    procCwd: { pid: 4244 }
  })
  await connectAndOpen(ara.page, 'a7srv', h.port, 'pw-a7')
  await pathInput(ara.page).fill('~/erp')
  await startBtn(ara.page).click()

  await expect(dialog(ara.page)).toContainText('이 서버에 CLI 가 없습니다', { timeout: 30_000 })
  await expect(dialog(ara.page)).toContainText('claude')
  expect(cli.which).toEqual(['command -v claude 2>/dev/null'])
  // 판정은 화면이 아니라 하네스가 받은 입력 수다 — 터미널에 `command not found` 를 남기지 않았다.
  expect(cli.inputs.join('')).toBe('')
  await dialog(ara.page).locator('.modal-ft .btn.pri').click()
  // 접속은 그대로 열려 있다(안내 문구가 약속한 그대로).
  expect((await ara.page.evaluate(() => window.ev.session.list())).length).toBe(2)
})

// AICLI-8 ☑ 없으면 만들기 — sftp:mkdir 은 한 단계씩만 만든다. 중간 경로까지 차례로 만든다.
test('AICLI-8 없는 폴더는 상위부터 차례로 만든 뒤 시작한다', async ({ ara, ssh }) => {
  const root = mkdtempSync(join(tmpdir(), 'ara-aicli-'))
  const cli = makeCli()
  const h = await ssh({
    password: 'pw-a8',
    execHandler: cli.exec,
    onShellData: cli.onShellData,
    sftpRoot: root,
    procCwd: { pid: 4245 }
  })
  await connectAndOpen(ara.page, 'a8srv', h.port, 'pw-a8')
  await pathInput(ara.page).fill('~/projects/신규 작업')
  await startBtn(ara.page).click()

  await expect.poll(() => existsSync(join(root, 'projects', '신규 작업')), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => cli.inputs.join(''), { timeout: 30_000 }).toContain("cd ~/'projects/신규 작업' && claude")
})

// AICLI-9 쓸 수 없는 문자가 든 폴더는 조립 자체를 거절한다 — [시작] 이 눌리지 않는다.
test('AICLI-9 작은따옴표가 든 폴더는 시작할 수 없다', async ({ ara, ssh }) => {
  const cli = makeCli()
  const h = await ssh({ password: 'pw-a9', execHandler: cli.exec, onShellData: cli.onShellData })
  await connectAndOpen(ara.page, 'a9srv', h.port, 'pw-a9')
  await pathInput(ara.page).fill("~/it's")
  await expect(preview(ara.page)).toHaveClass(/bad/)
  await expect(startBtn(ara.page)).toBeDisabled()
  await ara.page.keyboard.press('Enter')
  await expect(modal(ara.page)).toBeVisible()
  expect(cli.inputs.join('')).toBe('')
})

// AICLI-10 -r 과 -c 는 배타 — 하나를 켜면 다른 하나가 꺼지고, 미리보기가 즉시 따라온다.
test('AICLI-10 이어서 플래그는 서로 배타다', async ({ ara, ssh }) => {
  const cli = makeCli()
  const h = await ssh({ password: 'pw-a10', execHandler: cli.exec })
  await connectAndOpen(ara.page, 'a10srv', h.port, 'pw-a10')
  await pathInput(ara.page).fill('/srv/app')
  await expect(preview(ara.page)).toHaveText("cd '/srv/app' && claude --dangerously-skip-permissions -r")

  await modal(ara.page).locator('input[data-flag="continue"]').check()
  await expect(modal(ara.page).locator('input[data-flag="resume"]')).not.toBeChecked()
  await expect(preview(ara.page)).toHaveText("cd '/srv/app' && claude --dangerously-skip-permissions -c")

  // 권한 확인 건너뛰기를 끄면 그 인자도 줄에서 사라진다(감추지 않는다 = 끄면 정말 없다).
  await modal(ara.page).locator('input[data-flag="skipPerms"]').uncheck()
  await expect(preview(ara.page)).toHaveText("cd '/srv/app' && claude -c")
})
