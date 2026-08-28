/**
 * AUDIT-R2 ① 종료 실패 주입 — **저장이 실패해도 정리는 끝까지 간다**를 실기동으로 확인한다.
 *
 *   node tests/quit-fail-smoke.cjs        (먼저 `npm run build`, 그리고 dev 를 꺼 둔다)
 *
 * 무엇이 문제였나: `before-quit` 의 첫 줄이 `store.flush()` 였고, 그 안(util/atomicJson.ts)은
 * `writeFileSync` + `renameSync` ×2 인데 **try/catch 가 하나도 없다.** 준영님 PC 의 오피스키퍼가
 * 갓 쓴 파일을 잡으면 `EBUSY` 로 던지고(scripts/stage-release.mjs 가 같은 현상을 적어 뒀다),
 * 디스크 가득·userData 쓰기 불가도 같은 결과다. 한 번 던지면 맨 끝의 `e.preventDefault()` 에 닿지
 * 못해 앱이 그 자리에서 죽는다 — 세션 파괴·MCP 리스너 정리·RDP 릴레이·pty 배수가 **통째로**
 * 건너뛰어지고, 창은 사라지는데 conpty·ssh·claude 가 고아로 남고 39217 이 물린 채 남는다.
 * `uncaughtException` 안전망이 조용히 삼켜서 아무도 못 봤다.
 *
 * **주입 방법 — 제품 코드에 시험용 갈고리를 넣지 않는다.** userData 에 `workspace.json.tmp` 를
 * **디렉토리로** 만들어 둔다. 그러면 `writeJsonAtomic` 의 첫 줄 `writeFileSync(tmp, …)` 이 진짜로
 * 던진다(EISDIR/EPERM). 부팅 때 `cleanupTemp` 가 지우려 들지만 `unlinkSync` 로는 디렉토리를 못
 * 지우고 그 실패는 best-effort 로 삼켜지므로 주입이 살아남는다.
 *
 * 조용히 초록이 되지 않게: **주입이 실제로 터졌다는 증거**(main-error.log 의 `before-quit workspace
 * flush` 항목)를 먼저 요구한다. 그게 없으면 통과시키지 않는다.
 *
 * 대조군(주입 없음)도 한 번 돌린다 — 고친 코드가 평상시 종료를 망가뜨리지 않았는지까지 본다.
 */
require('./_harnessGuard.cjs')

const { _electron: electron } = require('playwright')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const REPO_ROOT = resolve(__dirname, '..')
// `ARA_QUITFAIL_MAIN` 으로 다른 번들을 가리킬 수 있다 — **결함을 되살린 사본**으로 이 하네스가
// 실제로 빨개지는지 확인할 때 쓴다(조용한 초록 금지. 확인 절차는 AUDIT-R2-done.md ①).
const MAIN_JS = process.env['ARA_QUITFAIL_MAIN'] || join(REPO_ROOT, 'out', 'main', 'index.js')
// shared/types.ts 의 MCP_DEFAULT_PORT. 종료가 중간에 끊기면 이 리스너가 남는다 — 그래서 이 번호가
// 곧바로 다시 잡히는지가 "정리가 끝까지 갔나"의 가장 단단한 증거다.
const MCP_PORT = 39217

const free = (port) =>
  new Promise((r) => {
    const s = createServer()
    s.once('error', () => r(false))
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)))
  })

const stagesOf = (trace) => {
  try {
    return readFileSync(trace, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.split(' ')[1])
      .filter(Boolean)
  } catch {
    return []
  }
}

async function run({ inject }) {
  const userData = mkdtempSync(join(tmpdir(), 'ara-quitfail-'))
  const trace = join(userData, 'exit-trace.log')
  // 주입: workspace.json.tmp 를 디렉토리로 — writeJsonAtomic 의 첫 줄이 던진다.
  if (inject) mkdirSync(join(userData, 'workspace.json.tmp'), { recursive: true })

  const app = await electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--disable-gpu'],
    cwd: REPO_ROOT,
    timeout: 60_000,
    // ARA_E2E: 창을 showInactive() 로 띄운다 — 하네스가 준영님이 쓰던 창에서 포커스를 뺏지 않는다.
    // ARA_AI_FAKE: 실 Anthropic SDK·실키·네트워크 없이 돈다(DLP).
    env: { ...process.env, ARA_AI_FAKE: '1', ARA_E2E: '1', ARA_EXIT_TRACE: trace }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 30_000 })
  await page.waitForSelector('.pane-grid', { timeout: 40_000 })

  // 진짜 pty 를 하나 띄운다 — 정리할 것이 없으면 배수 경로가 뜻이 없다.
  // 3초를 기다리는 이유는 shutdown-smoke.cjs 와 같다: 스폰 직후 1초 안에 죽이면 conpty 초기화 중
  // 종료라는 **다른** 레이스에 걸려 이 검사가 흔들린다.
  await page.evaluate(() =>
    window.ev.session.create({ type: 'local', title: 'quitfail', serverKey: 'localhost', profileId: null })
  )
  await page.waitForTimeout(3000)

  // fixtures.quitAra 와 같은 방식 — 응답을 기다리지 않는다(프로세스가 응답보다 먼저 내려간다).
  const closed = app.waitForEvent('close').catch(() => {})
  void app.evaluate(({ app: a }) => void setTimeout(() => a.quit(), 0)).catch(() => {})
  await Promise.race([closed, new Promise((r) => setTimeout(r, 30_000))])
  await app.close().catch(() => {})

  let log = ''
  try {
    log = readFileSync(join(userData, 'logs', 'main-error.log'), 'utf8')
  } catch {
    /* 오류가 없으면 파일도 없다 */
  }
  return {
    userData,
    stages: stagesOf(trace),
    log,
    historyWritten: existsSync(join(userData, 'history.json')),
    portFree: await free(MCP_PORT)
  }
}

// 39217 을 남이 물고 있으면(dev 서버·이미 떠 있는 앱) 그 항목만 접는다. 나머지 증거는 그대로
// 나오므로 전부 못 돌린 셈 치지 않는다 — 대신 **건너뛰었다고 크게 적는다**(조용한 초록 금지).
let portCheckable = true

const REQUIRED = ['before-quit(1st)', 'flushed', 'sessions-destroyed', 'services-stopped', 'drained', 'quit']

;(async () => {
  if (!existsSync(MAIN_JS)) {
    console.error(`QUITFAIL FAIL: ${MAIN_JS} 가 없다 — 먼저 \`npm run build\` 를 돌린다.`)
    process.exit(1)
  }
  portCheckable = await free(MCP_PORT)
  if (!portCheckable) {
    console.warn(
      `SKIP ${MCP_PORT} 재사용 검사 — 그 포트를 이미 남이 물고 있다(dev 서버이거나 앱이 떠 있다). ` +
        `그 항목만 건너뛴다. 전체를 보려면 그것을 끄고 다시 돌린다.`
    )
  }

  const fails = []
  const check = (ok, msg) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`)
    if (!ok) fails.push(msg)
  }

  console.log('① 실패 주입(workspace.json 저장이 던진다)')
  const bad = await run({ inject: true })
  console.log(`  stages: ${bad.stages.join(' → ') || '(없음)'}`)
  const flushErr = /before-quit workspace flush/.test(bad.log)
  // 이게 먼저다 — 주입이 안 터졌으면 나머지 초록은 아무 뜻이 없다.
  check(flushErr, '주입이 실제로 터졌다(main-error.log 에 `before-quit workspace flush`)')
  if (flushErr) console.log('  ' + (bad.log.split('\n\n').find((e) => e.includes('workspace flush')) || '').trim())
  for (const s of REQUIRED) check(bad.stages.includes(s), `정리가 \`${s}\` 까지 갔다`)
  check(bad.historyWritten, 'workspace 저장이 실패해도 history.json 은 저장됐다(플러시 둘이 남남)')
  if (portCheckable) check(bad.portFree, `${MCP_PORT} 가 곧바로 다시 잡힌다(MCP 리스너가 안 남았다)`)
  check(!/uncaughtException/.test(bad.log), '`uncaughtException` 으로 새지 않았다')

  console.log('② 대조군(주입 없음) — 평상시 종료가 그대로인지')
  const good = await run({ inject: false })
  console.log(`  stages: ${good.stages.join(' → ') || '(없음)'}`)
  for (const s of REQUIRED) check(good.stages.includes(s), `대조군도 \`${s}\` 까지 갔다`)
  check(!/before-quit /.test(good.log), '대조군에는 정리 실패 기록이 없다')

  for (const d of [bad.userData, good.userData]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* Windows 에서 pty 가 아직 잡고 있을 수 있다 — 임시 디렉토리라 남아도 무해하다 */
    }
  }

  if (fails.length) {
    console.error(`QUITFAIL FAIL: ${fails.length}건 — ${fails.join(' / ')}`)
    process.exit(1)
  }
  console.log('QUITFAIL PASS')
  process.exit(0)
})()
