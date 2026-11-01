// M6 R1 코드 에디터(WS-07 Monaco · WS-08 변경 감지 안전 저장). 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다).
// 파일 고르기 OS 창은 main 에서 바꿔 끼운다(worktrees.spec 와 같은 방법). 밖에서 바꾸기 = 시험이 디스크에 직접 쓴다(에이전트 대역).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, dialog, dialogConfirm, dialogAlt } from './fixtures'

const side = '.aiws-side'
const editor = '[data-code="editor"] .monaco-editor'

function makeRepo(): { root: string; repo: string; file: string } {
  const root = realpathSync(tempDir('ara-e2e-code-'))
  const repo = join(root, 'shop-api')
  mkdirSync(join(repo, 'src'), { recursive: true })
  const file = join(repo, 'src', 'OrderRetryPolicy.java')
  writeFileSync(file, 'class OrderRetryPolicy {\n  int max = 3;\n}\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { root, repo, file }
}

/** OS 창(폴더·파일 고르기)이 이 경로를 고른 셈 친다. */
async function pickReturns(app: ElectronApplication, p: string): Promise<void> {
  await app.evaluate(({ dialog: d }, picked) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
  }, p)
}

/** Monaco 가 불렸나 — monacoSetup 이 MonacoEnvironment 를 걸고, 청크·워커 파일이 리소스 기록에 남는다. */
async function monacoLoaded(page: Page): Promise<{ env: boolean; chunks: string[] }> {
  return page.evaluate(() => ({
    env: 'MonacoEnvironment' in globalThis,
    chunks: performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => /CodeEditor-|editor\.api|editor\.worker|monaco/i.test(n))
  }))
}

async function openProject(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(side)).toBeVisible()
  await pickReturns(app, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
  await mainRow.click()
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
}

test('CODE-1★ AI 공간을 열고 파일을 안 열면 Monaco 청크가 안 불린다 → 열면 불린다', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, file } = makeRepo()
  try {
    await openProject(app, page, repo)
    // 양성 대조를 위해 같은 검사를 열기 전·후 둘 다 한다 — 뒤에서 잡혀야 앞의 0 이 "없다"는 뜻이 된다.
    // file:// 의 동적 import 는 Resource Timing 에 안 잡힌다(실측 — 열고 나서도 0) — 청크 목록은 판정에 못 쓴다.
    // MonacoEnvironment(첫 파일을 열 때 모듈이 설정)와 .monaco-editor 가 양쪽 판정이다.
    expect((await monacoLoaded(page)).env).toBe(false)
    await expect(page.locator('.monaco-editor')).toHaveCount(0)

    await pickReturns(app, file)
    await page.click('.rbar [data-rbar="explorer"]')
    await expect(page.locator('.aiws-tab[data-file-tab="OrderRetryPolicy.java"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(editor)).toBeVisible()
    await expect(page.locator(`${editor} .view-lines`)).toContainText('int max = 3;')
    const after = await monacoLoaded(page)
    expect(after.env).toBe(true)
    // CDN 로더를 껐다 — 밖으로 나간 요청이 없다.
    const cdn = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /jsdelivr|unpkg|cdn/i.test(e.name)).length)
    expect(cdn).toBe(0)
  } finally {
    rmDir(root)
  }
})

test('CODE-2★ 파일 열기 → 수정(더러움 ●) → Ctrl+S 저장 → 디스크 반영 · 더러운 탭 닫기는 묻는다', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, file } = makeRepo()
  try {
    await openProject(app, page, repo)
    await pickReturns(app, file)
    await page.click('.rbar [data-rbar="explorer"]')
    const tab = page.locator('.aiws-tab[data-file-tab="OrderRetryPolicy.java"]')
    await expect(page.locator(editor)).toBeVisible()

    await page.locator(`${editor} .view-lines`).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('// saved by ara')
    await expect(tab.locator('[data-code="dirty"]')).toBeVisible()
    await page.keyboard.press('Control+S')
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('// saved by ara')
    await expect(tab.locator('[data-code="dirty"]')).toHaveCount(0)

    // 더러운 탭 닫기 → 저장 / 저장 안 함 / 취소. 저장 안 함 → 탭이 닫히고 디스크는 그대로.
    await page.keyboard.type('X')
    await expect(tab.locator('[data-code="dirty"]')).toBeVisible()
    await tab.locator('.aiws-ic').click()
    await expect(dialog(page)).toBeVisible()
    await dialogAlt(page)
    await expect(tab).toHaveCount(0)
    expect(readFileSync(file, 'utf8')).not.toContain('// saved by araX')
  } finally {
    rmDir(root)
  }
})

test('CODE-3★ 밖에서 변경 — 깨끗하면 조용히 다시 읽기, 더러우면 충돌 안내, 저장 땐 덮어쓰기 전에 묻는다', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo, file } = makeRepo()
  try {
    await openProject(app, page, repo)
    await pickReturns(app, file)
    await page.click('.rbar [data-rbar="explorer"]')
    const lines = page.locator(`${editor} .view-lines`)
    await expect(lines).toContainText('int max = 3;')

    // ① 깨끗한 탭 — 에이전트가 고치면 그대로 따라온다(띠 없음).
    writeFileSync(file, 'class OrderRetryPolicy {\n  int max = 5;\n}\n')
    await expect(lines).toContainText('int max = 5;', { timeout: 10_000 })
    await expect(page.locator('[data-code="conflict"]')).toHaveCount(0)

    // ② 더러운 탭 — 충돌 띠. 내 것 유지 → 저장하면 덮어쓸지 묻는다 → 덮어쓰기.
    await lines.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('// MINE')
    writeFileSync(file, 'class OrderRetryPolicy {\n  int max = 7; // AGENT\n}\n')
    await expect(page.locator('[data-code="conflict"]')).toBeVisible({ timeout: 10_000 })
    await expect(lines).toContainText('// MINE') // 내 글은 그대로
    await page.click('[data-code="keep-mine"]')
    await expect(page.locator('[data-code="conflict"]')).toHaveCount(0)
    await lines.click()
    await page.keyboard.press('Control+S')
    await expect(dialog(page)).toBeVisible()
    expect(readFileSync(file, 'utf8')).toContain('// AGENT') // 묻기 전엔 안 썼다
    await dialogConfirm(page)
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('// MINE')

    // ③ 다시 더럽힌 뒤 밖에서 변경 → 디스크 것 받기 → 디스크 내용, 더러움 없음.
    await lines.click()
    await page.keyboard.type('// MINE2')
    writeFileSync(file, 'class OrderRetryPolicy { /* AGENT2 */ }\n')
    await expect(page.locator('[data-code="conflict"]')).toBeVisible({ timeout: 10_000 })
    await page.click('[data-code="take-disk"]')
    await expect(lines).toContainText('AGENT2')
    await expect(lines).not.toContainText('MINE2')
    await expect(page.locator('.aiws-tab[data-file-tab="OrderRetryPolicy.java"] [data-code="dirty"]')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})
