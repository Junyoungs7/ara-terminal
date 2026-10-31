// M1 라운드 3 — 알림 센터(토스트 + 타이틀바 벨) + 공간 스위치 맥박 점(시안 SW-final).
// 실험 기능(AI 작업 공간)을 켰을 때만 보인다. 알림은 시험 훅 `window.__araTestNotify` 로 만든다
// (ARA_E2E=1 · 비패키지에서만 설치 — store/notify.ts). AI 쪽 wait 신호는 M3 에 들어온다.
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const drawer = '.settings-page.open'
const sw = '.titlebar .tb-spaces'
const bell = '.titlebar .tb-bell'
const menu = '.titlebar .ntf-menu'
const toasts = '.ntf-toasts .ntf-toast'

type NoteIn = { kind: 'wait' | 'done' | 'error' | 'info'; space: 'term' | 'ai'; title: string; body?: string; ctx?: string }
const notify = (page: Page, n: NoteIn) =>
  page.evaluate((x) => (window as unknown as { __araTestNotify(n: unknown): number }).__araTestNotify(x), n)

async function setAiSpace(page: Page, on: boolean): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="experimental"]`)
  const toggle = page.locator(`${drawer} .set-row[data-item="exp.aiSpace"] .set-toggle`)
  await toggle.click()
  if (on) await expect(toggle).toHaveClass(/\bon\b/)
  else await expect(toggle).not.toHaveClass(/\bon\b/)
  await page.keyboard.press('Escape')
}

test('NOTIFY-1 꺼진 기본 상태 — 벨·토스트가 없다', async ({ ara }) => {
  const { page } = ara
  await notify(page, { kind: 'wait', space: 'ai', title: '보이면 안 됨' })
  await expect(page.locator(bell)).toHaveCount(0)
  await expect(page.locator('.ntf-toasts')).toHaveCount(0)
})

test('NOTIFY-2★ 알림 보내기 → 토스트 → 벨 점 → 맥박 → 토스트 눌러 이동 → 드롭다운 → 모두 읽음', async ({ ara }) => {
  const { page } = ara
  await setAiSpace(page, true)
  await expect(page.locator(bell)).toBeVisible()
  await expect(page.locator(`${bell} .tb-bell-dot`)).toHaveCount(0)

  // 터미널 공간에서 AI 쪽 기다림 → 토스트 1, 벨 점, AI 작업 버튼 맥박.
  await notify(page, { kind: 'wait', space: 'ai', title: 'Claude Code 가 승인을 기다립니다', body: 'Bash 실행할까요?', ctx: 'shop-api' })
  await expect(page.locator(toasts)).toHaveCount(1)
  await expect(page.locator(`${toasts}[data-kind="wait"]`)).toContainText('승인을 기다립니다')
  await expect(page.locator(`${bell} .tb-bell-dot`)).toBeVisible()
  await expect(page.locator(`${sw} [data-space="ai"] .tb-spaces-dot`)).toBeVisible()
  await expect(page.locator(`${sw} [data-space="term"] .tb-spaces-dot`)).toHaveCount(0)

  // 터미널 쪽 오류는 지금 보는 공간이라 맥박이 없다.
  await notify(page, { kind: 'error', space: 'term', title: 'build-01 연결 끊김' })
  await expect(page.locator(`${sw} [data-space="term"] .tb-spaces-dot`)).toHaveCount(0)

  // 기다림 토스트를 누르면 그 공간으로 가고 읽음 — 토스트·맥박이 꺼진다.
  await page.click(`${toasts}[data-kind="wait"]`)
  await expect(page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.aiws-home')).toBeVisible()
  await expect(page.locator(`${toasts}[data-kind="wait"]`)).toHaveCount(0)
  await expect(page.locator(`${sw} .tb-spaces-dot`)).toHaveCount(0)

  // ✕ 로 닫으면 토스트만 걷히고 목록엔 남는다(오류는 아직 안 읽음 → 벨 점).
  await page.click(`${toasts}[data-kind="error"] .ntf-x`)
  await expect(page.locator(toasts)).toHaveCount(0)
  await expect(page.locator(`${bell} .tb-bell-dot`)).toBeVisible()

  // 다섯 개 → 보이는 셋 + "+2", 누르면 벨 드롭다운.
  for (let i = 1; i <= 5; i++) await notify(page, { kind: 'done', space: 'ai', title: `끝남 ${i}` })
  await expect(page.locator(toasts)).toHaveCount(3)
  await expect(page.locator('.ntf-toasts .ntf-more')).toContainText('+2')
  // 최신이 아래.
  await expect(page.locator(toasts).last()).toContainText('끝남 5')
  await page.click('.ntf-toasts .ntf-more')
  await expect(page.locator(menu)).toBeVisible()
  await expect(page.locator(`${menu} .ntf-item`)).toHaveCount(7)
  await expect(page.locator(`${menu} .ntf-item.unread`)).toHaveCount(6)

  // 모두 읽음 → 안 읽음 0, 벨 점 꺼짐, 버튼 비활성.
  await page.click(`${menu} .ntf-readall`)
  await expect(page.locator(`${menu} .ntf-item.unread`)).toHaveCount(0)
  await expect(page.locator(`${bell} .tb-bell-dot`)).toHaveCount(0)
  await expect(page.locator(`${menu} .ntf-readall`)).toBeDisabled()

  // 항목을 누르면 그 공간으로 가고 드롭다운이 닫힌다.
  await page.click(`${menu} .ntf-item:has-text("build-01 연결 끊김")`)
  await expect(page.locator(menu)).toHaveCount(0)
  await expect(page.locator(`${sw} [data-space="term"]`)).toHaveAttribute('aria-selected', 'true')

  // Esc 로 닫힘 · 설정 › 알림 링크.
  await page.click(bell)
  await expect(page.locator(menu)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(menu)).toHaveCount(0)
  await page.click(bell)
  await page.click(`${menu} .ntf-foot`)
  await expect(page.locator(drawer)).toBeVisible()
  await expect(page.locator(`${drawer} .set-row[data-item="notify.toast"]`)).toBeVisible()
})

test('NOTIFY-3 맥박 켜짐·꺼짐 — 그 공간으로 가면 꺼지고 돌아와도 다시 안 켜진다 · 끝남은 맥박 없음', async ({ ara }) => {
  const { page } = ara
  await setAiSpace(page, true)
  await notify(page, { kind: 'done', space: 'ai', title: '끝남' })
  await expect(page.locator(`${sw} .tb-spaces-dot`)).toHaveCount(0)
  await notify(page, { kind: 'wait', space: 'ai', title: '기다림' })
  const dot = page.locator(`${sw} [data-space="ai"] .tb-spaces-dot`)
  await expect(dot).toBeVisible()
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator(`${sw} .tb-spaces-dot`)).toHaveCount(0)
  await page.keyboard.press('Control+Alt+1')
  await expect(page.locator(`${sw} .tb-spaces-dot`)).toHaveCount(0)
  // 반대 방향 — AI 작업 공간에서 터미널 쪽 기다림.
  await page.keyboard.press('Control+Alt+2')
  await notify(page, { kind: 'wait', space: 'term', title: 'sudo 암호' })
  await expect(page.locator(`${sw} [data-space="term"] .tb-spaces-dot`)).toBeVisible()
})

test('NOTIFY-4 reduced-motion 이면 맥박은 멈춘 점 · 설정에서 토스트를 끄면 벨에만 모인다', async ({ ara }) => {
  const { page } = ara
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setAiSpace(page, true)
  await notify(page, { kind: 'wait', space: 'ai', title: '기다림' })
  const dot = page.locator(`${sw} [data-space="ai"] .tb-spaces-dot`)
  await expect(dot).toBeVisible()
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')

  // 설정 › 알림 › 앱 안 토스트 끄기 → 떠 있던 토스트도 걷히고, 새 알림은 벨 점만.
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="notify"]`)
  const toggle = page.locator(`${drawer} .set-row[data-item="notify.toast"] .set-toggle`)
  await toggle.click()
  await expect(toggle).not.toHaveClass(/\bon\b/)
  await page.keyboard.press('Escape')
  await expect(page.locator(toasts)).toHaveCount(0)
  await notify(page, { kind: 'error', space: 'term', title: '연결 끊김' })
  await expect(page.locator(toasts)).toHaveCount(0)
  await expect(page.locator(`${bell} .tb-bell-dot`)).toBeVisible()
})
