// M8 DM-05 실행 위치(Run on) — 새 작업 카드 맨 위에서 이 PC / 관리형 서버를 고른다. 동의 안 된 서버를 고르면 동의 화면부터(설정 › 관리형 서버와 같은 화면).
// 하네스(127.0.0.1)의 exec 은 흉내만 낸다 — 이 시험은 "고르기 → 동의 화면 → [취소]면 이 PC 그대로, 원격에 아무것도 안 쓴다"를 본다.
// 실제 원격 워크트리·원격 에이전트·끊김 → 다시 연결은 tests/managedOrcad.test.ts(WSL 원격 홈). 실서버 확인은 USER-CHECKLIST.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerChannel } from 'ssh2'
import { test, expect, tempDir, rmDir, connectNewSshProfile, dialog, dialogCancel } from './fixtures'

const side = '.aiws-side'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-runon-'))
  const repo = join(root, 'shop-api')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { root, repo }
}

test('RUNON-1 실행 위치 고르기 — 동의 안 된 서버는 동의 화면, [취소]면 이 PC 그대로', async ({ ara, ssh }) => {
  const { app, page } = ara
  const cmds: string[] = []
  const h = await ssh({
    password: 'pw-runon1',
    execHandler: (command: string, stream: ServerChannel) => {
      cmds.push(command)
      if (command.includes('uname -s')) stream.write(LINUX)
      stream.exit(0)
      stream.end()
    }
  })
  await connectNewSshProfile(page, { name: 'runon-1', port: h.port, password: 'pw-runon1' })
  const { root, repo } = makeRepo()
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.click(`${side} [data-aiws="new"]`)

    // 목록: 이 PC + 저장된 SSH 서버(아직 동의 없음 표시).
    const pick = page.locator('[data-aiws="new-runon"]')
    await expect(pick).toHaveValue('local')
    const hostKey = `tester@127.0.0.1:${h.port}`
    await expect(pick.locator(`option[value="${hostKey}"]`)).toContainText('아라 데몬 설치 필요')

    // 서버를 고르면 동의 화면부터.
    await pick.selectOption(hostKey)
    const d = dialog(page)
    await expect(d).toContainText('이 서버에 아라 데몬을 설치할까요?')
    await expect(d).toContainText('/home/tester/.ara-server/orcad.py')
    await dialogCancel(page)

    // [취소] → 이 PC 그대로, 로컬 프로젝트가 보이고 원격 저장소 칸은 없다. 원격에는 묻기 말고 아무것도 안 갔다.
    await expect(pick).toHaveValue('local')
    await expect(page.locator('[data-aiws="new-project"]')).toContainText('shop-api')
    await expect(page.locator('[data-aiws="new-remote-path"]')).toHaveCount(0)
    expect(cmds.some((c) => c.includes('mkdir'))).toBe(false)
    expect(cmds.some((c) => c.includes('worktree'))).toBe(false)
  } finally {
    rmDir(root)
  }
})
