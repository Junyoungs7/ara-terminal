// M10 R2 — 작업 단위 2차(WS-18~21): 체크포인트(메모·상태) · 아라 밖 워크트리 감지 · 공유 경로(링크) · 남긴 브랜치 검토.
// 저장소는 임시 폴더에 git init 한 것만. 워크트리는 ARA_E2E 면 userData/workspaces 에. 에이전트는 띄우지 않는다.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir, dialog, dialogConfirm } from './fixtures'

const side = '.aiws-side'

function makeRepo(): { root: string; repo: string; git: (...a: string[]) => string } {
  const root = realpathSync(tempDir('ara-e2e-wt2-'))
  const repo = join(root, 'shop-api')
  mkdirSync(join(repo, 'deps'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, '.gitignore'), 'deps/\n')
  writeFileSync(join(repo, 'deps', 'lib.js'), 'orig\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // 아라 밖에서 손으로 만든 워크트리(저장소 형제 자리).
  git('worktree', 'add', '-q', '-b', 'by-hand', join(root, 'shop-api-hand'))
  return { root, repo, git }
}

test('WT-M10R2★ 숨은 워크트리 보이기 → 공유 경로 링크 → 메모·상태 → 커밋 있는 브랜치는 남김 → 검토에서 강제로 지우기', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, git } = makeRepo()
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect(page.locator(side)).toBeVisible()
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await expect(page.locator(`${side} .aiws-grp`)).toContainText('shop-api')

    // WS-19 손으로 만든 워크트리는 숨고 카드가 센다 → 카드 → [보이기] → 줄이 생긴다.
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'by-hand' })).toHaveCount(0)
    const card = page.locator(`${side} [data-aiws="hidden-wt"]`)
    await expect(card).toContainText('숨은 워크트리 1개')
    await card.click()
    await expect(page.locator('.aiws-dlg [data-source="other"]')).not.toBeChecked()
    await page.click('.aiws-dlg [data-aiws="ext-show"]')
    await expect(page.locator('.aiws-dlg [data-aiws="ext-hide"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'by-hand' })).toBeVisible()
    await expect(card).toHaveCount(0)

    // WS-20 프로젝트 ⋯ → 공유 경로… → deps → 새 작업 단위에 deps 가 링크로 붙는다.
    await page.locator(`${side} .aiws-grp[data-group^="repo:"]`).hover()
    await page.click(`${side} [data-aiws="project-menu"]`)
    await page.click('.ctx-menu [data-action="shared"]')
    await page.fill('.aiws-dlg [data-aiws="shared-paths"]', 'deps')
    await page.click('.aiws-dlg [data-aiws="shared-save"]')
    await page.click(`${side} [data-aiws="new"]`)
    await page.fill('[data-aiws="new-name"]', 'shr')
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')
    const row = page.locator(`${side} .aiws-row[data-wt]`).filter({ hasText: 'shr' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    const wtPath = (await row.getAttribute('data-wt'))!.split('::')[1]
    expect(lstatSync(join(wtPath, 'deps')).isSymbolicLink()).toBe(true)

    // WS-18 줄 우클릭 → 메모·상태… → 메모·리뷰 중 → 둘째 줄에 보인다.
    await row.click({ button: 'right' })
    await page.click('.ctx-menu [data-action="checkpoint"]')
    await page.fill('.aiws-dlg [data-aiws="cp-comment"]', '로그인 재현함\n다음: 고치기')
    await page.click('.aiws-dlg [data-status="in-review"]')
    await page.click('.aiws-dlg [data-aiws="cp-save"]')
    await expect(row).toHaveAttribute('data-status', 'in-review')
    await expect(row.locator('.aiws-status')).toHaveText('리뷰 중')
    await expect(row.locator('.aiws-row-cmt')).toHaveText('로그인 재현함')

    // WS-21 그 작업 단위에서 커밋 → 지우기 → 폴더는 지우고 브랜치는 남김(띠·알림) → 검토 → 강제로 지우기.
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'wip'], { cwd: wtPath })
    await row.hover()
    await row.locator('[data-aiws="remove"]').click()
    await expect(dialog(page)).toContainText('브랜치 shr 를 지웁니다')
    await dialogConfirm(page)
    await expect(row).toHaveCount(0)
    expect(existsSync(wtPath)).toBe(false)
    // 링크를 먼저 끊었다 — 본 폴더 원본 그대로.
    expect(readFileSync(join(repo, 'deps', 'lib.js'), 'utf8')).toBe('orig\n')
    expect(git('branch', '--list', 'shr')).toContain('shr')
    const strip = page.locator(`${side} [data-aiws="kept-branches"]`)
    await expect(strip).toContainText('남긴 브랜치 1개')
    await strip.locator('[data-aiws="branch-review"]').click()
    await expect(page.locator('.aiws-dlg [data-branch="shr"] input')).toBeChecked()
    await page.click('.aiws-dlg [data-aiws="branch-force"]')
    await expect(strip).toHaveCount(0)
    expect(git('branch', '--list', 'shr').trim()).toBe('')
  } finally {
    rmDir(root)
  }
})
