// M2 라운드 2 — 작업 단위 화면(WS-02~05): AI 작업 공간 왼쪽 워크트리 목록 · 새 작업 · 생성 진행 · 지우기.
// 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다). 워크트리는 main 이 ARA_E2E 일 때 userData/workspaces 에 만든다
// (사용자 홈 ~/ara/workspaces 를 건드리지 않는다 — main/worktrees/feature.ts). 폴더 고르기 OS 창은 main 에서 바꿔 끼운다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir, dialog, dialogConfirm } from './fixtures'

const side = '.aiws-side'

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-repo-'))
  const repo = join(root, 'shop-api')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('tag', 'v1')
  return { root, repo }
}

test('WT-1★ AI 작업 공간 → 프로젝트 추가 → 새 작업(워크트리) → 사이드바 → 핀 → 워크트리 없이 열기 → 지우기', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    // AI 작업 공간(M3 부터 기본 공개 — 실험 기능 토글 없음).
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect(page.locator(side)).toBeVisible()
    await expect(page.locator(`${side} [data-aiws="new"]`)).toBeDisabled() // 프로젝트가 없으면 새 작업도 없다

    // 프로젝트 추가 — OS 폴더 창 대신 고른 셈 칠 경로를 돌려준다.
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await expect(page.locator(`${side} .aiws-grp`)).toContainText('shop-api')
    const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
    await expect(mainRow).toContainText('기본 브랜치')

    // 새 작업 — 이름 + 분기 지점(태그 v1 검색) + 워크트리로 → 만들기.
    await page.click(`${side} [data-aiws="new"]`)
    await page.fill('[data-aiws="new-name"]', 'feat-retry')
    await page.fill('[data-aiws="new-base-search"]', 'v1')
    await page.click('.aiws-ref[data-ref="v1"]')
    await expect(page.locator('[data-aiws="new-base-value"]')).toHaveText('v1')
    await expect(page.locator('.aiws-mode[data-mode="worktree"]')).toHaveAttribute('aria-checked', 'true')
    // M3: 이 시험은 에이전트를 안 띄운다(설치된 진짜 CLI 가 기본으로 골라지지 않게).
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')

    // 사이드바에 보이고(진행 줄은 금방 지나갈 수 있다 — 끝 상태를 본다), 고른 줄이 된다 → 타이틀바·상태바에 반영.
    const feat = page.locator(`${side} .aiws-row`).filter({ hasText: 'feat-retry' })
    await expect(feat).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`${side} .aiws-pending`)).toHaveCount(0)
    await expect(feat).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.titlebar .tb-server')).toHaveText('shop-api')
    await expect(page.locator('.titlebar .tb-path')).toHaveText('feat-retry')
    await expect(page.locator('.statusbar .aiws-ahead')).toHaveText('main 에서 0 커밋 앞')

    // 핀 — 맨 위 "고정" 묶음으로 옮겨 간다.
    await feat.hover()
    await feat.locator('[data-aiws="pin"]').click()
    await expect(page.locator(`${side} .aiws-grp`).first()).toContainText('고정')
    await expect(page.locator(`${side} .aiws-row`).first()).toContainText('feat-retry')
    await expect(page.locator(`${side} .aiws-row[data-pinned]`)).toHaveCount(1)

    // 이름 검색 — 맞지 않는 줄은 빠진다.
    await page.click(`${side} [data-aiws="filter"]`)
    await page.fill(`${side} [data-aiws="filter-input"]`, 'retry')
    await expect(page.locator(`${side} .aiws-row`)).toHaveCount(1)
    await page.press(`${side} [data-aiws="filter-input"]`, 'Escape')
    await expect(page.locator(`${side} .aiws-row`)).toHaveCount(2)

    // 워크트리 없이 열기 — 본 폴더 줄이 고른 줄이 된다(git 호출 없음).
    await page.click(`${side} [data-aiws="new"]`)
    await page.click('.aiws-mode[data-mode="none"]')
    await expect(page.locator('[data-aiws="new-name"]')).toHaveCount(0)
    // M3: 이 시험은 에이전트를 안 띄운다(설치된 진짜 CLI 가 기본으로 골라지지 않게).
    await page.selectOption('[data-aiws="new-agent"]', '')
    await page.click('[data-aiws="new-create"]')
    await expect(mainRow).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.titlebar .tb-path')).toHaveText('main')

    // 지우기 — 확인 대화상자가 브랜치도 지운다고 말하고, 지우면 줄이 빠진다. M10 R2 WS-21: 커밋 없는 브랜치는 같이 지운다(Orca).
    const pinned = page.locator(`${side} .aiws-row[data-pinned]`)
    await pinned.hover()
    await pinned.locator('[data-aiws="remove"]').click()
    await expect(dialog(page)).toContainText('브랜치 feat-retry 를 지웁니다')
    await dialogConfirm(page)
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'feat-retry' })).toHaveCount(0)
    const branches = execFileSync('git', ['branch', '--list', 'feat-retry'], { cwd: repo, encoding: 'utf8' })
    expect(branches.trim()).toBe('')
  } finally {
    rmDir(root)
  }
})
