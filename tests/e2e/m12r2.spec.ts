// M12 R2 2차 코드·리뷰 — 에디터 옵션(미리 보기 탭·미니맵·줄바꿈·변경 보기 기본) · 머지 충돌 3-way(Orca 방식: 에디터에서 현재·공통 조상·들어오는 구역 색 + 띠 이동 + [중단]).
// 키 정리(Ctrl+Shift+J)는 codeview.spec CV-3. 저장소는 임시 폴더에 git init 한 것만. 작성만 — 실행은 메인(phase2-common).
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, dialog, dialogConfirm } from './fixtures'

const side = '.aiws-side'
const panel = '[data-aiws="explorer"]'

function makeRepo(conflict = false): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-m12r2-'))
  const repo = join(root, 'shop-api')
  mkdirSync(repo, { recursive: true })
  for (const n of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(repo, n), `${n}\n`)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'merge.conflictStyle=diff3', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  if (conflict) {
    git('checkout', '-q', '-b', 'other')
    writeFileSync(join(repo, 'a.txt'), 'theirs\n')
    git('commit', '-q', '-am', 'theirs')
    git('checkout', '-q', 'main')
    writeFileSync(join(repo, 'a.txt'), 'ours\n')
    git('commit', '-q', '-am', 'ours')
    try {
      git('merge', 'other')
    } catch {
      /* 충돌 — 기대한 대로 */
    }
  }
  return { root, repo }
}

async function openProject(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(side)).toBeVisible()
  await app.evaluate(({ dialog: d }, picked) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
  await mainRow.click()
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
}

const file = (page: Page, name: string) => page.locator(`${panel} .frow:has(.fn:text-is("${name}"))`)
const tab = (page: Page, name: string) => page.locator(`.aiws-tab[data-file-tab="${name}"]`)

test('R2-1 미리 보기 탭 — 한 번 누름은 기울임 탭(다음 것이 갈아 끼움), 두 번 누름·고치면 고정 · 미니맵 기본 꺼짐', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="explorer"]')
    await file(page, 'a.txt').click()
    await expect(tab(page, 'a.txt')).toHaveAttribute('data-preview', 'true')
    await expect(page.locator('.code-ed .monaco-editor')).toBeVisible()
    // Orca 기본: 미니맵 꺼짐.
    await expect(page.locator('.code-ed .monaco-editor .minimap')).toHaveCount(0)
    // 다음 한 번 누름이 같은 자리를 갈아 끼운다.
    await file(page, 'b.txt').click()
    await expect(tab(page, 'a.txt')).toHaveCount(0)
    await expect(tab(page, 'b.txt')).toHaveAttribute('data-preview', 'true')
    // 탭 두 번 누름 = 고정 → 다음 미리 보기는 옆에 새로.
    await tab(page, 'b.txt').dblclick()
    await expect(tab(page, 'b.txt')).not.toHaveAttribute('data-preview', 'true')
    await file(page, 'c.txt').click()
    await expect(tab(page, 'b.txt')).toHaveCount(1)
    await expect(tab(page, 'c.txt')).toHaveAttribute('data-preview', 'true')
    // 고치면 고정.
    await page.locator('.code-ed .monaco-editor .view-lines').click()
    await page.keyboard.type('x')
    await expect(tab(page, 'c.txt')).not.toHaveAttribute('data-preview', 'true')
    // 탐색기 두 번 누름 = 바로 고정 탭.
    await file(page, 'a.txt').dblclick()
    await expect(tab(page, 'a.txt')).not.toHaveAttribute('data-preview', 'true')
  } finally {
    rmDir(root)
  }
})

test('R2-2 설정 › 편집기 — 미니맵 켜면 열린 에디터가 바로 따른다 · 미리 보기 탭 끄면 한 번 누름도 고정', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="explorer"]')
    await file(page, 'a.txt').click()
    await expect(page.locator('.code-ed .monaco-editor')).toBeVisible()
    await page.keyboard.press('Control+,')
    await page.click('.settings-page.open .sp-nav [data-section="editor"]')
    await page.click('.settings-page.open .set-row[data-item="editor.minimap"] .set-toggle')
    await page.click('.settings-page.open .set-row[data-item="editor.previewTabs"] .set-toggle')
    await expect(page.locator('.settings-page.open [data-field="editor.diffView"] [data-value="inline"]')).toHaveClass(/on/)
    await page.keyboard.press('Escape')
    await expect(page.locator('.code-ed .monaco-editor .minimap')).toHaveCount(1)
    await file(page, 'b.txt').click()
    await expect(tab(page, 'b.txt')).not.toHaveAttribute('data-preview', 'true')
  } finally {
    rmDir(root)
  }
})

test('R2-3★ 머지 충돌 — 소스 제어 [충돌] → 에디터에 3-way 구역·띠(1/1·이동) → [중단] 하면 충돌이 사라진다', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo(true)
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="scm"]')
    await expect(page.locator('[data-scm="operation"]')).toHaveAttribute('data-op', 'merge')
    await expect(page.locator('[data-scm-sec="conflicts"]')).toContainText('1')
    const row = page.locator('.scm-row[data-scm-file="a.txt"]')
    await expect(row.locator('.scm-kind')).toHaveText('양쪽 수정')
    // 커밋은 막혀 있다(충돌).
    await expect(page.locator('[data-scm="primary"]')).toBeDisabled()

    await row.locator('.scm-open').click()
    const bar = page.locator('[data-code="merge-conflict"]')
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-kind', 'both_modified')
    await expect(bar).toContainText('1 / 1')
    const ed = page.locator('.code-ed .monaco-editor')
    await expect(ed.locator('.orca-conflict-current-line').first()).toBeVisible()
    await expect(ed.locator('.orca-conflict-base-line').first()).toBeVisible()
    await expect(ed.locator('.orca-conflict-incoming-line').first()).toBeVisible()
    await page.click('[data-code="conflict-next"]')

    await page.click('[data-scm="abort"]')
    await expect(dialog(page)).toBeVisible()
    await dialogConfirm(page)
    await expect(page.locator('[data-scm="operation"]')).toHaveCount(0)
    await expect(page.locator('[data-scm-sec="conflicts"]')).toHaveCount(0)
    // 파일이 병합 전(ours)으로 돌아오면 에디터도 다시 읽어 띠가 사라진다(감시).
    await expect(bar).toHaveCount(0, { timeout: 15_000 })
  } finally {
    rmDir(root)
  }
})
