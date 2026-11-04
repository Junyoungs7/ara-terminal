// 원격 3차 R3 서버 계정 — 설정 › 관리형 서버 › [서버 계정](목업 4-accounts A: 설정 안 펼침). 하네스 exec 은 흉내만이라("다른 PC 가 깐 서버"를 채택해
// 동의 기록만 만든다) 서버에 붙는 일은 실패한다 — 펼침·저장 고지·동의 전 [로그인 시작] 막힘·실패 한 줄(쉬운 말)을 본다.
// 진짜 로그인(가짜 claude auth login)·다른 계정으로 --resume·지우기·제거 흔적 0·서버 ~/.claude 그대로는 tests/managedOrcad.test.ts '서버 계정'(WSL 원격 홈).
// 원격 탭의 띠·카드·탭 메뉴는 tests/accountRestartRemote.test.ts(고를 계정·한도)와 실서버 확인(USER-CHECKLIST).
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog } from './fixtures'

const drawer = '.settings-page.open'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

test('SERVE-R3-1 서버 계정 펼침 — 저장 고지 · 동의 전 로그인 막힘 · 못 붙으면 한 줄', async ({ ara, ssh }) => {
  const version = await ara.app.evaluate(({ app }) => app.getVersion())
  const cmds: string[] = []
  const handler = (command: string, stream: ServerChannel): void => {
    cmds.push(command)
    if (command.includes('uname -s')) stream.write(`${LINUX}installed=${version}\n`)
    stream.exit(0)
    stream.end()
  }
  const h = await ssh({ password: 'pw-serve-r3', execHandler: handler })
  await connectNewSshProfile(ara.page, { name: 'serve-r3', port: h.port, password: 'pw-serve-r3' })
  const page = ara.page
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="managed"]`)
  // 같은 판이 깔린 서버를 채택 — 이 PC 에 동의 기록만.
  await page.click(`${drawer} [data-managed="install"]`)
  await dialog(page).locator('.modal-ft .btn.pri').click()
  await expect(page.locator(`${drawer} [data-managed="accounts-toggle"]`)).toBeVisible()
  expect(cmds.some((c) => c.includes('mkdir'))).toBe(false)

  await page.click(`${drawer} [data-managed="accounts-toggle"]`)
  const box = page.locator(`${drawer} [data-managed="accounts"]`)
  await expect(box).toContainText('서버 계정')
  await expect(box).toContainText('~/.ara-server/accounts/')
  await expect(box).toContainText('root')
  await expect(box).toContainText('~/.ara-server/claude-shared/')
  // 하네스는 서버 연결 다리를 흉내 내지 않는다 → 이유 한 줄(쉬운 말).
  await expect(box.locator('[data-managed="acct-err"]')).toBeVisible({ timeout: 30_000 })
  await expect(box).not.toContainText('orcad')
  await expect(box).not.toContainText('데몬')

  // 계정 추가 — 이름·동의 전에는 [서버에서 로그인 시작]을 못 누른다.
  await box.locator('[data-managed="acct-add"]').click()
  const start = box.locator('[data-managed="acct-start"]')
  await expect(start).toBeDisabled()
  await box.locator('[data-managed="acct-name"]').fill('업무 B')
  await expect(start).toBeDisabled()
  await box.locator('[data-managed="acct-agree"]').check()
  await expect(start).toBeEnabled()
  await expect(box).toContainText('서버 관리자(root)는 읽을 수 있습니다')
})
