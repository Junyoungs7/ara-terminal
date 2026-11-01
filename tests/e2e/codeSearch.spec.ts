// M6 R2 WS-06 빠른 열기(Ctrl+P) · WS-09 전체 검색. 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다).
// 줄 이동 판정: 300줄 파일의 250번째 줄 — Monaco 는 보이는 줄만 그리므로 그 줄 글이 .view-lines 에 있고 줄 번호 칸의 현재 줄이 250 이면 그 줄로 간 것이다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir } from './fixtures'

const side = '.aiws-side'
const editor = '[data-code="editor"] .monaco-editor'
const TARGET = 250

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-search-'))
  const repo = join(root, 'shop-api')
  mkdirSync(join(repo, 'src', 'order'), { recursive: true })
  writeFileSync(join(repo, 'src', 'order', 'OrderRetryPolicy.java'), 'class OrderRetryPolicy {\n  int max = 3;\n}\n')
  writeFileSync(join(repo, 'README.md'), '# shop\n')
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'OrderRetryPolicy.class'), 'binary-ish\n')
  const lines = Array.from({ length: 300 }, (_, i) => (i + 1 === TARGET ? '  // ARA_NEEDLE here' : `  line ${i + 1}`))
  writeFileSync(join(repo, 'src', 'Big.java'), lines.join('\n') + '\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
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

test('QO-1★ Ctrl+P → 퍼지로 찾기(.gitignore 무시) → Enter 로 열림 → 다시 열면 최근 파일이 맨 위', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.keyboard.press('Control+P')
    const input = page.locator('.qo-drop [data-field="quickopen"]')
    await expect(input).toBeFocused()
    await expect(page.locator('.qo-item').first()).toBeVisible()
    await input.fill('orp')
    // 첫 줄 = 이름이 맞는 소스. 무시된 build/ 의 같은 이름은 목록에 없다.
    await expect(page.locator('.qo-item').first()).toHaveAttribute('data-path', 'src/order/OrderRetryPolicy.java')
    await expect(page.locator('.qo-item[data-path^="build/"]')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(page.locator('.qo-drop')).toHaveCount(0)
    await expect(page.locator('.aiws-tab[data-file-tab="OrderRetryPolicy.java"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`${editor} .view-lines`)).toContainText('int max = 3;')

    // 빈 검색어로 다시 열면 방금 연 파일이 맨 위(최근 우선). Esc 로 닫힌다.
    await page.keyboard.press('Control+P')
    await expect(page.locator('.qo-item').first()).toHaveAttribute('data-path', 'src/order/OrderRetryPolicy.java')
    await page.keyboard.press('Escape')
    await expect(page.locator('.qo-drop')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})

test('QO-2 터미널 공간의 Ctrl+P 는 빠른 열기를 열지 않는다(셸의 이전 명령 키로 남는다)', async ({ ara }) => {
  const { page } = ara
  await page.click('.titlebar .tb-spaces [data-space="term"]')
  await page.keyboard.press('Control+P')
  await expect(page.locator('.qo-drop')).toHaveCount(0)
})

test('SRCH-1★ 레일 [검색] → 검색어 → 파일별 결과 → 누르면 그 줄로 열림 · 결과는 남는다 · 정규식 오류는 rg 의 말', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.ai-rail .ai-rail-item[data-aiws="search"]')
    await expect(page.locator('.ai-rail .ai-rail-item[data-aiws="search"]')).toHaveAttribute('aria-pressed', 'true')
    const panel = page.locator('.aiws-search')
    await expect(panel).toBeVisible()
    await panel.locator('[data-field="search.query"]').fill('ARA_NEEDLE')
    const file = panel.locator('[data-search-file="src/Big.java"]')
    await expect(file).toBeVisible()
    await expect(file.locator('.srch-hit mark')).toHaveText('ARA_NEEDLE')
    await expect(panel.locator('[data-search="status"]')).toContainText('1')

    await file.locator(`.srch-hit[data-line="${TARGET}"]`).click()
    await expect(page.locator('.aiws-tab[data-file-tab="Big.java"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`${editor} .view-lines`)).toContainText('ARA_NEEDLE')
    await expect(page.locator(`${editor} .line-numbers.active-line-number`)).toHaveText(String(TARGET))
    // 결과 패널은 왼쪽에 그대로(가운데만 파일로 바뀜).
    await expect(file).toBeVisible()

    // 정규식 켜고 깨진 식 → 실패 문구(결과 없음).
    await panel.locator('[data-search="regex"]').click()
    await panel.locator('[data-field="search.query"]').fill('ARA_NEEDLE(')
    await expect(panel.locator('[data-search="status"].err')).toBeVisible()
    await expect(panel.locator('.srch-file')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})
