// M10 R1 — 작업 단위 2차(WS-14~17): 브랜치 자동 이름 · 프로젝트 그룹 · 재우기·보관 · 삭제 단축키.
// 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다). 워크트리는 ARA_E2E 면 userData/workspaces 에 만든다.
// 에이전트는 띄우지 않는다(진짜 CLI 안 씀) — 재우기·깨우기의 탭 되살리기는 단위 시험(tests/aiwsSleep.test.ts)이 맡는다.
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
  return { root, repo }
}

test('WT-M10★ 자동 이름 → 프로젝트 그룹(만들기·접기) → 재우기·깨우기 → 보관·복원 → 삭제 단축키', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeRepo()
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect(page.locator(side)).toBeVisible()
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await expect(page.locator(`${side} .aiws-grp`)).toContainText('shop-api')

    // WS-14 이름 칸을 비우고 만들기 — 바다 생물 이름(소문자)으로 브랜치·폴더가 생긴다.
    await page.click(`${side} [data-aiws="new"]`)
    await expect(page.locator('[data-aiws="new-name"]')).toHaveAttribute('placeholder', /비우면 자동 이름 — [a-z]/)
    await page.selectOption('[data-aiws="new-agent"]', '')
    await expect(page.locator('[data-aiws="new-create"]')).toBeEnabled()
    await page.click('[data-aiws="new-create"]')
    const auto = page.locator(`${side} .aiws-row:not([data-wt$="shop-api"])`).first()
    await expect(auto).toBeVisible({ timeout: 30_000 })
    const autoName = (await auto.locator('.aiws-row-name').innerText()).trim()
    expect(autoName).toMatch(/^[a-z][a-z-]*$/)
    expect(execFileSync('git', ['branch', '--list', autoName], { cwd: repo, encoding: 'utf8' })).toContain(autoName)

    // WS-15 프로젝트 머리줄 ⋯ → 그룹으로 옮기기 → 새 그룹… → 이름 → 그룹 머리줄 아래로. 머리줄을 누르면 접힌다.
    await page.locator(`${side} .aiws-grp[data-group^="repo:"]`).hover()
    await page.click(`${side} [data-aiws="project-menu"]`)
    await page.hover('.ctx-menu [data-action="move"]')
    await page.click('.ctx-submenu [data-action="new"]')
    await dialog(page).locator('.dlg-input').fill('Work')
    await dialogConfirm(page)
    const grp = page.locator(`${side} .aiws-pgrp`)
    await expect(grp).toContainText('Work')
    await expect(page.locator(`${side} .aiws-grp.d1`)).toContainText('shop-api')
    await grp.click()
    await expect(grp).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(`${side} .aiws-row`)).toHaveCount(0)
    await grp.click()
    await expect(page.locator(`${side} .aiws-row`)).toHaveCount(2)

    // WS-16 재우기 → 잠듦(흐림·달) → 줄을 고르면 깨어난다.
    const row = page.locator(`${side} .aiws-row`).filter({ hasText: autoName })
    await row.hover()
    await row.locator('[data-aiws="sleep"]').click()
    await expect(row).toHaveAttribute('data-sleeping', 'true')
    await expect(row).toContainText('잠듦')
    await row.click()
    await expect(row).not.toHaveAttribute('data-sleeping', 'true')

    // 보관(우클릭 메뉴) → 목록에서 사라짐 → 보관함에서 복원.
    await row.click({ button: 'right' })
    await page.click('.ctx-menu [data-action="archive"]')
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: autoName })).toHaveCount(0)
    await page.click(`${side} [data-aiws="archived"]`)
    const archived = page.locator(`${side} .aiws-row[data-archived]`)
    await expect(archived).toHaveCount(1)
    await archived.hover()
    await archived.locator('[data-aiws="restore"]').click()
    await expect(page.locator(`${side}`)).toContainText('보관한 워크트리가 없습니다')
    await page.click(`${side} [data-aiws="archived"]`)
    await expect(row).toBeVisible()

    // WS-17 삭제 단축키 — 고른 작업 단위에서 Ctrl+Shift+Backspace → 늘 확인 대화상자 → 지움(브랜치는 남음).
    await row.click()
    await page.keyboard.press('Control+Shift+Backspace')
    await expect(dialog(page)).toContainText(`브랜치 ${autoName} 는 남습니다`)
    await dialogConfirm(page)
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: autoName })).toHaveCount(0)
    // 본 작업 폴더에서 누르면 "프로젝트를 목록에서 빼기" — 취소하면 그대로.
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
    await page.keyboard.press('Control+Shift+Backspace')
    await expect(dialog(page)).toContainText('목록에서 뺍니다')
    await dialog(page).locator('.modal-ft .btn.sec').click()
    await expect(page.locator(`${side} .aiws-row`)).toHaveCount(1)
  } finally {
    rmDir(root)
  }
})
