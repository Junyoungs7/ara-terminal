// F30 AI 세션 패널 — 준영님 요청(2026-08-12): 서버 여러 대에 AI CLI 를 띄워 두면 어느 놈이
// 나를 기다리는지 모른다. 목업 D안 확정(mockups/ai-sessions.png).
//
// 이 파일이 지키는 가장 중요한 성질은 AISESS-3 이다: **문구가 "기다립니다"가 아니라 "조용합니다"** 다.
// 우리 판정 근거는 "출력이 멎었다" 하나뿐이라 대기를 확신할 수 없다 — 확신하는 척했다가 한 번
// 틀리면 그다음부터 아무도 이 표시를 안 믿고, 그러면 기능이 죽는다.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, newLocalShell, openConnTab } from './fixtures'

// F27 창을 실제로 통과시키려면 설치 확인(`command -v`)과 셸 준비 신호가 필요하다 —
// aicli.spec.ts 의 하네스와 같은 모양(그쪽이 단일 출처지만 spec 간 import 는 하지 않는다).
function makeCli(): { exec: (c: string, s: ServerChannel) => void; onShellData: (d: string) => void } {
  return {
    exec: (command, stream) => {
      if (command.startsWith('command -v')) stream.write('/usr/local/bin/claude\n')
      stream.exit(0)
      stream.end()
    },
    onShellData: () => {}
  }
}

const panel = (page: Page) => page.locator('.monitor-panel.aisess')

// 액티비티 바 순서: ai · monitor · sys · **aisess** · log · … (store/activityBar.ts 가 단일 출처)
async function openAiSess(page: Page): Promise<void> {
  await page.click('.act-item[data-activity="aisess"]')
  await expect(panel(page)).toBeVisible()
}

/**
 * 접속 → **트리 세션 행 우클릭 → [AI CLI 시작]**. 여기까지 와야 패널에 오를 세션이 생긴다.
 *
 * 2026-08-18(cc72bcb)에 **시작 창이 없어졌다**: 창이 묻던 넷 중 서버·폴더는 화면이 이미 알고
 * (지금 세션·지금 cwd) CLI·플래그는 거의 안 바뀐다. 그래서 폴더를 채우는 단계도 없다 — 그
 * 세션이 서 있는 폴더에서 바로 뜬다(하네스의 procCwd 가 그 값을 준다).
 */
async function launchAi(page: Page, name: string, port: number, password: string): Promise<void> {
  await connectNewSshProfile(page, { name, port, password })
  await openConnTab(page) // 접속하면 사이드바가 [파일] 로 간다 — 트리로 돌아온다
  await page.locator('.tree .sess-node').first().click({ button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="aicli.start"]')
  await expect(page.locator('.ctx-menu')).toHaveCount(0)
}

async function sshForAi(ssh: (o: unknown) => Promise<{ port: number }>, password: string) {
  const cli = makeCli()
  return ssh({
    password,
    execHandler: cli.exec,
    onShellData: cli.onShellData,
    sftpRoot: mkdtempSync(join(tmpdir(), 'ara-aisess-')),
    // 셸 준비 신호(원격 /proc cwd) — waitShellReady 가 이걸 기다린다.
    procCwd: { pid: 4242, initial: '/home/tester' }
  })
}

test('AISESS-1 실행 중인 AI 가 없으면 안내만 내고 점도 안 찍는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openAiSess(page)
  await expect(page.locator('.aisess-empty')).toContainText('AI CLI')
  await expect(page.locator('.aisess-row')).toHaveCount(0)
  // 볼 것이 없으면 액티비티 바에 점을 찍지 않는다 — 늘 켜져 있으면 아무도 안 본다.
  await expect(page.locator('.act-item[data-activity="aisess"] .act-badge')).toHaveCount(0)
})

test('AISESS-2★ F27 로 시작한 AI 가 서버별로 묶여 목록에 오른다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as2')
  await launchAi(page, 'as2srv', h.port, 'pw-as2')

  await openAiSess(page)
  await expect(page.locator('.aisess-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.aisess-cli')).toHaveText('claude')
  // 폴더는 이제 **그 세션이 서 있는 곳**이다(하네스 procCwd) — 창에서 타이핑하던 값이 아니다.
  await expect(page.locator('.aisess-path')).toHaveText('/home/tester')
  // 서버 이름으로 묶인다 — 같은 서버에 여러 개를 띄우는 일이 흔하다.
  await expect(page.locator('.aisess-grp')).toHaveCount(1)
})

test('AISESS-3★ 문구가 "기다립니다"가 아니라 "조용합니다"다 — 확신하지 않는다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as3')
  await launchAi(page, 'as3srv', h.port, 'pw-as3')
  await openAiSess(page)
  await expect(page.locator('.aisess-row')).toHaveCount(1, { timeout: 30_000 })

  const body = await panel(page).innerText()
  // 판정 근거를 숨기지 않는다.
  expect(body).toContain('출력이 60초 이상 멎었다')
  // 그리고 단정하지 않는다 — 승인 대기일 수도, 오래 걸리는 작업일 수도 있다.
  expect(body).not.toContain('기다립니다')
})

test('AISESS-4 행을 누르면 그 세션 탭으로 간다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as4')
  await launchAi(page, 'as4srv', h.port, 'pw-as4')
  await openAiSess(page)
  await expect(page.locator('.aisess-row')).toHaveCount(1, { timeout: 30_000 })

  // AI 세션이 아닌 다른 탭으로 옮겨 둔 뒤, 패널 행을 눌러 돌아오는 것을 본다.
  const before = await page.locator('.term-tabbar .ttab.active').innerText()
  await newLocalShell(page)
  await expect(page.locator('.term-tabbar .ttab.active')).not.toHaveText(before)
  await page.locator('.aisess-row').click()
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveText(before)
})
