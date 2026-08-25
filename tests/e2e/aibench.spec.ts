// #129 사이드바 [AI] — **작업대 목록**. 껐다 켜도 남고, 점 하나로 처지를 말한다.
//
// 진짜 `claude` 를 띄우지 않는다: 목록을 main 쪽 채널(aisession:save)로 심고 화면이 그것을
// 어떻게 그리는지만 본다. 적립·판정 규칙 자체는 tests/aiWorkbench.test.ts 가 순수 함수로 본다.
import type { Ara } from './fixtures'
import { test, expect, dialog, dialogCancel, dialogConfirm, skipIntro } from './fixtures'

const seed = (ara: Ara, list: unknown): Promise<unknown> =>
  ara.page.evaluate((l) => (window as unknown as { ev: { ara: { saveSessions(x: unknown): Promise<unknown> } } }).ev.ara.saveSessions(l), list)

test('BENCH-1 빈 목록은 어디서 쌓이는지 알려 준다', async ({ ara }) => {
  await ara.page.click('.lrail-item[data-tab="ai"]')
  await expect(ara.page.locator('.bench-empty')).toContainText('Ctrl+Shift+L')
})

test('BENCH-2★ 껐다 켜도 남고, 점이 처지를 말한다', async ({ ara }) => {
  const { page } = ara
  await seed(ara, [
    { id: 'b1', kind: 'local', cwd: 'D:/없는폴더/app', engine: 'claude', skipPerms: false, title: 'app', lastUsedAt: 20 },
    { id: 'b2', kind: 'remote', profileId: '없는프로필', cwd: '/srv/erp', engine: 'claude', skipPerms: true, title: 'erp', lastUsedAt: 30 },
    { id: 'b3', kind: 'local', cwd: 'D:/없는폴더/app-perf', engine: 'claude', skipPerms: false, title: 'perf', lastUsedAt: 40, worktree: { parentId: 'b1', branch: 'ara/perf' } }
  ])
  // 파일까지 갈 필요가 없다 — workspace.load() 는 main 의 메모리 스냅샷을 준다. 새로고침이 곧
  // "껐다 켜기"의 하이드레이트 경로다(디스크 flush 는 30초 디바운스라 여기서 기다릴 이유가 없다).
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await skipIntro(page) // 새로고침이면 부팅 인사가 다시 지나간다(#139)
  await page.click('.lrail-item[data-tab="ai"]')

  const rows = page.locator('.bench-row')
  await expect(rows).toHaveCount(3)
  // ★ 분리 세션은 **부모 바로 밑**에 한 칸 들어간다 — 지울 때 무엇이 딸려 가는지 보여야 한다.
  await expect(rows.nth(0)).toHaveAttribute('data-bench', 'b2')
  await expect(rows.nth(1)).toHaveAttribute('data-bench', 'b1')
  await expect(rows.nth(2)).toHaveAttribute('data-bench', 'b3')
  await expect(rows.nth(2)).toHaveClass(/child/)
  await expect(rows.nth(2).locator('.br')).toHaveText('ara/perf')

  // 없는 폴더·없는 프로필은 **끊김**이다 — 조용히 다른 데서 열지 않는다.
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'noProfile')
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'noPath')
  await expect(rows.nth(0).locator('.bench-name')).toBeDisabled()
  // 권한 확인 건너뛰기는 **늘 보인다**(설계 §6 확정 2 — 잊게 두지 않는다).
  await expect(rows.nth(0).locator('.skip')).toBeVisible()
})

test('BENCH-3★ 부모를 지우면 딸린 분리 세션을 먼저 알린다', async ({ ara }) => {
  const { page } = ara
  await seed(ara, [
    { id: 'p', kind: 'local', cwd: 'D:/w/app', engine: 'claude', skipPerms: false, title: 'app', lastUsedAt: 1 },
    { id: 'c', kind: 'local', cwd: 'D:/w/app-x', engine: 'claude', skipPerms: false, title: 'x', lastUsedAt: 2, worktree: { parentId: 'p', branch: 'ara/x' } }
  ])
  await page.reload()
  await page.waitForSelector('.pane-grid')
  await skipIntro(page) // 새로고침이면 부팅 인사가 다시 지나간다(#139)
  await page.click('.lrail-item[data-tab="ai"]')

  await page.locator('.bench-row[data-bench="p"]').hover()
  await page.locator('.bench-row[data-bench="p"] .bench-x').click()
  await expect(dialog(page)).toContainText('분리 세션 1개')
  // 취소하면 아무것도 사라지지 않는다.
  await dialogCancel(page)
  await expect(page.locator('.bench-row')).toHaveCount(2)

  await page.locator('.bench-row[data-bench="p"] .bench-x').click()
  await dialogConfirm(page) // tone: 'danger' 라 확인 버튼이 .dgr 이다
  await expect(page.locator('.bench-row')).toHaveCount(0) // 부모와 자식이 함께
})
