// W2 F12 세션 로그 — 설정 [로그]에서 켜야만 터미널 출력이 파일로 남는다(기본 꺼짐).
// 파일은 임시 userData 아래에만 생긴다(DLP) — 원격은 ssh2 루프백 하네스의 에코다.
import {
  test,
  expect,
  connectNewSshProfile,
  expectTermText,
  persist,
  quitAra,
  sendInput,
  spyCalls,
  spyShell
} from './fixtures'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const drawer = '.drawer.open'

const logDir = (userData: string): string => join(userData, 'logs')

function logFiles(userData: string): string[] {
  try {
    return readdirSync(logDir(userData)).filter((f) => f.endsWith('.log'))
  } catch {
    return [] // 아직 디렉토리 자체가 없다 = 기록 없음
  }
}

function logText(userData: string): string {
  return logFiles(userData)
    .map((f) => readFileSync(join(logDir(userData), f), 'utf8'))
    .join('\n')
}

// 설정 [로그] 섹션에서 기록을 켠다(사용자가 실제로 하는 경로 — 설정을 거치지 않고 켤 방법은 없다).
async function enableLog(page: Page): Promise<void> {
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="log"]`)
  const toggle = page.locator(`${drawer} .set-row:has(.sr-label:text-is("세션 로그 기록")) .set-toggle`)
  await expect(toggle).not.toHaveClass(/\bon\b/) // 기본 꺼짐
  await toggle.click()
  await expect(toggle).toHaveClass(/\bon\b/)
  await page.keyboard.press('Escape')
  await expect(page.locator(drawer)).toHaveCount(0)
}

// SLOG-1 켜지 않으면 파일 자체가 생기지 않는다(사내 DLP — 묻지 않고 디스크에 남기지 않는다)
test('SLOG-1 기본 상태에서는 세션 로그 파일이 만들어지지 않는다', async ({ ara, ssh }) => {
  const { page, userData } = ara
  const h = await ssh({ password: 'pw-slog1' })
  const sid = await connectNewSshProfile(page, { name: 'slog1', port: h.port, password: 'pw-slog1' })
  await sendInput(page, sid, 'echo 기록되면안됨\r\n')
  await expectTermText(page, sid, /기록되면안됨/)
  await page.waitForTimeout(500)
  expect(logFiles(userData)).toEqual([])
})

// SLOG-2 켜면 그 순간부터 기록되고 한글이 그대로 남는다
test('SLOG-2 로그를 켜면 세션 출력이 한글 그대로 파일에 남는다', async ({ ara, ssh }) => {
  const { page, userData } = ara
  const h = await ssh({ password: 'pw-slog2' })
  const sid = await connectNewSshProfile(page, { name: 'slog2', port: h.port, password: 'pw-slog2' })
  await enableLog(page)

  await sendInput(page, sid, 'echo 배포가 완료되었습니다\r\n')
  await expectTermText(page, sid, /배포가 완료되었습니다/)
  await expect.poll(() => logText(userData), { timeout: 15_000 }).toContain('배포가 완료되었습니다')
  expect(logFiles(userData)).toHaveLength(1)
  // ANSI 제어문자는 제거된 평문이다.
  expect(logText(userData)).not.toMatch(/\x1b\[/)
})

// SLOG-3 비밀은 **기록 전에** 가려진다(파일에 원문이 잠깐도 닿지 않는다)
test('SLOG-3 토큰·비밀번호는 파일에 ****로 남는다', async ({ ara, ssh }) => {
  const { page, userData } = ara
  const h = await ssh({ password: 'pw-slog3' })
  const sid = await connectNewSshProfile(page, { name: 'slog3', port: h.port, password: 'pw-slog3' })
  await enableLog(page)

  await sendInput(page, sid, 'export TOKEN=abc123XYZ\r\n')
  await sendInput(page, sid, 'mysql -uroot -pS3cr3tPw 배포DB\r\n')
  await expectTermText(page, sid, /배포DB/)
  await expect.poll(() => logText(userData), { timeout: 15_000 }).toContain('****')

  const text = logText(userData)
  expect(text).not.toContain('abc123XYZ')
  expect(text).not.toContain('S3cr3tPw')
  // 명령 자체는 남는다 — 가리는 것은 값뿐이다(로그가 쓸모없어지면 안 된다).
  expect(text).toContain('배포DB')
})

// SLOG-4 [폴더 열기] — 렌더러는 경로를 말하지 않는다(인자 없는 IPC). main 이 자기 로그 폴더를 연다.
test('SLOG-4 [폴더 열기]가 로그 폴더를 연다', async ({ ara }) => {
  const { page, app, userData } = ara
  // 실제 탐색기가 뜨면 검증 세션이 오염된다 — 호출만 관측한다.
  await spyShell(app)

  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .set-nav [data-section="log"]`)
  await page.click(`${drawer} [data-action="log.reveal"]`)

  await expect.poll(async () => (await spyCalls(app)).paths, { timeout: 10_000 }).toEqual([logDir(userData)])
})

// SLOG-5 보존 기간 4종 · 고른 값이 재기동 후에도 유지된다
test('SLOG-5 보존 기간을 고르면 재기동 후에도 유지된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await a1.page.keyboard.press('Control+,')
  await a1.page.click(`${drawer} .set-nav [data-section="log"]`)
  const seg = `${drawer} .set-row:has(.sr-label:text-is("보존 기간")) .seg-ctl`
  expect(await a1.page.locator(`${seg} button`).allTextContents()).toEqual(['7일', '30일', '90일', '무제한'])
  await a1.page.click(`${seg} button[data-value="90"]`)
  await expect(a1.page.locator(`${seg} button[data-value="90"]`)).toHaveClass(/on/)
  await a1.page.keyboard.press('Escape')
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await a2.page.keyboard.press('Control+,')
  await a2.page.click(`${drawer} .set-nav [data-section="log"]`)
  await expect(a2.page.locator(`${seg} button[data-value="90"]`)).toHaveClass(/on/)
  // 기록 토글은 재기동해도 기본 꺼짐 그대로다(보존 기간만 바꿨다).
  await expect(
    a2.page.locator(`${drawer} .set-row:has(.sr-label:text-is("세션 로그 기록")) .set-toggle`)
  ).not.toHaveClass(/\bon\b/)
})

// ── #86(2026-08-16) 지난 세션 — 우측 레일 ─────────────────────────────────────
// 2.0(2단계): 우측 레일이 없어져 [지난 세션]은 **좌측 사이드바 탭**('past')이다. 패널 클래스는 그대로.
// 준영님: "현재 세션의 기록은 하단에서, 이전 세션 기록은 우측에서 찾을 수 있게."
// 새 저장소는 없다 — 로그 파일 이름(`날짜-시각_서버_id8.log`)이 곧 색인이다.

// SLOG-6★ 세션을 닫아도 그 기록은 [지난 세션] 목록에 남고, 눌러 내용을 다시 본다.
test('SLOG-6★ 닫힌 세션의 기록을 [지난 세션]에서 다시 본다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-slog6' })
  const sid = await connectNewSshProfile(page, { name: 'slog6', port: h.port, password: 'pw-slog6' })
  await enableLog(page)
  await sendInput(page, sid, 'echo 지난기록표식\r\n')
  await expectTermText(page, sid, /지난기록표식/)

  // 세션을 닫는다 — 그래도 파일은 남는다(이 기능의 존재 이유다).
  await page.evaluate((id) => window.ev.session.destroy(id), sid)

  await page.click('.lrail-item[data-activity="pastlog"]')
  const rail = page.locator('.monitor-panel.pastlog')
  await expect(rail).toBeVisible({ timeout: 10_000 })
  const row = rail.locator('.pl-row').first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  // 파일 이름에서 되읽은 서버 이름이 그대로 보인다.
  await expect(row.locator('.pl-srv')).toHaveText('slog6')
  // 닫힌 세션이므로 [진행 중] 이 아니다.
  await expect(row).not.toHaveClass(/live/)

  // 2026-10-29: 내용은 **독립 창**에 뜬다(사이드바엔 목록만 — 고른 행은 .picked).
  const opened = ara.app.waitForEvent('window')
  await row.click()
  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.app.pastlogwin .log-text')).toContainText('지난기록표식', { timeout: 15_000 })
  await expect(row).toHaveClass(/picked/)
  await expect(rail.locator('.pl-row')).toHaveCount(1)
})

// SLOG-7★ 진행 중인 기록은 목록에서 갈라 보이고, 누르면 **하단 [세션 기록]** 으로 보낸다.
// 같은 것을 두 곳에서 다르게 보여 주지 않는다 — 지금 세션은 하단이 집이다(§4.8).
test('SLOG-7★ 진행 중인 기록을 누르면 하단 [세션 기록] 으로 간다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-slog7' })
  const sid = await connectNewSshProfile(page, { name: 'slog7', port: h.port, password: 'pw-slog7' })
  await enableLog(page)
  await sendInput(page, sid, 'echo 진행중표식\r\n')
  await expectTermText(page, sid, /진행중표식/)

  await page.click('.lrail-item[data-activity="pastlog"]')
  const rail = page.locator('.monitor-panel.pastlog')
  const row = rail.locator('.pl-row.live').first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.pl-live')).toHaveText('진행 중')

  await row.click()
  // 하단 [세션 기록] 이 열린다. 2.0: [지난 세션]은 좌측 사이드바 안이라 닫히지 않는다
  // (1.x 우측 레일은 closeRail 로 닫았다 — Shell.tsx onPastOpenCurrent 는 이제 openBottom 만 한다).
  await expect(page.locator('.bottom-panel .bp-tab.on[data-bottom="log"]')).toBeVisible({ timeout: 10_000 })
})

// SLOG-8 기록이 꺼져 있으면 "없다"가 아니라 **켜는 법**을 말한다(#68 과 같은 규칙).
test('SLOG-8 기록이 없으면 설정을 켜라고 안내한다', async ({ ara }) => {
  const { page } = ara
  await page.click('.lrail-item[data-activity="pastlog"]')
  const rail = page.locator('.monitor-panel.pastlog')
  await expect(rail).toBeVisible({ timeout: 10_000 })
  await expect(rail.locator('.sftp-empty')).toContainText('설정')
})
