// M0 0-8 — 렌더러 복구(FD-04)·멈춤 감시(FD-02). 판정 로직은 tests/stability.test.ts 가 본다; 여기는 실앱 연결만.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, quitAra } from './fixtures'

// STAB-1 렌더러가 죽으면 main 이 다시 불러온다(창을 다시 띄우지 않고 같은 창에서 다시 그린다).
test('STAB-1 렌더러 강제 크래시 → 자동 재로드로 화면이 다시 그려진다', async ({ ara }) => {
  const bw = await ara.app.browserWindow(ara.page)
  await bw.evaluate((w) => w.webContents.forcefullyCrashRenderer())
  await expect
    .poll(
      () =>
        bw.evaluate(async (w) => {
          const wc = w.webContents
          if (wc.isDestroyed() || wc.isCrashed()) return false
          return (await wc.executeJavaScript('!!document.querySelector(".app")').catch(() => false)) as boolean
        }),
      { timeout: 30_000 }
    )
    .toBe(true)
})

// STAB-2 main 을 5초 막으면 감시 워커가 표식을 남기고, 다음 실행이 로그 폴더에 보고 파일을 쓴다.
// 감시·막기 스위치는 시험 빌드에서만 읽힌다(stability.ts — app.isPackaged 면 무시).
test('STAB-2 main 5초 막기 → 다음 실행에 logs/hang-report.ndjson', async ({ userDataDir, launch }) => {
  test.setTimeout(120_000)
  const env = {
    ARA_HANG_WATCHDOG_FORCE: '1',
    ARA_HANG_WATCHDOG_TIMEOUT_MS: '3000',
    ARA_HANG_WATCHDOG_CHECK_INTERVAL_MS: '500',
    ARA_TEST_BLOCK_MAIN_MS: '5000',
    ARA_TEST_BLOCK_MAIN_AFTER_MS: '3000'
  }
  // launchAra 는 process.env 를 그대로 넘긴다 — 이 검사 동안만 얹고 바로 걷는다(같은 워커의 다른 스펙을 물들이지 않게).
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  let a1
  try {
    a1 = await launch(userDataDir)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  // 막기(3초 뒤 5초) + 회복 맥박까지 기다린다 — 표식이 selfRecovered:true 로 고쳐 써질 때까지.
  const marker = join(userDataDir, 'main-thread-hang.json')
  await expect
    .poll(() => (existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).selfRecovered : null), { timeout: 30_000 })
    .toBe(true)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  const report = join(userDataDir, 'logs', 'hang-report.ndjson')
  await expect.poll(() => existsSync(report), { timeout: 10_000 }).toBe(true)
  const line = JSON.parse(readFileSync(report, 'utf8').trim().split(/\r?\n/)[0])
  expect(line.unresponsiveMs).toBeGreaterThan(3000)
  expect(line.selfRecovered).toBe(true)
  expect(existsSync(marker)).toBe(false)
  await quitAra(a2)
})
