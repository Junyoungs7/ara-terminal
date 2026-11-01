// M8 R5 원격 작업 단위의 패널 — 빠른 열기·전체 검색·소스 제어가 **그 서버에서** 돈다(main 이 SSH exec 로). 로컬 rg·로컬 git 을 돌리지 않는다.
// 하네스(127.0.0.1)의 exec 은 이 시험에 필요한 명령만 흉내 낸다: rg 없음(command -v rg → 1) → git ls-files · git grep · git status.
// 실제 git 으로의 왕복(열기·저장·충돌·stage·커밋·푸시·보호 브랜치)은 tests/remoteWork.test.ts(WSL 원격). 실서버 확인은 USER-CHECKLIST.
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile } from './fixtures'

const ROOT = '/home/tester/shop'

test('RGAP-1 원격 작업 단위 — 빠른 열기·검색·소스 제어가 그 서버의 git 으로', async ({ ara, ssh }) => {
  const { page } = ara
  const cmds: string[] = []
  const h = await ssh({
    password: 'pw-rgap1',
    execHandler: (command: string, stream: ServerChannel) => {
      cmds.push(command)
      let code = 0
      if (command.includes('--show-toplevel')) stream.write(`${ROOT}\n`)
      else if (command.includes('worktree') && command.includes('list')) stream.write(`worktree ${ROOT}\nHEAD 0123456789abcdef0123456789abcdef01234567\nbranch refs/heads/main\n\n`)
      else if (command.includes('command -v rg')) code = 1
      else if (command.includes('ls-files')) stream.write('README.md\0src/app.ts\0')
      else if (command.includes("'grep'")) stream.write('src/app.ts\x003\x00const hello = 1\n')
      else if (command.includes("'status'")) stream.write('# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head main\0? src/new.ts\0')
      stream.exit(code)
      stream.end()
    }
  })
  await connectNewSshProfile(page, { name: 'rgap-1', port: h.port, password: 'pw-rgap1' })
  const hostKey = `tester@127.0.0.1:${h.port}`
  const added = await page.evaluate(async (k) => (await window.ev.repos.addRemote(k, '~/shop')).ok, hostKey)
  expect(added).toBe(true)

  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  const row = page.locator('.aiws-side .aiws-row[data-wt]').first()
  await expect(row).toHaveAttribute('title', ROOT)
  await row.click()

  // 빠른 열기 — 서버의 git ls-files 목록.
  await page.keyboard.press('Control+P')
  await expect(page.locator('.qo-drop .qo-item')).toHaveCount(2)
  await page.keyboard.press('Escape')

  // 전체 검색 — 서버에 rg 가 없으니 git grep.
  await page.click('.ai-rail .ai-rail-item[data-aiws="search"]')
  await page.locator('.aiws-search [data-field="search.query"]').fill('hello')
  await expect(page.locator('.aiws-search [data-search-file="src/app.ts"]')).toBeVisible()

  // 소스 제어 — 서버의 git status.
  await page.click('[data-rbar="scm"]')
  await expect(page.locator('.aiws-scm [data-scm-file="src/new.ts"]')).toBeVisible()

  // 모든 git 은 그 서버의 워크트리 폴더에서 돌았다(로컬 경로를 보내지 않았다). 서버에 rg 를 깔지 않았다.
  const gitCmds = cmds.filter((c) => c.includes("'git'"))
  expect(gitCmds.length).toBeGreaterThan(0)
  expect(gitCmds.every((c) => c.includes(`'${ROOT}'`))).toBe(true)
  expect(cmds.some((c) => /apt|install|curl|wget/.test(c))).toBe(false)
})
