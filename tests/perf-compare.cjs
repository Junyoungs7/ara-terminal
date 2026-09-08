// #190 3라운드 — 여러 판을 한 표로 세운다. 판 하나만 보면 "10ms 는 원래 그런 것"인지
// "텔레메트리가 만든 것"인지 알 수 없다 — **짝을 나란히 놓는 것**이 이 파일이 하는 일이다.
//
// 돌리는 법: node tests/perf-compare.cjs [태그...]   (인자 없으면 agent_talk/perf/*.json 전부)
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const DIR = join(__dirname, '..', 'agent_talk', 'perf')
const only = process.argv.slice(2)
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && (only.length === 0 || only.includes(f.replace('.json', ''))))

const rows = []
for (const f of files) {
  let r
  try { r = JSON.parse(readFileSync(join(DIR, f), 'utf8')) } catch { continue }
  const A = r.analysis
  const C = r.cpu || {}
  rows.push({
    tag: r.cfg.tag,
    s: r.cfg.sessions,
    tel: r.cfg.telemetry ? 'ON' : 'off',
    typ: r.cfg.typing ? 'ON' : '-',
    prof: r.cfg.profile ? 'perf' : 'prod',
    winS: Math.round(A.windowMs / 1000),
    lt: A.longtask.count,
    ltMax: A.longtask.maxMs,
    cpuPct: C.ok ? C.cpuBusyPct : null,
    cpuMs: C.ok ? C.cpuBusyMs : null,
    perTick: C.ok && C.perTickBusyMs.length ? Math.round((C.perTickBusyMs.reduce((a, b) => a + b, 0) / C.perTickBusyMs.length) * 10) / 10 : null,
    dens: C.ok ? C.tickWindow.densityRatio : null,
    run20: C.ok ? C.busyRuns.over20 : null,
    runMax: C.ok ? C.busyRuns.maxMs : null,
    commits: A.commits.count,
    perTickCommits: A.commits.perTick,
    actMs: A.commits.totalActualMs,
    echo: r.keys ? r.keys.echo.p95 : null,
    draw: r.keys ? r.keys.draw.p95 : null,
    handle: r.keys ? r.keys.handle.p95 : null
  })
}
rows.sort((a, b) => a.tag.localeCompare(b.tag))

const COLS = [
  ['tag', 14], ['s', 2], ['tel', 3], ['typ', 3], ['prof', 4], ['winS', 4],
  ['lt', 3], ['ltMax', 5], ['cpuPct', 6], ['cpuMs', 6], ['perTick', 7], ['dens', 5],
  ['run20', 5], ['runMax', 6], ['commits', 7], ['perTickCommits', 6], ['actMs', 6],
  ['handle', 6], ['echo', 5], ['draw', 5]
]
const line = (o) => COLS.map(([k, w]) => String(o[k] ?? '-').padStart(w)).join(' ')
console.log(line(Object.fromEntries(COLS.map(([k]) => [k, k]))))
console.log(COLS.map(([, w]) => '-'.repeat(w)).join(' '))
for (const r of rows) console.log(line(r))
console.log(`
  lt/ltMax   롱태스크 횟수 / 최장 ms
  cpuPct     측정 창에서 메인 스레드가 JS·V8 로 바쁜 비율
  perTick    틱 하나가 부르는 CPU 평균 ms (틱 뒤 400ms 창)
  dens       틱 창의 CPU 밀도 ÷ 나머지 시간의 밀도. 1 이면 텔레메트리 무죄
  run20      연속 20ms 이상 바쁜 구간 개수 (사람이 끊김으로 느끼기 시작하는 크기)
  commits    React 커밋 수 (profile 판에서만 샌다) · perTickCommits 는 틱당
  actMs      actualDuration 합 (🔴 profile 빌드는 절대값이 부풀려져 있다)
  handle/echo/draw  키 하나의 p95 ms — 앱이 키를 처리 / pty 에코 도착 / xterm 이 GL 로 그림`)
