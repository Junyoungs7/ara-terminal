// F30 조용한 AI — 준영님 요청(2026-08-12): 서버 여러 대에 AI CLI 를 띄워 두면 어느 놈이
// 나를 기다리는지 모른다.
//
// **#132(2026-08-25)에서 우측 [AI 세션] 레일이 없어졌다.** 목록은 사이드바 [AI] 작업대로 갔고
// (왼쪽이 목록 자리다), 조용함 감시는 화면 없이 계속 돈다(store/aiQuietWatch.ts) — 화면과 함께
// 지우면 "안 보고 있어도 알아챈다"는 목적째 사라진다. 이 파일은 그 이사를 따라간 것이다.
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

const rows = (page: Page) => page.locator('.bench-row')

/** 작업대 목록은 **왼쪽** 사이드바다(#129) — 오른쪽 레일이 아니다. */
async function openBench(page: Page): Promise<void> {
  await page.click('.lrail-item[data-tab="ai"]')
  await expect(page.locator('.sb-panel.active .bench-list, .sb-panel.active .bench-empty')).toBeVisible()
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

test('AISESS-1 만들어 둔 것이 없으면 안내만 낸다 · 옛 레일은 사라졌다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openBench(page)
  await expect(page.locator('.bench-empty')).toContainText('AI CLI')
  await expect(rows(page)).toHaveCount(0)
  // #132: [AI 세션] 아이콘은 이제 없다(2.0 에서 우측 바 자체가 없어져 클래스 없이 찾는다) — 같은 목록이 두 자리에 있으면 어느 쪽이 진짜인지 모른다.
  await expect(page.locator('[data-activity="aisess"]')).toHaveCount(0)
})

test('AISESS-2★ 시작한 AI 가 작업대로 **적립된다** — 만들고 잊지 않는다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as2')
  await launchAi(page, 'as2srv', h.port, 'pw-as2')

  await openBench(page)
  await expect(rows(page)).toHaveCount(1, { timeout: 30_000 })
  // 폴더는 **그 세션이 서 있는 곳**이다(하네스 procCwd) — 창에서 타이핑하던 값이 아니다.
  // 제목은 그 경로의 마지막 칸이다(/home/tester → tester).
  await expect(rows(page).locator('.t')).toHaveText('tester')
  await expect(rows(page).locator('.bench-name')).toHaveAttribute('title', /\/home\/tester/)
  // 살아 있으니 초록. 같은 조합을 또 띄워도 줄이 늘지 않는다(적립은 하나다).
  await expect(rows(page)).toHaveAttribute('data-status', /live|quiet/)
})

test('AISESS-3★ 문구가 "기다립니다"가 아니라 "조용합니다"다 — 확신하지 않는다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as3')
  await launchAi(page, 'as3srv', h.port, 'pw-as3')
  await openBench(page)
  await expect(rows(page)).toHaveCount(1, { timeout: 30_000 })

  // 이제 그 말은 점의 툴팁에 있다(줄 하나에 문장을 붙일 자리가 없다 — 사이드바는 좁다).
  const tip = await rows(page).locator('.bench-name').getAttribute('title')
  expect(tip).toBeTruthy()
  // 단정하지 않는다 — 승인 대기일 수도, 오래 걸리는 작업일 수도 있다.
  expect(tip).not.toContain('기다립니다')
  const quietTip = await page.evaluate(() => {
    const el = document.querySelector('.bench-dot')
    return el?.getAttribute('title') ?? ''
  })
  expect(quietTip).not.toContain('기다립니다')
})

test('AISESS-4 살아 있는 줄을 누르면 그 탭으로 간다(새로 안 띄운다)', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await sshForAi(ssh as never, 'pw-as4')
  await launchAi(page, 'as4srv', h.port, 'pw-as4')
  await openBench(page)
  await expect(rows(page)).toHaveCount(1, { timeout: 30_000 })

  // 다른 탭으로 옮겨 둔 뒤, 줄을 눌러 돌아오는 것을 본다. 탭 수가 늘면 새로 띄운 것이다 — 그건 틀렸다.
  const before = await page.locator('.term-tabbar .ttab.active').innerText()
  await newLocalShell(page)
  await expect(page.locator('.term-tabbar .ttab.active')).not.toHaveText(before)
  const tabs = await page.locator('.term-tabbar .ttab').count()
  await openBench(page)
  await rows(page).locator('.bench-name').click()
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveText(before)
  expect(await page.locator('.term-tabbar .ttab').count()).toBe(tabs)
})
