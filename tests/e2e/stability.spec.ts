// M0 0-8 — 렌더러 복구(FD-04)·멈춤 감시(FD-02). 판정 로직은 tests/stability.test.ts 가 본다; 여기는 실앱 연결만.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, quitAra } from './fixtures'

// STAB-1 렌더러가 죽으면 main 이 다시 불러온다(창을 다시 띄우지 않고 같은 창에서 다시 그린다).
test('STAB-1 렌더러 강제 크래시 → 자동 재로드로 화면이 다시 그려진다', async ({ ara }) => {
  // 크래시·재로드 확인을 main 안에서 한 번에 한다. 페이지 핸들(bw/page)을 거쳐 poll 하면 렌더러가 죽는 순간
  // Playwright 의 CDP 세션이 "Cannot find context" 로 꼬여 앱은 살아났는데도 술어가 끝까지 false 다(2026-11-01 실측).
  const redrawn = await ara.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const wc = w.webContents
    // 양성 대조: 죽었고(gone) 다시 불러왔다(reloaded)는 것까지 본다 — 안 죽어도 .app 은 있으니 그것만으론 통과가 공짜다.
    let gone = ''
    wc.once('render-process-gone', (_e, d) => (gone = d.reason))
    const reloaded = new Promise<boolean>((resolve) => wc.once('did-finish-load', () => resolve(true)))
    wc.forcefullyCrashRenderer()
    const didReload = await Promise.race([reloaded, new Promise<boolean>((r) => setTimeout(() => r(false), 20_000))])
    let app = false
    for (let i = 0; i < 40 && !app; i++) {
      if (!wc.isDestroyed() && !wc.isCrashed())
        app = (await wc.executeJavaScript('!!document.querySelector(".app")').catch(() => false)) as boolean
      if (!app) await new Promise((r) => setTimeout(r, 250))
    }
    return { gone, didReload, app }
  })
  expect(redrawn).toEqual({ gone: 'crashed', didReload: true, app: true })
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

// STAB-3 FD-03 진단 프로브를 실행 중에 켜고 끈다(설정 › 정보 › [진단 프로브]와 같은 IPC). 기본 꺼짐.
test('STAB-3 진단 프로브 켜기 → 최근 값·event-loop-delay.ndjson, 끄기 → 값 지움', async ({ ara, userDataDir }) => {
  type St = { on: boolean; last: { p99: number } | null }
  const probe = (on?: boolean): Promise<St> =>
    ara.page.evaluate((v) => (window as unknown as { ev: { app: { probe(o?: boolean): Promise<St> } } }).ev.app.probe(v), on)
  expect((await probe()).on).toBe(false)
  expect((await probe(true)).on).toBe(true)
  await expect.poll(async () => (await probe()).last !== null, { timeout: 10_000 }).toBe(true)
  expect(existsSync(join(userDataDir, 'logs', 'event-loop-delay.ndjson'))).toBe(true)
  expect(await probe(false)).toEqual({ on: false, last: null })
})

// STAB-4 FD-04 렌더러 오류 경계가 보내는 기록이 main-error.log 에 `renderer <영역>` 으로 남는다.
// 경계 자체(한 영역만 대체 화면)는 STAB-5 가 본다 — 여기는 기록 경로만 본다.
test('STAB-4 오류 경계 기록 → logs/main-error.log', async ({ ara, userDataDir }) => {
  await ara.page.evaluate(() =>
    (window as unknown as { ev: { app: { logRendererError(a: string, m: string, s: string): Promise<unknown> } } }).ev.app.logRendererError(
      'sidebar',
      'STAB-4 boom',
      'Error: STAB-4 boom\n    at Sidebar'
    )
  )
  const log = join(userDataDir, 'logs', 'main-error.log')
  await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 5_000 }).toContain('renderer sidebar')
  expect(readFileSync(log, 'utf8')).toContain('STAB-4 boom')
})

// STAB-5 FD-04 사이드바 영역만 깨뜨리면 그 영역에만 대체 화면이 서고, 메인(터미널) 영역은 그대로다.
// 훅은 시험 빌드(ARA_E2E=1, 비패키지)에서만 window.__araTestCrash 로 노출된다(renderer/testCrash.ts).
test('STAB-5 사이드바 영역 강제 오류 → 그 영역만 대체 화면, 메인은 그대로', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.main')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __araTestCrash(a: string): void }).__araTestCrash('sidebar'))
  await expect(page.locator('.eb-fallback[data-area="sidebar"]')).toBeVisible()
  await expect(page.locator('.eb-fallback[data-area="main"]')).toHaveCount(0)
  await expect(page.locator('.main')).toBeVisible()
  await expect(page.locator('.app')).toBeVisible()
})
