// [파일] 탭 — 로컬 파일 트리 (R7) : cd 양방향 연동 · 탐색 · 다중 선택 · 조작
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, newLocalShell, runCommand, dialog, dialogConfirm } from './fixtures'

const slash = (p: string) => p.replace(/\\/g, '/')

// 알려진 내용의 임시 작업 폴더(한글 이름 포함) — 홈 디렉토리는 내용이 환경마다 달라 검증할 수 없다.
function makeWorkdir(): string {
  const root = mkdtempSync(join(tmpdir(), 'ara-files-'))
  mkdirSync(join(root, '문서'))
  mkdirSync(join(root, '로그'))
  writeFileSync(join(root, 'alpha.txt'), 'alpha\n')
  writeFileSync(join(root, 'beta.txt'), 'beta\n')
  writeFileSync(join(root, '읽어보기.txt'), '한글 문서\n')
  return root
}

const row = (page: Page, name: string) => page.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)
const names = (page: Page) => page.locator('.ftree .frow .fn').allTextContents()

// 로컬 셸을 열고 작업 폴더로 이동한 뒤 [파일] 탭을 연다(터미널→트리 동기가 진입 경로다).
async function openFileTabAt(page: Page, dir: string): Promise<void> {
  const id = await newLocalShell(page)
  await runCommand(page, id, `cd "${slash(dir)}"`)
  await page.keyboard.press('Control+Shift+E')
  await expect(page.locator('.sidebar .sb-tab.active')).toHaveText(/파일/)
  await expect(row(page, '문서/')).toBeVisible({ timeout: 25_000 })
}

// FILE-1 세션이 없으면 안내, 세션이 있으면 트리가 뜬다
test('FILE-1 [파일] 탭은 세션이 있어야 트리를 보여 준다', async ({ ara }) => {
  const { page } = ara
  // 세션이 없을 때의 "안내"는 더 이상 패널 안내문이 아니라 **못 누르게 막은 탭 + 그 이유**다
  // (Sidebar.tsx: `disabled={!fileSession}` + title, "눌러도 아무 일이 없으면 무반응으로 읽힌다").
  // 그래서 Ctrl+Shift+E 를 눌러도 [연결] 에 머문다.
  const fileTab = page.locator('button.sb-tab').filter({ hasText: '파일' })
  await page.keyboard.press('Control+Shift+E')
  await expect(fileTab).toBeDisabled()
  await expect(page.locator('.sb-tab.active')).toHaveText(/연결/)
  // hover 중이면 title 이 data-tip 으로 옮겨간다(전역 툴팁) — 둘 중 하나에 이유가 있어야 한다.
  expect(await fileTab.evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '')).toBe(
    '세션에 연결하면 파일을 볼 수 있습니다'
  )
  await newLocalShell(page)
  await expect(page.locator('.sftp-wrap .ftree')).toBeVisible({ timeout: 25_000 })
})

// FILE-2 터미널 cd → 트리가 따라 이동한다(OSC7)
test('FILE-2 터미널에서 cd 하면 트리가 그 폴더로 이동한다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  // 정렬 규칙: 폴더 우선 + 이름 오름차순(ko 로케일 — 한글이 라틴 문자보다 앞선다).
  const shown = await names(ara.page)
  expect(shown).toEqual(['로그/', '문서/', '읽어보기.txt', 'alpha.txt', 'beta.txt'])
  // hover 중이면 title 이 data-tip 으로 옮겨가 있다(전역 툴팁) — 둘 중 하나에 있으면 된다.
  await expect
    .poll(() =>
      ara.page.locator('.sftp-path-bar .fcrumb').evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '')
    )
    .toMatch(/ara-files-/)
})

// FILE-3 폴더 더블클릭 = 진입 + 터미널도 함께 cd(트리→터미널)
// BLOCKER-2 회귀 감시: cd 를 LF 로 보내면 conpty/PowerShell 이 줄을 실행하지 않아 cwd 가 그대로다
//   (셸은 `>>` 연속 입력에 빠진다). 개행 문자 계약은 tests/filepath.test.ts 의 cdCommand 가 함께 지킨다.
test('FILE-3 폴더를 더블클릭하면 진입하고 터미널도 따라간다', async ({ ara }) => {
  const dir = makeWorkdir()
  writeFileSync(join(dir, '문서', '설계.md'), '# 설계\n')
  await openFileTabAt(ara.page, dir)
  await row(ara.page, '문서/').dblclick()
  await expect(row(ara.page, '설계.md')).toBeVisible()
  // 터미널도 같은 폴더로 이동했는지는 상태바 cwd 로 확인한다.
  await expect(ara.page.locator('.statusbar .sb-seg.cwd .val')).toContainText('문서', { timeout: 20_000 })
})

// FILE-4 상위 폴더 버튼 + 브레드크럼으로 되돌아간다
test('FILE-4 상위 폴더·브레드크럼으로 이동한다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await row(ara.page, '로그/').dblclick()
  await expect(ara.page.locator('.ftree .sftp-empty')).toHaveText('빈 폴더입니다')
  await ara.page.click('.sftp-path-bar .sb-act[title="상위 폴더"], .sftp-path-bar .sb-act[data-tip="상위 폴더"]')
  await expect(row(ara.page, '문서/')).toBeVisible()
  // 브레드크럼 마지막 세그먼트 = 현재 폴더. 하나 앞 세그먼트를 누르면 상위로 간다.
  const segs = ara.page.locator('.sftp-path-bar .fcrumb .seg')
  const count = await segs.count()
  expect(count).toBeGreaterThan(1)
  await segs.nth(count - 2).click()
  await expect.poll(async () => (await names(ara.page)).length, { timeout: 15_000 }).toBeGreaterThan(0)
})

// FILE-5 우클릭 → 새 폴더(이름 입력 다이얼로그)
test('FILE-5 새 폴더를 만든다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await ara.page.click('.ftree', { button: 'right', position: { x: 10, y: 4 } })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.mkdir"]')
  await expect(dialog(ara.page)).toContainText('새 폴더')
  await ara.page.fill('.dlg-input', '새폴더_한글')
  await dialogConfirm(ara.page)
  await expect(row(ara.page, '새폴더_한글/')).toBeVisible({ timeout: 15_000 })
  expect(existsSync(join(dir, '새폴더_한글'))).toBe(true)
})

// FILE-6 우클릭 → 이름 변경(인라인 편집)
test('FILE-6 파일 이름을 바꾼다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await row(ara.page, 'alpha.txt').click()
  await row(ara.page, 'alpha.txt').click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.rename"]')
  await ara.page.fill('.ftree .fedit', '이름바뀜.txt')
  await ara.page.keyboard.press('Enter')
  await expect(row(ara.page, '이름바뀜.txt')).toBeVisible({ timeout: 15_000 })
  expect(existsSync(join(dir, '이름바뀜.txt'))).toBe(true)
  expect(existsSync(join(dir, 'alpha.txt'))).toBe(false)
})

// FILE-7 Ctrl 클릭 다중 선택 → 삭제(위험 확인 다이얼로그)
test('FILE-7 여러 파일을 골라 한 번에 삭제한다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await row(ara.page, 'alpha.txt').click()
  await row(ara.page, 'beta.txt').click({ modifiers: ['Control'] })
  await expect(ara.page.locator('.ftree .frow.sel')).toHaveCount(2)
  await row(ara.page, 'beta.txt').click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="file.delete"]')
  await expect(dialog(ara.page)).toContainText('삭제 확인')
  await expect(dialog(ara.page)).toHaveClass(/danger/)
  await dialogConfirm(ara.page)
  await expect(row(ara.page, 'alpha.txt')).toHaveCount(0, { timeout: 15_000 })
  await expect(row(ara.page, 'beta.txt')).toHaveCount(0)
  expect(existsSync(join(dir, 'alpha.txt'))).toBe(false)
  expect(existsSync(join(dir, 'beta.txt'))).toBe(false)
  expect(existsSync(join(dir, '읽어보기.txt'))).toBe(true)
})

// FILE-8 Shift 범위 선택
test('FILE-8 Shift 로 범위를 선택한다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await row(ara.page, '로그/').click()
  await row(ara.page, 'beta.txt').click({ modifiers: ['Shift'] })
  // 표시 순서(로그·문서·읽어보기·alpha·beta) 기준 첫 행부터 마지막 행까지 = 5개.
  await expect(ara.page.locator('.ftree .frow.sel')).toHaveCount(5)
})

// FILE-9 새로고침 버튼이 바깥에서 생긴 변경을 반영한다
test('FILE-9 새로고침으로 외부 변경을 반영한다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  writeFileSync(join(dir, '나중에생긴.txt'), 'later\n')
  await expect(row(ara.page, '나중에생긴.txt')).toHaveCount(0)
  await ara.page.click('.sftp-path-bar .sb-act[title="새로고침"], .sftp-path-bar .sb-act[data-tip="새로고침"]')
  await expect(row(ara.page, '나중에생긴.txt')).toBeVisible({ timeout: 15_000 })
})
