// M8 R4 원격 작업 단위의 빈틈 — 로컬 파일·로컬 git 을 쓰는 패널(빠른 열기·전체 검색·소스 제어·변경 비교)은 원격 작업 단위에서
// 빈 화면·오류 대신 "원격 작업에서는 아직 지원하지 않습니다"로 막는다. 하네스(127.0.0.1)의 exec 은 git 두 명령만 흉내 낸다.
// 원격 세션 재시작 복귀·탭 닫기 끝내기는 tests/managedOrcad.test.ts(WSL 원격 홈). 실서버 확인은 USER-CHECKLIST.
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile } from './fixtures'

const NOTE = '원격 작업에서는 아직 지원하지 않습니다'

test('RGAP-1 원격 작업 단위 — 빠른 열기·검색·소스 제어·변경 비교는 막고 안내', async ({ ara, ssh }) => {
  const { page } = ara
  const cmds: string[] = []
  const h = await ssh({
    password: 'pw-rgap1',
    execHandler: (command: string, stream: ServerChannel) => {
      cmds.push(command)
      if (command.includes('--show-toplevel')) stream.write('/home/tester/shop\n')
      else if (command.includes('worktree') && command.includes('list')) stream.write('worktree /home/tester/shop\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/main\n\n')
      stream.exit(0)
      stream.end()
    }
  })
  await connectNewSshProfile(page, { name: 'rgap-1', port: h.port, password: 'pw-rgap1' })
  const hostKey = `tester@127.0.0.1:${h.port}`
  // 원격 저장소 등록(새 작업 카드의 [추가]와 같은 IPC — 카드는 동의 화면을 먼저 거치므로 여기선 바로 부른다).
  const added = await page.evaluate(async (k) => (await window.ev.repos.addRemote(k, '~/shop')).ok, hostKey)
  expect(added).toBe(true)

  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  const row = page.locator('.aiws-side .aiws-row[data-wt]').first()
  await expect(row).toHaveAttribute('title', '/home/tester/shop')
  await row.click()

  // 빠른 열기 — 로컬 rg 를 돌리지 않고 안내.
  await page.keyboard.press('Control+P')
  await expect(page.locator('.qo-drop .qo-empty')).toHaveText(NOTE)
  await page.keyboard.press('Escape')

  // 소스 제어 패널 — 안내만.
  await page.click('[data-rbar="scm"]')
  await expect(page.locator('.aiws-scm [data-aiws="remote-unsupported"]')).toHaveText(NOTE)
  await page.click('[data-rbar="scm"]')

  // 전체 검색 — 검색어를 넣어도 돌지 않고 안내.
  await page.click('.ai-rail .ai-rail-item[data-aiws="search"]')
  await page.locator('.aiws-search [data-field="search.query"]').fill('x')
  await expect(page.locator('.aiws-search [data-aiws="remote-unsupported"]')).toContainText(NOTE)

  // 원격에는 git 조회 두 가지 말고 아무것도 안 갔다(로컬 경로로 git·rg 를 돌리지 않는다).
  expect(cmds.every((c) => c.includes('--show-toplevel') || c.includes('worktree'))).toBe(true)
})
