// [파일] 탭 — 로컬 파일 트리 (R7) : cd 양방향 연동 · 탐색 · 다중 선택 · 조작
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  newLocalShell,
  runCommand,
  dialog,
  dialogConfirm,
  connectNewSshProfile,
  openConnTab,
  openFileTab,
  trashOf
} from './fixtures'

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
  await expect(page.locator('.lrail-item.active')).toHaveAttribute('data-tab', 'file')
  await expect(row(page, '문서/')).toBeVisible({ timeout: 25_000 })
}

// FILE-1 세션이 없으면 안내, 세션이 있으면 트리가 뜬다
test('FILE-1 [파일] 탭은 세션이 있어야 트리를 보여 준다', async ({ ara }) => {
  const { page } = ara
  // 세션이 없을 때의 "안내"는 더 이상 패널 안내문이 아니라 **못 누르게 막은 탭 + 그 이유**다
  // (Sidebar.tsx `SidebarRail`: `disabled` + title, "눌러도 아무 일이 없으면 무반응으로 읽힌다").
  // 그래서 Ctrl+Shift+E 를 눌러도 [연결] 에 머문다.
  const fileTab = page.locator('.lrail-item[data-tab="file"]')
  await page.keyboard.press('Control+Shift+E')
  await expect(fileTab).toBeDisabled()
  await expect(page.locator('.lrail-item.active')).toHaveAttribute('data-tab', 'conn')
  // hover 중이면 title 이 data-tip 으로 옮겨간다(전역 툴팁) — 둘 중 하나에 이유가 있어야 한다.
  expect(await fileTab.evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '')).toBe(
    '세션에 연결하면 파일을 볼 수 있습니다'
  )
  await newLocalShell(page)
  await expect(page.locator('.sftp-wrap .ftree')).toBeVisible({ timeout: 25_000 })
})

// TREE-1★ 사이드바 트리와 파일 목록을 키보드로 훑는다 (#82, 2026-08-15)
// 클릭되는 행이 앱 전체에 70곳 넘게 있었는데 전부 마우스 전용이었다 — 단축키를 이만큼 만든
// 앱에서 어긋난다. 행은 버튼이 아니므로(트리 행=treeitem · 목록 행=option) #71 의 <button>
// 전환과 따로 다룬다. Tab 정거장은 **컨테이너 하나**다(행마다 서면 서버 20개에 Tab 20번).
test('TREE-1★ 사이드바 트리를 Tab·화살표·Enter 로 조작한다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-tree' })
  await connectNewSshProfile(page, { name: 'tree-kbd', port: h.port, password: 'pw-tree' })
  await openConnTab(page)

  const tree = page.locator('.tree[role="tree"]')
  await expect(tree).toHaveCount(1)
  // 행은 전부 treeitem 이고 Tab 정거장이 아니다(tabindex -1).
  const rows = page.locator('.tree [role="treeitem"]')
  expect(await rows.count()).toBeGreaterThan(0)
  expect(await rows.first().getAttribute('tabindex')).toBe('-1')

  // 컨테이너에 포커스를 주면 행으로 넘어간다.
  await tree.focus()
  await expect(page.locator('.tree [role="treeitem"]:focus')).toHaveCount(1)

  // ↓ 로 내려가면 포커스가 실제로 다른 행으로 옮겨간다.
  const before = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('ArrowDown')
  const after = await page.evaluate(() => document.activeElement?.textContent ?? '')
  expect(after).not.toBe(before)

  // 그룹 헤더에서 ← 는 접고 → 는 다시 편다(aria-expanded 가 따라 바뀐다).
  const grp = page.locator('.tree .srv-hd[role="treeitem"]').first()
  await grp.focus()
  await expect(grp).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(grp).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(grp).toHaveAttribute('aria-expanded', 'true')
})

// TREE-2★ 파일 목록도 같은 규칙(트리가 아니라 listbox — 여기엔 펼침이 없다)
test('TREE-2★ 파일 목록을 화살표로 훑는다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openFileTab(page)
  const list = page.locator('.ftree[role="listbox"]')
  await expect(list).toHaveCount(1)
  await expect.poll(() => page.locator('.ftree [role="option"]').count(), { timeout: 25_000 }).toBeGreaterThan(1)

  await list.focus()
  const first = await page.evaluate(() => document.activeElement?.textContent ?? '')
  await page.keyboard.press('ArrowDown')
  const second = await page.evaluate(() => document.activeElement?.textContent ?? '')
  expect(second).not.toBe(first)
  // 목록에는 펼침이 없다 — → 를 눌러도 aria-expanded 가 생기지 않는다.
  await expect(page.locator('.ftree [role="option"][aria-expanded]')).toHaveCount(0)
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
      ara.page.locator('.fcrumb').evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip') ?? '')
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
  const segs = ara.page.locator('.fcrumb .seg')
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
  // #89: 로컬은 휴지통이다. 문구가 "되돌릴 수 없습니다"라고 하면 거짓말이 된다(원격이 그쪽이다).
  await expect(dialog(ara.page)).toContainText('휴지통으로 보냅니다')
  await expect(dialog(ara.page)).not.toContainText('되돌릴 수 없습니다')
  await dialogConfirm(ara.page)
  await expect(row(ara.page, 'alpha.txt')).toHaveCount(0, { timeout: 15_000 })
  await expect(row(ara.page, 'beta.txt')).toHaveCount(0)
  expect(existsSync(join(dir, 'alpha.txt'))).toBe(false)
  expect(existsSync(join(dir, 'beta.txt'))).toBe(false)
  expect(existsSync(join(dir, '읽어보기.txt'))).toBe(true)
  // 지워진 것이 **휴지통으로 갔다**(픽스처가 실제 휴지통 대신 userData/trash 로 돌려 놓았다 —
  // 테스트가 준영님 휴지통에 잔여물을 쌓지 않는다. 진짜 shell.trashItem 호출은 단위 테스트가 본다).
  expect(existsSync(join(trashOf(ara), 'alpha.txt'))).toBe(true)
})

// FILE-7b ★ #89 로컬 파일은 연결 프로그램으로 열 수 있다 — 텍스트가 아닌 것(이미지·PDF·xlsx)의 유일한 길
test('FILE-7b 로컬 파일 우클릭에 [연결 프로그램으로 열기]가 있다', async ({ ara }) => {
  const dir = makeWorkdir()
  await openFileTabAt(ara.page, dir)
  await row(ara.page, 'alpha.txt').click({ button: 'right' })
  // 편집기가 먼저, 그 아래 연결 프로그램 — 텍스트는 우리 편집기가 낫고(원격과 조작이 같다)
  // 나머지는 OS 에 맡긴다. 실제로 프로그램을 띄우지는 않는다(사용자 화면을 건드리지 않는다).
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.edit"]')).toBeVisible()
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.openWith"]')).toBeVisible()
  await ara.page.keyboard.press('Escape')

  // 폴더에는 안 붙는다 — 폴더는 더블클릭이 곧 진입이다.
  await row(ara.page, '로그/').click({ button: 'right' })
  await expect(ara.page.locator('.ctx-menu .ctx-item[data-action="file.openWith"]')).toHaveCount(0)
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
