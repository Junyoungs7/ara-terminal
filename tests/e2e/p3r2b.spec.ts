// 3차 R2-B — 그림 비교(나란히·겹쳐) · HTML 렌더 비교 · 충돌 검토 목록 · 에디터 확대·자동 저장. 작성만(실행은 메인).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir } from './fixtures'

const side = '.aiws-side'
// 1x1 PNG 두 장(빨강·파랑).
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function makeRepo(conflict = false): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-p3r2b-'))
  const repo = join(root, 'shop-api')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'logo.png'), RED)
  writeFileSync(join(repo, 'page.html'), '<h1 id="t">old</h1>\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
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
  } else {
    writeFileSync(join(repo, 'logo.png'), BLUE)
    writeFileSync(join(repo, 'page.html'), '<h1 id="t">new</h1>\n')
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

test('P3R2B-1★ 그림 비교 — 원래/바뀐 두 그림(바이트 그대로), 겹쳐 보기 불투명도 · HTML 렌더 비교 두 샌드박스', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('[data-aiws="diff-open"]')
    await page.click('[data-diff-file="logo.png"]')
    const view = page.locator('[data-diffm="image-view"]')
    await expect(view.locator('[data-side="original"] img')).toBeVisible()
    await expect(view.locator('[data-side="modified"] img')).toBeVisible()
    // 글로 풀어 깨졌다면 그림이 안 그려진다(naturalWidth 0).
    await expect.poll(() => view.locator('[data-side="original"] img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1)
    await page.click('[data-diff-layout="split"]')
    await view.locator('[data-diffm="onion"]').check()
    const stage = view.locator('[data-diffm="onion-stage"] img')
    await expect(stage).toHaveCount(2)
    await view.locator('[data-diffm="opacity"]').fill('20')
    await expect(stage.nth(1)).toHaveAttribute('style', /opacity: 0\.2/)

    await page.click('[data-diff-file="page.html"]')
    await page.click('[data-diff="html-render"]')
    const frames = page.locator('[data-diffm="html-view"] iframe[data-diffm="html-frame"]')
    await expect(frames).toHaveCount(2)
    await expect(frames.first()).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(page.frameLocator('[data-side="original"] iframe').locator('#t')).toHaveText('old')
    await expect(page.frameLocator('[data-side="modified"] iframe').locator('#t')).toHaveText('new')
  } finally {
    rmDir(root)
  }
})

test('P3R2B-2 충돌 검토 — [소스 제어] 충돌 검토 → 변경 비교 탭 충돌만, 누르면 에디터(충돌 띠), ✓ 로 해결 표시', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo(true)
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="scm"]')
    await page.click('[data-scm="conflict-review"]')
    await expect(page.locator('[data-diff="conflicts"]')).toHaveAttribute('aria-pressed', 'true')
    const row = page.locator('[data-diff-conflict="a.txt"]')
    await expect(row).toBeVisible()
    await expect(page.locator('[data-diff-file="a.txt"]')).toHaveCount(0)
    await row.locator('.diffm-open').click()
    await expect(page.locator('[data-code="merge-conflict"]')).toBeVisible()
    await page.click('[data-aiws="diff-open"]')
    await page.locator('[data-diff-conflict="a.txt"] [data-diff="resolve"]').click()
    await expect(page.locator('[data-diff="no-conflicts"]')).toBeVisible({ timeout: 15_000 })
  } finally {
    rmDir(root)
  }
})

test('P3R2B-3 에디터 확대(Ctrl+=/0)·자동 저장(설정 켬 → 1초 뒤 디스크)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="explorer"]')
    await page.locator('[data-aiws="explorer"] .frow:has(.fn:text-is("a.txt"))').dblclick()
    const ed = page.locator('.code-ed .monaco-editor')
    await expect(ed).toBeVisible()
    const size = () => ed.locator('.view-lines').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
    const base = await size()
    await ed.click()
    await page.keyboard.press('Control+Equal')
    await expect.poll(size).toBe(base + 1)
    await page.keyboard.press('Control+Digit0')
    await expect.poll(size).toBe(base)

    // 자동 저장 켜기(설정 › 편집기)는 화면을 오가지 않게 설정 저장 길로 — 같은 updateEditorPrefs 를 탄다.
    await page.evaluate(async () => {
      const snap = await window.ev.workspace.load()
      await window.ev.ui.setPrefs({ ...snap.ui, codeEditor: { ...(snap.ui.codeEditor ?? {}), autoSave: true, autoSaveDelayMs: 500 } } as never)
    })
    await page.reload()
    await openProject(app, page, repo).catch(() => {})
    await page.locator('[data-aiws="explorer"] .frow:has(.fn:text-is("a.txt"))').dblclick()
    await page.locator('.code-ed .monaco-editor').click()
    await page.keyboard.press('End')
    await page.keyboard.type('Z')
    await expect.poll(() => readFileSync(join(repo, 'a.txt'), 'utf8'), { timeout: 10_000 }).toContain('aZ')
  } finally {
    rmDir(root)
  }
})
