// M12 R1 코드 보기 2차 — CV-01 파일 탐색기(터미널 [파일] 탭과 한 구현) · CV-02 뷰어 · CV-03 워크트리 점프(M12 R2: Ctrl+Shift+J — AI 공간에서만).
// 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다). 폴더 고르기 OS 창은 main 에서 바꿔 끼운다(code.spec 와 같은 방법).
// 작성만 — 실행은 메인(phase2-common).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, dialog, dialogConfirm, newLocalShell, runCommand } from './fixtures'

const side = '.aiws-side'
const panel = '[data-aiws="explorer"]'
// 1×1 PNG(투명) — 뷰어가 실제로 그렸는지 naturalWidth 로 본다.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-cv-'))
  const repo = join(root, 'shop-api')
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true })
  writeFileSync(join(repo, 'src', 'Order.java'), 'class Order {}\n')
  writeFileSync(join(repo, 'src', 'lib', 'Util.java'), 'class Util {}\n')
  writeFileSync(join(repo, 'shot.png'), PNG)
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

const row = (page: Page, rel: string) => page.locator(`${panel} .frow[data-path="${rel.replace(/\//g, process.platform === 'win32' ? '\\\\' : '/')}"]`)

test('CV-1★ AI 탐색기 — 트리 펴기·파일 열기·git 색(감시)·새 파일·끌어 옮기기·삭제(휴지통)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="explorer"]')
    await expect(page.locator('.rbar [data-rbar="explorer"]')).toHaveAttribute('aria-pressed', 'true')
    // 뿌리 고정 — 상위로·경로 줄이 없다.
    await expect(page.locator(`${panel} .fpath-row`)).toBeHidden()

    // 폴더 한 번 누름 = 펼침(Orca), 하위 줄은 들여 쓴다.
    await row(page, 'src').click()
    await expect(row(page, 'src')).toHaveAttribute('data-open', '')
    await expect(row(page, 'src/Order.java')).toBeVisible()
    await row(page, 'src/lib').locator('.ftw').click()
    await expect(row(page, 'src/lib/Util.java')).toBeVisible()

    // 파일 한 번 누름 = 가운데 탭으로 열기.
    await row(page, 'src/Order.java').click()
    await expect(page.locator('.aiws-tab[data-file-tab="Order.java"]')).toHaveAttribute('aria-selected', 'true')

    // 밖에서 고치면(에이전트 대역) 감시가 트리와 git 색을 다시 읽는다 — 수정 = 노랑, 새 파일 = 초록, 폴더 = 아래에 바뀐 것.
    writeFileSync(join(repo, 'src', 'Order.java'), 'class Order { int x; }\n')
    writeFileSync(join(repo, 'src', 'New.java'), 'class New {}\n')
    await expect(row(page, 'src/Order.java')).toHaveClass(/git-modified/, { timeout: 10_000 })
    await expect(row(page, 'src/New.java')).toHaveClass(/git-untracked/, { timeout: 10_000 })
    await expect(row(page, 'src')).toHaveClass(/git-dirty/)

    // 새 파일 — 폴더 줄에서 고르면 그 안에(Orca). 우클릭은 그 줄만 고른다(펼침·접힘 없이).
    await row(page, 'src/lib').click({ button: 'right' })
    await page.click('.ctx-menu .ctx-item[data-action="file.newFile"]')
    await expect(dialog(page)).toBeVisible()
    await page.fill('.dlg-input', 'Made.java')
    await dialogConfirm(page)
    await expect.poll(() => existsSync(join(repo, 'src', 'lib', 'Made.java'))).toBe(true)
    await expect(row(page, 'src/lib/Made.java')).toBeVisible()

    // 끌어 옮기기 — 파일 줄을 폴더 줄에 놓는다.
    await row(page, 'src/New.java').dragTo(row(page, 'src/lib'))
    await expect.poll(() => existsSync(join(repo, 'src', 'lib', 'New.java'))).toBe(true)
    expect(existsSync(join(repo, 'src', 'New.java'))).toBe(false)

    // 삭제 = 휴지통(확인 창이 그렇게 말한다).
    await row(page, 'src/lib/Made.java').click({ button: 'right' })
    await page.click('.ctx-menu .ctx-item[data-action="file.delete"]')
    await expect(dialog(page)).toContainText('휴지통으로 보냅니다')
    await dialogConfirm(page)
    await expect.poll(() => existsSync(join(repo, 'src', 'lib', 'Made.java'))).toBe(false)

    // 탐색기를 열면 소스 제어는 닫힌다(오른쪽 자리 하나).
    await page.click('.rbar [data-rbar="scm"]')
    await expect(page.locator(panel)).toHaveCount(0)
    await expect(page.locator('.rbar [data-rbar="explorer"]')).toHaveAttribute('aria-pressed', 'false')
  } finally {
    rmDir(root)
  }
})

test('CV-2 뷰어 — 이미지는 글 에디터가 아니라 뷰어 탭(Monaco 를 부르지 않는다)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await openProject(app, page, repo)
    await page.click('.rbar [data-rbar="explorer"]')
    await row(page, 'shot.png').click()
    await expect(page.locator('.aiws-tab[data-file-tab="shot.png"]')).toHaveAttribute('aria-selected', 'true')
    const img = page.locator('.media-view[data-media="image"] img')
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((e) => (e as HTMLImageElement).naturalWidth)).toBe(1)
    await expect(page.locator('.monaco-editor')).toHaveCount(0)
    expect(await page.evaluate(() => 'MonacoEnvironment' in globalThis)).toBe(false)
  } finally {
    rmDir(root)
  }
})

test('CV-3 워크트리 점프 — Ctrl+Shift+J 로 다른 워크트리를 찾아 Enter(Ctrl+J 는 안 잡고, 하단 패널도 안 열림)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat-jump', join(root, 'shop-api-feat')], { cwd: repo, stdio: 'ignore' })
    await openProject(app, page, repo)
    // M10 R2 WS-19: 손으로 만든 워크트리는 새 프로젝트에서 숨는다(Orca) — 숨은 워크트리 카드 → [보이기].
    await page.click(`${side} [data-aiws="hidden-wt"]`)
    await page.click('.aiws-dlg [data-aiws="ext-show"]')
    await page.keyboard.press('Escape')
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'feat-jump' })).toBeVisible()
    const pal = page.locator('[data-aiws="worktree-jump"]')
    // M12 R2: Ctrl+J 단독은 앱이 잡지 않는다(에이전트 터미널의 Claude Code 줄바꿈으로 간다).
    await page.keyboard.press('Control+J')
    await expect(pal).toHaveCount(0)
    await page.keyboard.press('Control+Shift+J')
    await expect(pal).toBeVisible()
    // AI 공간에선 같은 키가 하단 패널을 열지 않는다(터미널 공간 전용).
    await expect(page.locator('.bottom-panel')).toHaveCount(0)
    // 지금 것(main)은 빠진다.
    await expect(pal.locator('.qo-item')).toHaveCount(1)
    await page.keyboard.type('jump')
    await expect(pal.locator('.qo-item.on')).toContainText('feat-jump')
    await page.keyboard.press('Enter')
    await expect(pal).toHaveCount(0)
    await expect(page.locator(`${side} .aiws-row[aria-current="true"]`)).toContainText('feat-jump')
  } finally {
    rmDir(root)
  }
})

test('CV-4 터미널 [파일] 탭도 같은 트리 — ▸ 로 펴면 하위 줄이 들여 써서 붙는다', async ({ ara }) => {
  const { page } = ara
  const dir = realpathSync(tempDir('ara-e2e-cvt-'))
  try {
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', 'inner.txt'), 'x\n')
    const id = await newLocalShell(page)
    await runCommand(page, id, `cd "${dir.replace(/\\/g, '/')}"`)
    if ((await page.locator('.sb-tab.on[data-tab="file"]').count()) === 0) await page.keyboard.press('Control+Shift+E')
    const pkg = page.locator('.sftp-wrap .frow[data-path="pkg"]')
    await expect(pkg).toBeVisible({ timeout: 25_000 })
    await pkg.locator('.ftw').click()
    const inner = page.locator(`.sftp-wrap .frow[data-path="pkg${process.platform === 'win32' ? '\\\\' : '/'}inner.txt"]`)
    await expect(inner).toBeVisible()
    expect(await inner.evaluate((e) => getComputedStyle(e).getPropertyValue('--fdepth').trim())).toBe('1')
    expect(readFileSync(join(dir, 'pkg', 'inner.txt'), 'utf8')).toBe('x\n')
  } finally {
    rmDir(dir)
  }
})
