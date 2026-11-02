// 3차 작업 단위(WS-23~27): orca.yaml 승인·setup·공유 폴더 → 하위 작업(중첩) + sparse 프리셋 → 하위 칩 접기 → 정리 화면(크기 재기·지우기) → 자손까지 지우기.
// 저장소는 임시 폴더에 git init 한 것만. 워크트리는 ARA_E2E 면 userData/workspaces 에. 에이전트는 띄우지 않는다.
// setup 스크립트는 cmd·bash 둘 다 되는 한 줄(echo ok> marker.txt).
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const side = '.aiws-side'

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-wt3-'))
  const repo = join(root, 'mono')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  mkdirSync(join(repo, 'apps', 'api'), { recursive: true })
  mkdirSync(join(repo, '.cache'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'apps', 'web', 'w.txt'), 'w\n')
  writeFileSync(join(repo, 'apps', 'api', 'a.txt'), 'a\n')
  writeFileSync(join(repo, '.gitignore'), '.cache/\nmarker.txt\n')
  writeFileSync(join(repo, '.cache', 'keep.txt'), 'k\n')
  writeFileSync(
    join(repo, 'orca.yaml'),
    'setupAgentStartupPolicy: wait-for-setup\nscripts:\n  setup: |\n    echo ok> marker.txt\n  archive: |\n    echo bye\nworktree:\n  sharedDirectories:\n    - .cache\n'
  )
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { root, repo }
}

test('WT-P3★ orca.yaml 승인·setup·공유 폴더 → 하위 작업 + sparse → 칩 접기 → 정리 화면 → 자손까지 지우기', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  const topModal = () => page.locator('.dlg-overlay .modal.sm').last()
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect(page.locator(side)).toBeVisible()
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await expect(page.locator(`${side} .aiws-grp`)).toContainText('mono')

    // WS-23 새 작업 카드 — orca.yaml 칸이 보이고 처음 보는 스크립트라 승인을 묻는다 → 승인 → wait-for-setup 이라 줄이 생길 때 marker 가 있다.
    await page.click(`${side} [data-aiws="new"]`)
    await expect(page.locator('[data-aiws="new-yaml"]')).toContainText('승인')
    await page.fill('[data-aiws="new-name"]', 'par')
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')
    await expect(topModal()).toContainText('scripts.setup')
    await expect(topModal()).toContainText('echo ok> marker.txt')
    await topModal().locator('.modal-ft .btn.pri, .modal-ft .btn.dgr').click()
    const par = page.locator(`${side} .aiws-row[data-wt]`).filter({ hasText: 'par' }).first()
    await expect(par).toBeVisible({ timeout: 60_000 })
    const parPath = (await par.getAttribute('data-wt'))!.split('::')[1]
    expect(readFileSync(join(parPath, 'marker.txt'), 'utf8').trim()).toBe('ok')
    expect(lstatSync(join(parPath, '.cache')).isSymbolicLink()).toBe(true)

    // WS-24·27 줄 우클릭 › 하위 작업 만들기 → 부모가 미리 골라져 있다 → sparse 프리셋(apps/web) 만들기 → 만들기(이미 승인 — 다시 안 묻는다).
    await par.click({ button: 'right' })
    await page.click('.ctx-menu [data-action="child"]')
    await expect(page.locator('[data-aiws="new-parent"]')).toHaveValue(/::/)
    await page.click('[data-aiws="sparse-new"]')
    await page.fill('[data-aiws="sparse-name"]', 'web')
    await page.fill('[data-aiws="sparse-dirs"]', 'apps/web')
    await page.click('[data-aiws="sparse-save"]')
    await expect(page.locator('[data-aiws="new-sparse"] option:checked')).toContainText('web')
    await page.fill('[data-aiws="new-name"]', 'kid')
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')
    const kid = page.locator(`${side} .aiws-row[data-depth="1"]`).filter({ hasText: 'kid' })
    await expect(kid).toBeVisible({ timeout: 60_000 })
    await expect(kid.locator('[data-aiws="sparse"]')).toBeVisible()
    const kidPath = (await kid.getAttribute('data-wt'))!.split('::')[1]
    expect(existsSync(join(kidPath, 'apps', 'web', 'w.txt'))).toBe(true)
    expect(existsSync(join(kidPath, 'apps', 'api'))).toBe(false)

    // 부모 줄의 "하위 1" 칩 — 접으면 자식이 숨고 펴면 돌아온다.
    const chip = par.locator('[data-aiws="children"]')
    await expect(chip).toContainText('하위 1')
    await chip.click()
    await expect(kid).toHaveCount(0)
    await chip.click()
    await expect(kid).toBeVisible()

    // WS-25·26 정리 화면 — 둘 다 병합됨(커밋 없음) → 크기 재기 → 합계 → kid 만 골라 지우기.
    await page.click(`${side} [data-aiws="cleanup"]`)
    const list = page.locator('.aiws-cleanup [data-aiws="cleanup-list"]')
    await expect(list.locator('.aiws-cleanup-row')).toHaveCount(2, { timeout: 30_000 })
    await page.click('.aiws-cleanup [data-filter="merged"]')
    await expect(list.locator('.aiws-cleanup-row')).toHaveCount(2)
    await page.click('.aiws-cleanup [data-aiws="cleanup-measure"]')
    await expect(page.locator('.aiws-cleanup [data-aiws="cleanup-total"]')).toContainText('합계', { timeout: 60_000 })
    await list.locator('.aiws-cleanup-row').filter({ hasText: 'kid' }).locator('input').check()
    await page.click('.aiws-cleanup [data-aiws="cleanup-remove"]')
    await topModal().locator('.modal-ft .btn.pri, .modal-ft .btn.dgr').click()
    await expect(list.locator('.aiws-cleanup-row')).toHaveCount(1, { timeout: 30_000 })
    await page.locator('.aiws-cleanup .modal-ft .btn.sec').last().click()
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'kid' })).toHaveCount(0)
    expect(existsSync(kidPath)).toBe(false)

    // WS-24 자손까지 지우기 — 하위 하나 더 → 부모 우클릭 › 자손까지 지우기… → 한 번 확인 → 둘 다 사라지고 본 폴더 .cache 는 그대로.
    await par.click({ button: 'right' })
    await page.click('.ctx-menu [data-action="child"]')
    await page.fill('[data-aiws="new-name"]', 'kid2')
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')
    await expect(page.locator(`${side} .aiws-row[data-depth="1"]`).filter({ hasText: 'kid2' })).toBeVisible({ timeout: 60_000 })
    await par.click({ button: 'right' })
    await expect(page.locator('.ctx-menu [data-action="remove"]')).toContainText('자손까지')
    await page.click('.ctx-menu [data-action="remove"]')
    await expect(topModal()).toContainText('kid2')
    await topModal().locator('.modal-ft .btn.pri, .modal-ft .btn.dgr').click()
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: /^.*(par|kid2).*$/ })).toHaveCount(0, { timeout: 30_000 })
    expect(existsSync(parPath)).toBe(false)
    expect(readFileSync(join(repo, '.cache', 'keep.txt'), 'utf8')).toBe('k\n')
  } finally {
    rmDir(root)
  }
})
