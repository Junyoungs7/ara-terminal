// F18 명령어 북(CommandBook) — 검색형 치트시트 오버레이(interactions/CommandBook.tsx) E2E.
// 데이터는 data/commandBook.ts 를 그대로 쓴다(검색 결과 단언도 그 파일의 실제 항목 기준).
import type { Page } from '@playwright/test'
import { test, expect, newLocalShell, termText } from './fixtures'

const OPEN = '.cheatsheet.open'

async function openCommandBook(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+K')
  await expect(page.locator(OPEN)).toBeVisible()
}

// CB-1 Ctrl+Shift+K 로 열리고 목록이 채워진다
test('CB-1 Ctrl+Shift+K 로 명령어 북이 열리고 목록이 채워진다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openCommandBook(page)
  expect(await page.locator(`${OPEN} .cb-list .cb-item`).count()).toBeGreaterThan(0)
})

// CB-2 Help 메뉴의 [명령어 북] 항목(단축키가 있는 항목이라 dispatchAction 경로 — 메뉴 전용 배선이 없다)
test('CB-2 Help 메뉴의 [명령어 북] 항목을 클릭해도 열린다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.titlebar .tb-burger') // 2.0 다듬기 R1: 메뉴바는 ≡ 안에 접혀 있다
  await page.click('.titlebar .tb-menu span:text-is("도움말")')
  await page.click('.ctx-menu .ctx-item[data-action="commandBook.toggle"]')
  await expect(page.locator(OPEN)).toBeVisible()
  expect(await page.locator(`${OPEN} .cb-list .cb-item`).count()).toBeGreaterThan(0)
})

// CB-3 검색 — "압축"은 desc/cmd 에 그 문자열이 들어간 항목으로만 좁혀진다.
// 실제 데이터(commandBook.ts)에는 archive 카테고리(tar-c/tar-x/tar-t/unzip/gzip) 말고도
// file 카테고리의 rsync(desc: "변경분만 압축 전송하는 원격 복사입니다")가 섞여 있다 — zip 자체는
// desc 에 "압축"이 없어 빠진다. 실제 검색 함수(searchCommandBook) 기준으로 정확히 맞춘다.
test('CB-3 검색어로 결과가 좁혀진다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openCommandBook(page)
  await page.fill(`${OPEN} .sp-search input`, '압축')
  const cmds = (await page.locator(`${OPEN} .cb-list .cb-cmd`).allTextContents()).sort()
  expect(cmds).toEqual(['gzip', 'rsync -avz', 'tar -czf', 'tar -tzf', 'tar -xzf', 'unzip'].sort())
})

// CB-5 항목을 펼치면 예시가 보이고, 위험한 명령은 주의 문구도 함께 보인다
test('CB-5 항목을 펼치면 예시가 보이고, 되돌릴 수 없는 명령은 주의 문구도 보인다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openCommandBook(page)

  // 검색 없는 기본 목록의 첫 항목(ls) — 예시는 있지만 주의 문구는 없다.
  const first = page.locator(`${OPEN} .cb-list .cb-item`).first()
  await first.locator('.cb-row').click()
  await expect(first.locator('.cb-detail .ai-code')).toHaveCount(1)
  await expect(first.locator('.cb-detail .cb-caution')).toHaveCount(0)

  // rm -rf — 되돌릴 수 없는 명령이라 주의 문구가 있다.
  await page.fill(`${OPEN} .sp-search input`, 'rm -rf')
  const rm = page.locator(`${OPEN} .cb-list .cb-item`).filter({ has: page.locator('.cb-cmd:text-is("rm -rf")') })
  await expect(rm).toHaveCount(1)
  await rm.locator('.cb-row').click()
  await expect(rm.locator('.cb-detail .ai-code')).toHaveCount(1)
  await expect(rm.locator('.cb-detail .cb-caution')).toContainText('되돌릴 수 없습니다')
})

// CB-6 ★ [터미널로 보내기]는 삽입만 하고 실행하지 않는다(AI-5 와 같은 보안 판정 기준)
test('CB-6 ★ 예시의 [터미널로 보내기]는 삽입만 하고 실행하지 않는다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await openCommandBook(page)
  await page.fill(`${OPEN} .sp-search input`, 'rm -rf')
  const rm = page.locator(`${OPEN} .cb-list .cb-item`).filter({ has: page.locator('.cb-cmd:text-is("rm -rf")') })
  await rm.locator('.cb-row').click()
  await rm.locator('.ai-code .ai-code-btn.send').click()

  await expect.poll(() => termText(page, id)).toContain('rm -rf ./tmp/build')
  const afterInsert = await termText(page, id)

  // 개행이 갔다면 이 사이에 셸이 실행 결과(또는 오류)를 찍었을 시간이다.
  await page.waitForTimeout(1_500)
  expect(await termText(page, id)).toBe(afterInsert) // 늘지 않았다 = 실행되지 않고 프롬프트에 남았다
})

// CB-7 존재하지 않는 검색어는 결과 없음 안내만 보여 준다
test('CB-7 존재하지 않는 검색어는 결과 없음 안내를 보여 준다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openCommandBook(page)
  await page.fill(`${OPEN} .sp-search input`, 'zzz-no-such-cmd')
  await expect(page.locator(`${OPEN} .sp-empty`)).toHaveText('일치하는 명령어가 없습니다')
  await expect(page.locator(`${OPEN} .cb-list`)).toHaveCount(0)
})

// CB-9★ 배포판 계열 (2026-08-14 준영님: "리눅스도 우분투·RHEL 별로 다르잖아")
// 지키는 성질 셋: ① 계열 전용 명령은 **접힌 줄에서** 계열이 보인다(펼쳐야 안다면 잘못된 계열의
// 명령을 그대로 복사해 간다) ② 반대 계열 대안을 알려 준다 ③ 예시·힌트에만 있는 낱말로도 찾힌다.
test('CB-9★ 계열 전용 명령에 배지가 붙고 반대 계열 대안을 알려 준다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openCommandBook(page)

  // ③ 'dnf' 는 우분투 항목의 힌트에도, RHEL 항목의 명령에도 있다 — 둘 다 걸려야 한다.
  await page.fill(`${OPEN} .sp-search input`, 'dnf')
  await expect(page.locator(`${OPEN} .cb-item`).first()).toBeVisible()
  const rows = page.locator(`${OPEN} .cb-item`)
  expect(await rows.count()).toBeGreaterThan(1)

  // ① 배지가 접힌 줄에 있다. (행은 명령으로 집는다 — 'apt install' 은 다른 항목의 설치 안내
  //    힌트에도 들어 있어서 첫 행이 그 항목일 수 있다.)
  await page.fill(`${OPEN} .sp-search input`, 'apt install')
  const apt = page.locator(`${OPEN} .cb-item:has(.cb-cmd:text-is("apt install"))`)
  await expect(apt.locator('.cb-distro')).toHaveText('우분투/데비안')

  // ② 펼치면 반대 계열 대안이 힌트로 나온다.
  await apt.locator('.cb-row').click()
  await expect(apt.locator('.cb-hint')).toContainText('dnf')

  // 공통(POSIX) 명령에는 배지가 없다 — 아무 데나 붙으면 배지의 뜻이 사라진다.
  await page.fill(`${OPEN} .sp-search input`, 'tar -czf')
  await expect(page.locator(`${OPEN} .cb-item:has(.cb-cmd:text-is("tar -czf")) .cb-distro`)).toHaveCount(0)
})

// CB-8 ESC · 바깥 클릭 · ✕ 세 가지 닫는 경로 모두 확인한다
test('CB-8 ESC·바깥 클릭·✕ 세 경로 모두로 닫힌다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)

  await openCommandBook(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.cheatsheet')).toHaveCount(0)

  await openCommandBook(page)
  // 카드 바깥(오버레이 자기 자신)을 클릭 — e.target === e.currentTarget 일 때만 onClose.
  await page.locator('.cheatsheet').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.cheatsheet')).toHaveCount(0)

  await openCommandBook(page)
  await page.click(`${OPEN} .cs-hd .x`)
  await expect(page.locator('.cheatsheet')).toHaveCount(0)
})
