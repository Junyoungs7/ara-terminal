// 탭 UX (R2.1~R2.3 / FB-tabs 오버플로) — 이름 변경 · 우클릭 메뉴 · 드래그 재정렬 · 번호 이동 · 오버플로 드롭다운
import { test, expect, dialogConfirm, newLocalShell, sessionList, connectNewSshProfile, type Ara } from './fixtures'
import type { Page } from '@playwright/test'

// React 는 HTML5 DnD 이벤트만 본다(마우스 이동으로는 onDrop 이 오지 않는다) —
// 같은 DataTransfer 를 공유하는 dragstart→dragover→drop 을 그대로 만들어 준다.
async function html5Drag(page: Page, fromIndex: number, toIndex: number): Promise<void> {
  await page.evaluate(([a, b]) => {
    const tabs = [...document.querySelectorAll('.term-tabbar .ttab')] as HTMLElement[]
    const src = tabs[a]
    const dst = tabs[b]
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    // 끝난 자리(화면 좌표)를 **놓은 탭 위**로 준다. 안 주면 0,0 이고, 그건 창 밖이라
    // "창 밖에 놓았다 = 새 창으로 떼어내기"(제보 4·31)로 읽힌다 — 재정렬이 아니라 창이 하나 뜬다.
    const r = dst.getBoundingClientRect()
    src.dispatchEvent(
      new DragEvent('dragend', {
        bubbles: true,
        dataTransfer: dt,
        screenX: Math.round(window.screenX + r.left + r.width / 2),
        screenY: Math.round(window.screenY + r.top + r.height / 2)
      })
    )
  }, [fromIndex, toIndex])
}

const tabLabels = (page: Page) => page.locator('.term-tabbar .ttab .tlabel').allTextContents()

async function twoShells(ara: Ara): Promise<void> {
  await newLocalShell(ara.page)
  await newLocalShell(ara.page)
}

// TAB-1 탭 더블클릭 인라인 이름 변경
test('TAB-1 탭을 더블클릭해 이름을 바꾼다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.dblclick('.term-tabbar .ttab')
  await expect(page.locator('.term-tabbar .tt-edit')).toBeVisible()
  await page.fill('.term-tabbar .tt-edit', '배포서버')
  await page.keyboard.press('Enter')
  await expect(page.locator('.term-tabbar .ttab .tlabel')).toHaveText('배포서버')
  // main 의 세션 메타에도 반영돼야 복원 후에도 이름이 남는다.
  await expect.poll(async () => (await sessionList(page))[0].title).toBe('배포서버')
})

// TAB-2 이름 변경 ESC 취소
test('TAB-2 이름 변경 중 ESC 는 원래 이름을 지킨다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  const before = (await tabLabels(page))[0]
  await page.dblclick('.term-tabbar .ttab')
  await page.fill('.term-tabbar .tt-edit', '버려질이름')
  await page.keyboard.press('Escape')
  await expect(page.locator('.term-tabbar .ttab .tlabel')).toHaveText(before)
})

// TAB-3 탭 우클릭 메뉴 — 복제
test('TAB-3 탭 우클릭 → 세션 복제로 탭이 하나 늘어난다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.click('.term-tabbar .ttab', { button: 'right' })
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await page.click('.ctx-menu .ctx-item[data-action="session.duplicate"]')
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(2)
})

// TAB-4 탭 우클릭 메뉴 — 다른 탭 모두 닫기
test('TAB-4 탭 우클릭 → 다른 탭 모두 닫기', async ({ ara }) => {
  const { page } = ara
  await twoShells(ara)
  await newLocalShell(page)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(3)
  await page.locator('.term-tabbar .ttab').nth(1).click({ button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="session.closeOthers"]')
  // 여러 개를 한 번에 닫아도 확인은 한 번만 뜬다(destroySessions).
  await dialogConfirm(page)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(1)
  await expect(page.locator('.term-tabbar .ttab.active')).toHaveCount(1)
})

// TAB-5 드래그로 탭 순서를 바꾼다(R2.3)
test('TAB-5 탭을 드래그해 순서를 바꾼다', async ({ ara }) => {
  const { page } = ara
  await twoShells(ara)
  const before = await tabLabels(page)
  expect(before).toHaveLength(2)
  await html5Drag(page, 0, 1)
  await expect.poll(async () => (await tabLabels(page)).join('|')).toBe([before[1], before[0]].join('|'))
})

// TAB-6 Ctrl+1..9 번호로 탭 이동
test('TAB-6 Ctrl+숫자로 탭을 옮긴다', async ({ ara }) => {
  const { page } = ara
  await twoShells(ara)
  const labels = await tabLabels(page)
  await page.keyboard.press('Control+1')
  await expect(page.locator('.term-tabbar .ttab.active .tlabel')).toHaveText(labels[0])
  await page.keyboard.press('Control+2')
  await expect(page.locator('.term-tabbar .ttab.active .tlabel')).toHaveText(labels[1])
})

// TAB-7 Ctrl+Tab / Ctrl+Shift+Tab 순환
test('TAB-7 Ctrl+Tab 으로 탭을 순환한다', async ({ ara }) => {
  const { page } = ara
  await twoShells(ara)
  const labels = await tabLabels(page)
  await page.keyboard.press('Control+1')
  await page.keyboard.press('Control+Tab')
  await expect(page.locator('.term-tabbar .ttab.active .tlabel')).toHaveText(labels[1])
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.locator('.term-tabbar .ttab.active .tlabel')).toHaveText(labels[0])
})

// TAB-8 FB-tabs: 그룹 래퍼 제거 — 같은 서버의 SSH 세션도 평평한 개별 탭, 구분은 dot 색만.
test('TAB-8 같은 서버의 SSH 세션이 그룹 래퍼 없이 dot 색으로만 구분된다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'grp-pw' })
  await connectNewSshProfile(page, { name: 'tab-remote', port: h.port, password: 'grp-pw' })
  await expect(page.locator('.term-tabbar .tg')).toHaveCount(0) // 그룹 래퍼(.tg)는 더 이상 없다
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(1)
  // 같은 서버로 한 번 더 접속 → 여전히 그룹 없이 평평한 개별 탭 2개.
  await page.click('.term-tabbar .ttab', { button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="session.duplicate"]')
  await expect(page.locator('.term-tabbar .tg')).toHaveCount(0)
  await expect(page.locator('.term-tabbar .ttab')).toHaveCount(2)
  // 최소 구분 단서(FB-tabs): 같은 서버 두 탭의 dot 색이 서로 같다 — 완전히 구분 불가는 아니다.
  const colors = await page
    .locator('.term-tabbar .ttab .tdot')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.background))
  expect(colors).toHaveLength(2)
  expect(colors[0]).toBeTruthy()
  expect(colors[0]).toBe(colors[1])
})

// TAB-9 FB-tabs: 탭이 넘치면 우측 오버플로 드롭다운이 뜨고, 고르면 그 탭으로 전환된다.
test('TAB-9 탭이 넘치면 오버플로 드롭다운으로 선택할 수 있다', async ({ ara }) => {
  const { page } = ara
  await page.setViewportSize({ width: 640, height: 720 }) // 좁은 창 → 몇 개만 켜도 넘치게.
  for (let i = 0; i < 10; i++) await newLocalShell(page)
  await expect(page.locator('.tt-overflow-btn')).toBeVisible()
  const labels = await tabLabels(page)
  await page.click('.tt-overflow-btn')
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await expect(page.locator('.ctx-menu .ctx-item')).toHaveCount(labels.length)
  // 부분일치(hasText 문자열)는 "셸 1" 이 "셸 10"의 접두라 잘못 걸린다 — 앵커 정규식으로 정확히
  // 일치하는 항목만 고른다(:text-is() 는 이 한글+숫자 조합에서 매칭에 실패하는 것을 확인해 피함).
  await page
    .locator('.ctx-menu .ctx-item')
    .filter({ hasText: new RegExp(`^${labels[0]}$`) })
    .click()
  await expect(page.locator('.term-tabbar .ttab.active .tlabel')).toHaveText(labels[0])
})
