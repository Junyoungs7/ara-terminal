// p3-M21 셋업 가이드 · 에이전트 잠재우기 · 펫 — 작성만(실행은 메인). 파일 고르기 창은 main 의 dialog 를 바꿔 끼운다(화면·클립보드 안 건드림).
// 잠재우기 자체(1분 + 60초 두 번 확인)는 e2e 로 기다리지 않는다 — 판정은 단위 시험 p3m21.test.ts, 여기선 설정 줄만.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const side = '.aiws-side'
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

async function openSettings(page: import('@playwright/test').Page, section: string): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`.settings-page .sp-nav [data-section="${section}"]`)
}

test('P3M21-1★ 셋업 가이드 — 사이드바 진행 줄 → 모달 8단계, 우클릭 숨기기, 설정 › 시작하기에서 다시 보이기', async ({ ara }) => {
  const { app, page } = ara
  const root = realpathSync(tempDir('ara-e2e-p3m21-'))
  const repo = join(root, 'guide-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    const entry = page.locator(`${side} [data-aiws="setup-entry"]`)
    await expect(entry).toBeVisible({ timeout: 20_000 })
    await expect(entry).toContainText('/8')
    await entry.click()
    const modal = page.locator('[data-aiws="setup-modal"]')
    await expect(modal.locator('[data-setup-step]')).toHaveCount(8)
    // 저장소 하나 → 두 개 추가는 아직(저절로 판정).
    await expect(modal.locator('[data-setup-step="add-two-repos"]')).not.toHaveAttribute('data-done', 'true')
    await modal.locator('[data-setup-step="setup-script"]').click()
    await expect(modal.locator('[data-setup-detail="setup-script"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    // 우클릭 → 숨기기 → 줄이 사라진다.
    await entry.click({ button: 'right' })
    await page.click('.ctx-menu .ctx-item[data-action="hide"]')
    await expect(entry).toHaveCount(0)
    // 설정 › 시작하기 — 같은 체크리스트, [사이드바에 다시 보이기].
    await openSettings(page, 'setupGuide')
    await expect(page.locator('.settings-page [data-aiws="setup-checklist"] [data-setup-step]')).toHaveCount(8)
    await page.click('.settings-page [data-aiws="setup-unhide"]')
    await page.keyboard.press('Escape')
    await expect(entry).toBeVisible()
  } finally {
    rmDir(root)
  }
})

test('P3M21-2 잠재우기 설정 — 기본 꺼짐 · 30분, 켜야 분 칸이 열리고 범위 밖은 30으로', async ({ ara }) => {
  const { page } = ara
  await openSettings(page, 'agents')
  const toggle = page.locator('.settings-page .set-row[data-item="agents.hibernate"] .set-toggle')
  const minutes = page.locator('.settings-page [data-field="agents.hibernateAfter"]')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(minutes).toHaveValue('30')
  await expect(minutes).toBeDisabled()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(minutes).toBeEnabled()
  await minutes.fill('5')
  await minutes.blur()
  await expect(minutes).toHaveValue('5')
  await minutes.fill('0')
  await minutes.blur()
  await expect(minutes).toHaveValue('30')
})

test('P3M21-3★ 펫 — 기본 꺼짐, 켜면 올리기 안내, 그림 올리면 떠 있고 끌어 옮김, 우클릭 숨기기', async ({ ara }) => {
  const { app, page } = ara
  const root = realpathSync(tempDir('ara-e2e-p3m21pet-'))
  const img = join(root, 'my.png')
  writeFileSync(img, PNG)
  try {
    await openSettings(page, 'pet')
    const toggle = page.locator('.settings-page .set-row[data-item="pet.enabled"] .set-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.locator('.pet')).toHaveCount(0)
    await toggle.click()
    // 기본 캐릭터 없음 — 올리기 안내.
    await expect(page.locator('.pet [data-pet="upload"]')).toBeVisible()
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, img)
    await page.click('.settings-page [data-action="pet.upload"]')
    await expect(page.locator('.pet .pet-img')).toBeVisible()
    await page.keyboard.press('Escape')
    const pet = page.locator('.pet')
    const before = await pet.boundingBox()
    if (!before) throw new Error('펫 자리 없음')
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x - 100, before.y - 80, { steps: 5 })
    await page.mouse.up()
    const after = await pet.boundingBox()
    expect(after && after.x < before.x - 50).toBe(true)
    await pet.click({ button: 'right' })
    await page.click('.ctx-menu .ctx-item[data-action="hide"]')
    await expect(page.locator('.pet')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})
