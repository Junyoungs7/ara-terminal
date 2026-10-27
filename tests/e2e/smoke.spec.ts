// 하네스 자체 점검 — 앱이 임시 userData 로 뜨고, 로컬 셸이 열리고, SSH 하네스에 붙는지.
// 시나리오 문서의 기능 검증은 다른 spec 이 한다. 이 파일이 깨지면 나머지 결과는 신뢰할 수 없다.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, newLocalShell, sessionList, connectNewSshProfile, expectTermText } from './fixtures'

test('SMOKE-1 앱이 임시 userData 로 기동한다', async ({ ara }) => {
  // 1.0.10(5e3c3c6): 앱 이름 A.R.A → ARA(i18n app.name).
  await expect(ara.page.locator('.titlebar .tb-name')).toHaveText('ARA')
  await expect(ara.page.locator('.pane-grid .pane')).toHaveCount(0)
  const userDataPath = await ara.app.evaluate(({ app }) => app.getPath('userData'))
  expect(userDataPath.toLowerCase()).toBe(ara.userData.toLowerCase())
})

test('SMOKE-2 로컬 셸이 열리고 출력이 찍힌다', async ({ ara }) => {
  const id = await newLocalShell(ara.page)
  await expect(ara.page.locator('.pane-grid .pane')).toHaveCount(1)
  expect((await sessionList(ara.page))[0].type).toBe('local')
  await expectTermText(ara.page, id, /\S/)
})

test('SMOKE-3 SSH 하네스에 접속된다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-smoke' })
  const id = await connectNewSshProfile(ara.page, { name: 'smoke-remote', port: h.port, password: 'pw-smoke' })
  await expectTermText(ara.page, id, /원격 셸 준비 완료/)
})

test('SMOKE-4 종료 시 workspace.json 이 기록된다', async ({ userDataDir }) => {
  const { launchAra, quitAra, persist } = await import('./fixtures')
  const a = await launchAra(userDataDir)
  await newLocalShell(a.page)
  await persist(a.page)
  await quitAra(a)
  expect(existsSync(join(userDataDir, 'workspace.json'))).toBe(true)
})
