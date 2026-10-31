// M0 0-1·0-2 — 성능 기준선 측정 + 성능 게이트 (계획서 docs/orca-port-plan.md 5-1절).
//
// 빌드된 앱(out/)을 Playwright `_electron` 으로 띄워 4지표를 잰다. 목표 수치는 없다 —
// "기준선보다 느려지지 않게"가 기준이다(결정 :48).
//
// 돌리는 법 (dev 를 끄고, 다른 앱 최소로)
//   npm run perf                 빌드 → 5회 측정 → docs/perf-baseline.json 기록
//   npm run perf -- --quick      1회만(배선 확인용 — 기준선으로 쓰지 말 것)
//   npm run perf:gate            빌드 → 5회 측정 → 기준선과 비교, 넘으면 exit 1
//   옵션: --runs=N  --out=<경로>  --quick  --gate  --baseline=<경로>  --retries=N(게이트 재측정, 기본 1)
//
// 4지표 (한 판 = 앱 두 번 띄움)
//   ① startupMs   켜는 시간. main 프로세스 생성 시각(process.getCreationTime) → 본창 렌더러의
//                 first-contentful-paint(performance.timeOrigin + startTime). 렌더러가 보내는 별도
//                 준비 신호는 **없어서**(2026-10-31 확인) 브라우저의 FCP 를 썼다. index.html 의 body 가
//                 비어 있어 FCP = React 가 첫 화면을 그린 순간이다. FCP 가 5초 안에 안 잡히면
//                 `.app` 이 보인 시각(하네스 벽시계)으로 떨어지고 startupSource 에 그렇게 적는다.
//                 Playwright 의 연결 지연이 안 섞이게 두 시각 모두 앱 안의 시계에서 읽는다.
//   ② idleMemMB   빈 작업 공간으로 켜고 인사·이름 묻기를 넘긴 뒤 60초 → app.getAppMetrics() 전
//                 프로세스 workingSetSize 합(MB). 셸(conpty·pwsh)은 Electron 프로세스가 아니라 안 들어간다.
//   ③ idleCpuPct  ② 바로 다음 30초, 1초마다 getAppMetrics() 의 percentCPUUsage 합 → 평균.
//                 Chromium 기준이라 **한 코어 = 100%** 다(여러 코어면 100 을 넘을 수 있다).
//   ④ workspaceMs 고정 픽스처(로컬 셸 탭 4개, 2×2 분할, cwd=임시 폴더)를 workspace.json 으로 넣고 켠다 →
//                 main 생성 시각부터 탭 4개가 서고 4개 셸 모두 첫 출력(프롬프트)을 그릴 때까지.
//                 SSH·운영 서버 접속 없음. 픽스처는 매 실행 첫머리의 예열 판이 남긴 기본 스냅샷에
//                 sessions·layout 만 갈아 끼워 만든다(스키마를 손으로 베끼지 않는다).
//   매 실행 첫 판은 예열이다(측정에서 뺀다) — 디스크 캐시가 찬 상태끼리 비교한다.
//
// 허용폭 규칙 (5-1절 표의 빈칸을 이것으로 채운다)
//   흩어짐 = MAD(중앙값 절대편차). 3×MAD ≈ 정규분포 2σ.
//   비율 지표(startupMs·idleMemMB·workspaceMs): 허용폭 = max(바닥, 3×MAD/중앙값)
//       게이트 상한 = 기준선 중앙값 × (1 + 허용폭)
//       바닥: startupMs 10% · idleMemMB 5% · workspaceMs 10%
//   idleCpuPct: 0 근처라 비율이 무의미하다 → %p 로 본다. 허용폭 = max(1.0%p, 3×MAD)
//       게이트 상한 = 기준선 중앙값 + 허용폭
//   허용폭은 **기준선을 잴 때** 계산해 JSON 에 박는다 — 게이트 판의 흩어짐으로 상한을 늘리지 않는다.
//   첫 두 마일스톤(M0·M1) 동안은 실패하면 1회 재측정한다(--retries=1 기본). M2 부터 --retries=0.
//
// 🔴 이 게이트가 **못 잡는 것** (통과 ≠ 안 느려졌다)
//   · 다른 PC — 기준선과 CPU·RAM·OS 가 다르면 비교를 거부한다(exit 2). 다른 PC 의 숫자와 비교하지 않는다.
//   · 사용 중 부하 — 측정 중 다른 앱이 CPU·디스크를 쓰면 숫자가 흔들린다. dev(electron-vite dev)를 끄고 돌린다.
//   · 긴 세션 누수 — 재는 것은 켠 뒤 90초뿐이다. 몇 시간 쓰다 쌓이는 메모리·리스너 누수는 안 보인다.
//   · 첫 설치 콜드 캐시 — 예열 판을 버리므로 설치 직후·재부팅 직후 첫 실행의 느림은 안 보인다.
//   · GPU·화면 — 창이 보이는 상태(showInactive)로 재므로 원격 데스크톱·다른 모니터 배율이면 달라진다.
//   · 패키지본 — out/ 을 electron 으로 띄운다. asar·서명·자동 업데이트 경로의 비용은 안 들어간다.
//   · 셸 자체 — 셸 프로세스(pwsh 등)의 메모리·CPU 와 셸 시작 속도 변화는 ①②③ 에 안 실린다(④ 에만 실린다).
//   · 작업 중 지표 — 타이핑 지연·스크롤·AI 스트리밍은 재지 않는다(tests/perf-probe.cjs 의 몫).
//   · 30초 디바운스 저장·주기 폴링이 측정 창과 겹치는 우연 — 5회 중앙값으로만 흡수한다.
//
// 사용자 PC 침범 금지
//   · 매 기동 새 임시 --user-data-dir(끝나면 삭제) — 실사용 workspace.json·vault 를 안 건드린다.
//   · ARA_E2E=1 (e2e 하네스와 같은 방식, tests/e2e/fixtures.ts): 창을 showInactive 로 띄워 포커스를
//     안 뺏고, MCP 를 고정 포트 39217 대신 0(OS 배정)으로 열고, 훅 홈을 userData 안으로 돌린다.
//     창을 화면 밖으로 옮기지는 않는다 — 가려진 창은 Chromium 이 렌더를 늦춰 ②③ 이 실제보다 낮게 나온다
//     (src/main/index.ts 의 ready-to-show 주석과 같은 이유).
//   · ARA_AI_FAKE=1 — 실키·네트워크로 AI 를 부르지 않는다.
//   · 키 입력(인사 넘기기 Escape·[건너뛰기] 클릭)은 CDP 로 페이지에만 보낸다 — OS 포커스·클립보드 무관.
//
// 양성 대조 (게이트가 정말 잡는지)
//   ARA_PERF_INJECT_DELAY_MS=3000 npm run perf:gate   → startupMs·workspaceMs 가 넘어 exit 1 이어야 한다.
//   지연은 src/main/index.ts 모듈 머리에서 main 스레드를 막는다. `app.isPackaged` 면 읽지 않는다 —
//   배포 설치본에서는 환경변수가 있어도 무동작이다. 기준선 기록(게이트 아닌 모드)은 이 변수가 있으면 거부한다.
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const { dirname, join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const MAIN_JS = join(ROOT, 'out', 'main', 'index.js')
const DEFAULT_BASELINE = join(ROOT, 'docs', 'perf-baseline.json')
const TABS = 4
const IDLE_MS = 60_000
const CPU_MS = 30_000
const CPU_STEP_MS = 1_000

// ── 순수 함수(tests/perfBaseline.test.ts) ─────────────────────────────────

const METRICS = ['startupMs', 'idleMemMB', 'idleCpuPct', 'workspaceMs']
/** 비율 지표의 바닥은 비율, idleCpuPct 의 바닥은 %p. */
const FLOOR = { startupMs: 0.1, idleMemMB: 0.05, idleCpuPct: 1.0, workspaceMs: 0.1 }
const ABSOLUTE = new Set(['idleCpuPct'])

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function mad(xs) {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d

/** 표본 → 요약 + 허용폭(위 규칙). */
function summarize(metric, samples) {
  const med = median(samples)
  const spread = mad(samples)
  const tolerance = ABSOLUTE.has(metric)
    ? Math.max(FLOOR[metric], 3 * spread)
    : Math.max(FLOOR[metric], med > 0 ? (3 * spread) / med : 0)
  return {
    median: round(med),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    mad: round(spread, 2),
    tolerance: round(tolerance, 3),
    samples: samples.map((x) => round(x))
  }
}

function limitOf(metric, base) {
  return ABSOLUTE.has(metric) ? base.median + base.tolerance : base.median * (1 + base.tolerance)
}

/** 기준선 metrics × 이번 중앙값 → 지표별 판정. */
function judge(baseMetrics, nowMedians) {
  return METRICS.map((metric) => {
    const base = baseMetrics[metric]
    const limit = round(limitOf(metric, base))
    const now = nowMedians[metric]
    return { metric, base: base.median, tolerance: base.tolerance, limit, now, ok: now <= limit }
  })
}

/** 비교해도 되는 같은 PC 인가. 시계 속도·OS 빌드 번호 같은 사소한 것은 안 본다. */
function sameMachine(a, b) {
  return a.cpu === b.cpu && a.cores === b.cores && a.ramGB === b.ramGB && a.platform === b.platform
}

// ── 측정 ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function machineInfo() {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  return {
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.cpus().length,
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    platform: os.platform(),
    osRelease: os.release(),
    gitCommit: git(['rev-parse', '--short', 'HEAD']),
    gitDirty: (git(['status', '--porcelain']) ?? '') !== ''
  }
}

async function launch(userData) {
  const { _electron } = require('@playwright/test')
  const tLaunch = Date.now()
  const app = await _electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`],
    cwd: ROOT,
    timeout: 60_000,
    env: { ...process.env, ARA_AI_FAKE: '1', ARA_E2E: '1' }
  })
  const page = await app.firstWindow()
  // 25분 측정 동안 사용자 화면을 가리지 않게 화면 밖으로(showInactive 라 포커스는 원래 안 뺏는다).
  // 한계: 가려진 창은 Chromium 이 렌더를 줄일 수 있어 유휴 CPU 가 실사용보다 낮게 나올 수 있다 — 기준선과 게이트가 같은 조건이라 비교는 유효.
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setPosition(-32000, -32000)))
    .catch(() => {})
  const created = await app.evaluate(() => process.getCreationTime()).catch(() => null)
  return { app, page, created, t0: created ?? tLaunch }
}

/** tests/e2e/fixtures.ts 의 skipIntro 와 같은 순서(인사가 위라 먼저 걷는다). */
async function skipIntro(page) {
  if (await page.locator('.boot').count()) {
    await page.keyboard.press('Escape')
    await page.locator('.boot').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  }
  const skip = page.locator('[data-action="welcome.skip"]')
  if (await skip.count()) await skip.click()
}

/** 정상 종료(before-quit → workspace.json flush) → 안 내려가면 트리째 내린다 → userData 삭제. */
async function quit(app, userData) {
  const closed = app.waitForEvent('close').catch(() => {})
  void app.evaluate(({ app: a }) => void setTimeout(() => a.quit(), 0)).catch(() => {})
  await Promise.race([closed, sleep(20_000)])
  await app.close().catch(() => {})
  const pid = app.process().pid
  if (pid && isAlive(pid)) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
    } catch {
      /* 이미 내려갔다 */
    }
  }
  if (userData) rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const tempUserData = () => mkdtempSync(join(os.tmpdir(), 'ara-perf-'))

/** 예열 판: 한 번 켜고 정상 종료해 기본 스냅샷을 얻는다 → 픽스처(로컬 탭 4개, 2×2). */
async function warmupAndFixture() {
  const ud = tempUserData()
  const { app, page } = await launch(ud)
  let electron = null
  try {
    await page.waitForSelector('.pane-grid', { timeout: 40_000 })
    electron = await app.evaluate(() => process.versions.electron)
    await skipIntro(page)
  } finally {
    await quit(app, null)
  }
  const wsPath = join(ud, 'workspace.json')
  if (!existsSync(wsPath)) throw new Error(`예열 판이 workspace.json 을 남기지 않았다: ${wsPath}`)
  const base = JSON.parse(readFileSync(wsPath, 'utf8'))
  rmSync(ud, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  const cwd = os.tmpdir()
  const sessions = Array.from({ length: TABS }, (_, i) => ({
    id: `perf-${i + 1}`,
    type: 'local',
    title: `perf ${i + 1}`,
    serverKey: 'localhost',
    cwd
  }))
  const pane = (i) => ({ type: 'pane', sessionId: sessions[i].id })
  const row = (a, b) => ({ type: 'split', direction: 'row', ratio: [0.5, 0.5], children: [pane(a), pane(b)] })
  const layout = { type: 'split', direction: 'col', ratio: [0.5, 0.5], children: [row(0, 1), row(2, 3)] }
  return { electron, fixture: { ...base, sessions, layout, tabGroups: [] } }
}

/** ①②③: 빈 작업 공간. */
async function measureIdle() {
  const ud = tempUserData()
  const { app, page, created, t0 } = await launch(ud)
  try {
    await page.waitForSelector('.app', { timeout: 30_000 })
    const appSeen = Date.now()
    const fcp = await page
      .waitForFunction(
        () => {
          const e = performance.getEntriesByName('first-contentful-paint')[0]
          return e ? performance.timeOrigin + e.startTime : null
        },
        null,
        { timeout: 5_000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null)
    const startupMs = (fcp ?? appSeen) - t0
    const startupSource = `${created ? 'getCreationTime' : 'harness-launch'}→${fcp ? 'FCP' : '.app'}`
    await page.waitForSelector('.pane-grid', { timeout: 40_000 })
    await skipIntro(page)

    await sleep(Math.max(0, appSeen + IDLE_MS - Date.now()))
    const metrics = () => app.evaluate(({ app: a }) => a.getAppMetrics())
    const mem = await metrics()
    const idleMemMB = mem.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024
    // percentCPUUsage 는 "지난 호출 이후"다 — 위 호출이 기준점이 된다.
    const cpu = []
    for (let t = 0; t < CPU_MS; t += CPU_STEP_MS) {
      await sleep(CPU_STEP_MS)
      cpu.push((await metrics()).reduce((s, m) => s + m.cpu.percentCPUUsage, 0))
    }
    const idleCpuPct = cpu.reduce((a, b) => a + b, 0) / cpu.length
    return { startupMs, startupSource, idleMemMB, idleCpuPct, processes: mem.length }
  } finally {
    await quit(app, ud)
  }
}

/** ④: 픽스처 복원. */
async function measureWorkspace(fixture) {
  const ud = tempUserData()
  writeFileSync(join(ud, 'workspace.json'), JSON.stringify(fixture, null, 2))
  const { app, page, t0 } = await launch(ud)
  try {
    await page.waitForSelector('.app', { timeout: 30_000 })
    const deadline = Date.now() + 60_000
    for (;;) {
      const st = await page
        .evaluate(async () => {
          const ids = (await window.ev.session.list()).map((s) => s.id)
          const drawn = ids.filter((id) => (window.__evTerm(id)?.text() ?? '').trim().length > 0).length
          return { tabs: document.querySelectorAll('.term-tabbar .ttab').length, drawn }
        })
        .catch(() => ({ tabs: 0, drawn: 0 }))
      if (st.tabs >= TABS && st.drawn >= TABS) return { workspaceMs: Date.now() - t0 }
      if (Date.now() > deadline) throw new Error(`작업 공간 복원 60초 초과: 탭 ${st.tabs}/${TABS}, 출력 ${st.drawn}/${TABS}`)
      await sleep(50)
    }
  } finally {
    await quit(app, ud)
  }
}

async function measure(runs) {
  const { electron, fixture } = await warmupAndFixture()
  const rows = []
  for (let i = 0; i < runs; i++) {
    const idle = await measureIdle()
    const ws = await measureWorkspace(fixture)
    const row = { ...idle, ...ws }
    rows.push(row)
    console.log(
      `  판 ${i + 1}/${runs}: 켜기 ${round(row.startupMs)}ms(${row.startupSource}) · 메모리 ${round(row.idleMemMB)}MB` +
        ` · CPU ${round(row.idleCpuPct, 2)}% · 작업공간 ${round(row.workspaceMs)}ms`
    )
  }
  const metrics = Object.fromEntries(METRICS.map((m) => [m, summarize(m, rows.map((r) => r[m]))]))
  return { electron, metrics, startupSources: [...new Set(rows.map((r) => r.startupSource))] }
}

function parseArgs(argv) {
  const opt = { runs: 5, out: null, gate: false, baseline: DEFAULT_BASELINE, retries: 1 }
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=')
    if (k === 'quick') opt.runs = 1
    else if (k === 'gate') opt.gate = true
    else if (k === 'runs') opt.runs = Number(v)
    else if (k === 'out') opt.out = resolve(v)
    else if (k === 'baseline') opt.baseline = resolve(v)
    else if (k === 'retries') opt.retries = Number(v)
    else throw new Error(`모르는 인자: ${a}`)
  }
  if (!(opt.runs >= 1)) throw new Error('--runs 는 1 이상')
  return opt
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (!existsSync(MAIN_JS)) throw new Error(`빌드가 없다: ${MAIN_JS} — npm run build 먼저`)
  const machine = machineInfo()
  const injected = Number(process.env['ARA_PERF_INJECT_DELAY_MS']) || 0
  const header = { createdAt: new Date().toISOString(), runs: opt.runs, tabs: TABS, idleMs: IDLE_MS, cpuMs: CPU_MS }

  if (!opt.gate) {
    if (injected) throw new Error('ARA_PERF_INJECT_DELAY_MS 가 켜진 채로 기준선을 기록하지 않는다(양성 대조는 --gate 로)')
    console.log(`기준선 측정 ${opt.runs}회 (판당 약 ${Math.round((IDLE_MS + CPU_MS) / 1000) + 20}초)`)
    const r = await measure(opt.runs)
    const out = opt.out ?? DEFAULT_BASELINE
    mkdirSync(dirname(out), { recursive: true })
    const doc = { ...header, machine: { ...machine, electron: r.electron }, startupSources: r.startupSources, metrics: r.metrics }
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
    console.log(`기록: ${out}`)
    console.table(Object.fromEntries(METRICS.map((m) => [m, r.metrics[m]])))
    return 0
  }

  if (!existsSync(opt.baseline)) throw new Error(`기준선이 없다: ${opt.baseline} — npm run perf 먼저`)
  const baseline = JSON.parse(readFileSync(opt.baseline, 'utf8'))
  if (!sameMachine(baseline.machine, machine)) {
    console.error('다른 PC 다 — 비교하지 않는다(5-1절).', { 기준선: baseline.machine, 지금: machine })
    return 2
  }
  if (injected) console.log(`양성 대조: ARA_PERF_INJECT_DELAY_MS=${injected} — 이 판은 실패해야 정상이다`)
  for (let attempt = 0; attempt <= opt.retries; attempt++) {
    if (attempt > 0) console.log(`\n재측정 ${attempt}/${opt.retries} (M0·M1 규칙)`)
    const r = await measure(opt.runs)
    const verdict = judge(baseline.metrics, Object.fromEntries(METRICS.map((m) => [m, r.metrics[m].median])))
    console.table(verdict)
    if (opt.out) {
      const doc = { ...header, machine: { ...machine, electron: r.electron }, baseline: opt.baseline, injected, verdict, metrics: r.metrics }
      writeFileSync(opt.out, JSON.stringify(doc, null, 2) + '\n')
    }
    if (verdict.every((v) => v.ok)) {
      console.log('게이트 통과')
      return 0
    }
  }
  console.error('게이트 실패: 기준선 × (1+허용폭) 을 넘은 지표가 있다')
  return 1
}

module.exports = { median, mad, summarize, limitOf, judge, sameMachine, METRICS, FLOOR }

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    }
  )
}
