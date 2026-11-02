// M0 0-8 — 렌더러 복구(FD-04)·멈춤 감시(FD-02). 판정 로직은 tests/stability.test.ts 가 본다; 여기는 실앱 연결만.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, quitAra } from './fixtures'

// 감시 워커는 표식을 writeFileSync(비우고 쓰기)로 고쳐 쓴다 — 그 사이에 읽으면 빈 파일이다. expect.poll 은 콜백이
// 던지면 다시 묻지 않고 바로 실패하므로(STAB-2 "Unexpected end of JSON input", 2026-11-02) 못 읽음 = null 로 돌려 다시 묻는다.
const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

// STAB-1 렌더러가 죽으면 main 이 다시 그린다 — 같은 창에서 다시 불러오기·첫 화면 다시 싣기, 또는 본창을 새로 만들기.
// 어느 단계로 살아났든 **지금의 본창**에 앱이 다시 그려졌는지를 본다(옛 창 참조를 쥐지 않는다 — 116b4f6 ×5 "Object has been destroyed").
test('STAB-1 렌더러 강제 크래시 → 자동 복구로 화면이 다시 그려진다', async ({ ara, userDataDir }) => {
  // 크래시·재로드 확인을 main 안에서 한 번에 한다. 페이지 핸들(bw/page)을 거쳐 poll 하면 렌더러가 죽는 순간
  // Playwright 의 CDP 세션이 "Cannot find context" 로 꼬여 앱은 살아났는데도 술어가 끝까지 false 다(2026-11-01 실측).
  const r = await ara.app.evaluate(async ({ BrowserWindow, app: eApp }) => {
    const first = BrowserWindow.getAllWindows()[0]
    const firstId = first.id
    const wc = first.webContents
    // 지금의 본창 — 복구가 창을 새로 만들면 바뀐다. 쓸 때마다 다시 찾는다(가장 최근에 만든 살아 있는 창).
    const current = (): Electron.BrowserWindow | null =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
        .sort((x, y) => y.id - x.id)[0] ?? null
    // 옛 webContents 는 창 새로 만들기 뒤 사라진다 — 거기에 묻는 것은 전부 이걸 거친다.
    const safe = <T>(f: () => T, fallback: T): T => {
      try {
        return f()
      } catch {
        return fallback
      }
    }
    const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))
    // 양성 대조: 죽었고(gone 또는 제품 로그) 다시 불러왔다(loads)는 것까지 본다 — 안 죽어도 .app 은 있으니 그것만으론 통과가 공짜다.
    // 횟수까지 센다 — 다시 불러온 뒤 또 죽거나 또 불러오면(제품 버그) 여기서 드러난다. 새로 만든 창의 첫 로드도 센다.
    const gone: string[] = []
    let loads = 0
    const onGone = (_e: unknown, d: { reason: string }): void => void gone.push(d.reason)
    const onLoad = (): void => void loads++
    const onCreated = (_e: unknown, c: Electron.WebContents): void => void c.on('did-finish-load', onLoad)
    // 크래시 전에 렌더러가 답하는지 먼저 본다 — 이미 멈춰 있었으면 그건 크래시 복구가 아니라 제품 멈춤이다(따로 실패로 드러낸다).
    const preApp = await Promise.race([
      wc.executeJavaScript('!!document.querySelector(".app")').catch(() => false),
      sleep(2_000).then(() => 'timeout' as const)
    ])
    const pid = wc.getOSProcessId()
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    wc.on('render-process-gone', onGone)
    wc.on('did-finish-load', onLoad)
    eApp.on('web-contents-created', onCreated)
    // 2026-11-02 dca03a1 재실행: forcefullyCrashRenderer 뒤 40초 동안 render-process-gone 이 없고 렌더러도 답하지 않았다
    // ({gone:'',loads:0,probeTimeouts:9,crashed:false}). 이 API 는 시험 장치일 뿐(제품은 안 쓴다) — 5초 안에 죽지 않으면
    // 그 사실(fcrAlive)을 남기고 OS 가 프로세스를 끝내게 한다(TerminateProcess).
    wc.forcefullyCrashRenderer()
    const fcrBy = Date.now() + 5_000
    while (gone.length === 0 && loads === 0 && Date.now() < fcrBy) await sleep(100)
    const fcrGone = gone.length > 0
    const fcrAlive = fcrGone ? false : alive()
    if (!fcrGone && fcrAlive) process.kill(pid)
    const reloadBy = Date.now() + 20_000
    while (loads === 0 && Date.now() < reloadBy) await sleep(250)
    // 🔴 executeJavaScript 에 상한을 건다. Electron 43 의 구현(electron.exe 안 lib/browser)은 ① 불러오는 중이면
    // did-stop-loading 까지 기다리고 ② 렌더러에 내부 IPC 를 보낸 뒤 **응답만** 기다린다(invokeInWebContents —
    // 죽음·다시 불러오기에 거절하지 않는다). 답하기 전에 렌더러가 죽거나 다시 불러오면 그 약속은 영영 안 끝나고,
    // 시험은 120초를 다 쓴 뒤 해체가 앱을 끄면서 "Execution context was destroyed" 로만 보인다(2026-11-02 전체 회귀).
    let app = false
    let probeTimeouts = 0
    const probeBy = Date.now() + 20_000
    while (!app && Date.now() < probeBy) {
      const c = current()?.webContents
      if (c && safe(() => !c.isCrashed() && !c.isLoadingMainFrame(), false)) {
        const v = await Promise.race([
          c.executeJavaScript('!!document.querySelector(".app")').catch(() => false),
          sleep(2_000).then(() => 'timeout' as const)
        ])
        if (v === 'timeout') probeTimeouts++
        else app = v === true
      }
      if (!app) await sleep(250)
    }
    eApp.removeListener('web-contents-created', onCreated)
    safe(() => {
      wc.removeListener('render-process-gone', onGone)
      wc.removeListener('did-finish-load', onLoad)
    }, undefined)
    const now = current()
    return {
      preApp,
      pid,
      fcrGone,
      fcrAlive,
      pidAliveAtEnd: alive(),
      gone: gone.join(','),
      loads,
      app,
      probeTimeouts,
      windowRecreated: !!now && now.id !== firstId,
      oldDestroyed: first.isDestroyed(),
      windows: BrowserWindow.getAllWindows().length,
      crashed: now ? safe(() => now.webContents.isCrashed(), null) : null,
      loading: now ? safe(() => now.webContents.isLoadingMainFrame(), null) : null,
      url: now ? safe(() => now.webContents.getURL(), '') : ''
    }
  })
  // 복구 경로 — 제품(stability.ts)이 main-error.log 에 남긴 줄로 센다: 'render-process-gone'(이벤트) / '…-watchdog'(감시).
  // Electron 43 은 렌더러가 죽어도 이벤트를 간헐로 안 보낸다(2026-11-02) — 그때는 감시가 복구한다. 어느 길이든 제품이 한 번 복구했는지를 본다.
  const log = (() => {
    try {
      return readFileSync(join(userDataDir, 'logs', 'main-error.log'), 'utf8')
    } catch {
      return ''
    }
  })()
  const scopes = [...log.matchAll(/^\[[^\]]+\] (render-process-gone(?:-watchdog)?)$/gm)].map((m) => m[1])
  // 다시 불러오기가 정체해서 다음 단계로 넘어간 횟수, 제품이 실제로 돌린 단계(reload → loadEntry → recreate).
  const stalls = [...log.matchAll(/^\[[^\]]+\] renderer-recovery-stalled$/gm)].length
  const steps = [...log.matchAll(/^\[[^\]]+\] renderer-recovery-step\r?\n(\w+)$/gm)].map((m) => m[1])
  const stage = steps.at(-1) ?? 'none'
  const recoveryPath = scopes.length === 1 ? (scopes[0] === 'render-process-gone' ? 'event' : 'watchdog') : `${scopes.length}:${scopes.join(',')}`
  const goneCount = r.gone.split(',').filter(Boolean).length
  // 실패하면 진단 전체(몇 번 죽고 몇 번 불렀는지, 도달 단계, 렌더러가 답을 안 한 횟수, 지금 상태)가 메시지에 실린다.
  // 복구는 정확히 한 번(이벤트 또는 감시), 로드 완료 한 번(같은 창이든 새 창이든), 지금의 본창에 앱, 크래시 전에도 답했어야 한다.
  // 이벤트로 복구했으면 gone 도 한 번(이유는 crashed·killed 어느 쪽이든). 감시로 복구했으면 gone 은 0(안 옴) 또는 1(늦게 옴).
  // 창 새로 만들기 단계면 창이 바뀌고 옛 창은 없어야 한다(창 둘이 남으면 실패). 다른 단계면 같은 창이어야 한다.
  expect(
    {
      preApp: r.preApp,
      recoveryPath,
      goneOk: recoveryPath === 'event' ? goneCount === 1 : goneCount <= 1,
      stageOk: ['reload', 'loadEntry', 'recreate'].includes(stage),
      windowOk: stage === 'recreate' ? r.windowRecreated && r.oldDestroyed && r.windows === 1 : !r.windowRecreated,
      loads: r.loads,
      app: r.app
    },
    JSON.stringify({ ...r, recoveryPath, scopes, stage, steps, stalls })
  ).toEqual({
    preApp: true,
    recoveryPath: recoveryPath === 'watchdog' ? 'watchdog' : 'event',
    goneOk: true,
    stageOk: true,
    windowOk: true,
    loads: 1,
    app: true
  })
  // 도달 단계를 보고서에 남긴다(메인이 ×N 돌릴 때 어느 길이 얼마나 나오는지 센다).
  test.info().annotations.push({ type: 'stab1-stage', description: `${recoveryPath}/${stage}` })
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
    .poll(() => readJson<{ selfRecovered?: boolean }>(marker)?.selfRecovered ?? null, { timeout: 30_000 })
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
