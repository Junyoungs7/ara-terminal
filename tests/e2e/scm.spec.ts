// M7 R2 소스 제어(WS-12 패널 · WS-13 푸시 안전장치). 저장소는 임시 폴더 + **로컬 bare 원격**만(사내 GitLab 에 닿지 않는다).
// 끝 기준(계획 M7): 보호 브랜치 푸시 막힘. 흐름: 변경 → stage → 커밋 → 로컬 bare 로 푸시.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, dialog, dialogCancel } from './fixtures'

const side = '.aiws-side'
const scm = '.aiws-scm'

function makeRepo(): { root: string; repo: string; bare: string; git: (...a: string[]) => string } {
  const root = realpathSync(tempDir('ara-e2e-scm-'))
  const repo = join(root, 'shop-api')
  const bare = join(root, 'remote.git')
  mkdirSync(repo)
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
  run(root, 'init', '-q', '--bare', '-b', 'main', bare)
  run(repo, 'init', '-q', '-b', 'main')
  // 앱이 띄우는 git 이 커밋할 때 쓸 이름 — 저장소 설정으로(전역 설정에 기대지 않는다).
  run(repo, 'config', 'user.name', 't')
  run(repo, 'config', 'user.email', 't@t')
  writeFileSync(join(repo, 'README.md'), '# shop\n')
  run(repo, 'add', '.')
  run(repo, 'commit', '-q', '-m', 'init')
  run(repo, 'remote', 'add', 'origin', bare)
  run(repo, 'push', '-q', '-u', 'origin', 'main')
  return { root, repo, bare, git: (...a) => run(repo, ...a) }
}

async function openProject(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(side)).toBeVisible()
  await app.evaluate(({ dialog: d }, picked) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  // 갓 추가한 저장소는 본 작업 폴더 한 줄뿐. 줄 이름이 브랜치(SCM-1 은 feature/retry)라서 'main' 글자로는 못 고른다.
  const mainRow = page.locator(`${side} .aiws-row`).first()
  await mainRow.click()
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
  await page.click('.rbar [data-rbar="scm"]')
  await expect(page.locator(scm)).toBeVisible()
  await expect(page.locator('.rbar [data-rbar="scm"]')).toHaveAttribute('aria-pressed', 'true')
}

test('SCM-1★ 변경 → stage → 커밋 → 새 브랜치를 로컬 bare 로 게시', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, bare, git } = makeRepo()
  try {
    git('switch', '-q', '-c', 'feature/retry')
    writeFileSync(join(repo, 'Retry.java'), 'class Retry {}\n')
    await openProject(app, page, repo)

    const row = page.locator(`${scm} .scm-row[data-scm-file="Retry.java"]`)
    await expect(row).toHaveAttribute('data-scm-area', 'untracked')
    await expect(row.locator('.scm-st')).toHaveText('U')
    await row.locator('[data-scm="stage"]').click()
    await expect(page.locator(`${scm} .scm-row[data-scm-file="Retry.java"][data-scm-area="staged"]`)).toBeVisible()

    await page.fill(`${scm} [data-field="scm.message"]`, 'add retry')
    const primary = page.locator(`${scm} [data-scm="primary"]`)
    await expect(primary).toHaveAttribute('data-kind', 'commit')
    await primary.click()
    await expect(page.locator(`${scm} .scm-row`)).toHaveCount(0)
    expect(git('log', '-1', '--format=%s')).toBe('add retry')

    // upstream 없음 → 기본 동작 = 브랜치 게시
    await expect(primary).toHaveAttribute('data-kind', 'publish')
    await primary.click()
    await expect(page.locator('.ntf-toasts .ntf-toast[data-kind="done"]').filter({ hasText: 'origin/feature/retry' })).toBeVisible()
    const remote = execFileSync('git', ['rev-parse', 'refs/heads/feature/retry'], { cwd: bare, encoding: 'utf8' }).trim()
    expect(remote).toBe(git('rev-parse', 'HEAD'))
  } finally {
    rmDir(root)
  }
})

test('SCM-2★ 보호 브랜치(main) 푸시 — 확인 창에서 취소하면 원격이 그대로 · 강제 푸시는 확인으로도 막힘', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, bare, git } = makeRepo()
  try {
    const before = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).trim()
    writeFileSync(join(repo, 'README.md'), '# shop 2\n')
    git('commit', '-q', '-am', 'on main')
    await openProject(app, page, repo)

    const primary = page.locator(`${scm} [data-scm="primary"]`)
    await expect(primary).toHaveAttribute('data-kind', 'push')
    await primary.click()
    await expect(dialog(page)).toContainText('origin/main')
    await dialogCancel(page)
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).trim()).toBe(before)

    await page.click(`${scm} [data-scm="forcePush"]`)
    await expect(page.locator(`${scm} [data-scm="error"]`)).toContainText('보호 브랜치에는 강제 푸시할 수 없습니다')
    expect(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare, encoding: 'utf8' }).trim()).toBe(before)
  } finally {
    rmDir(root)
  }
})
