// #190 3라운드 — 판 일곱을 순서대로 돌린다. 한 판씩 따로 돌려도 되지만(perf-probe.cjs 머리말),
// **대조군이 있어야 답이 나온다**: 텔레메트리 ON 판 하나만 재면 "10ms 는 원래 그런 것"인지
// "텔레메트리가 만든 것"인지 알 수 없다. 그래서 같은 조건에서 OFF 판을 짝으로 돌린다.
//
//   idle-t1 / idle-t1-off     세션 1, 가만히 30초           ← 겹침 질문 + 대조군
//   idle-t4 / idle-t4-off     세션 4, 가만히 30초           ← 세션 수에 따른 변화
//   type-t1 / type-t1-off     세션 1, 타이핑                ← 키→화면 + 타이핑 중 롱태스크
//   prof-t1 / prof-t4         profiling 빌드, 컴포넌트별     ← 리렌더가 **어디에** 얼마나
//   idle-t1-tabs / prof-t1-tabs  하단 탭 넷을 열어 둔 상태     ← "갈수록 나빠진다"가 사실인가
//
// 돌리는 법:
//   npm run build
//   npx electron-vite build --config tests/perf.vite.config.ts
//   node tests/perf-run.cjs
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')

const RUNS = [
  ['idle-t1', '--sessions=1', '--telemetry=on', '--dur=30000'],
  ['idle-t1-off', '--sessions=1', '--telemetry=off', '--dur=30000'],
  ['idle-t4', '--sessions=4', '--telemetry=on', '--dur=30000'],
  ['idle-t4-off', '--sessions=4', '--telemetry=off', '--dur=30000'],
  ['type-t1', '--sessions=1', '--telemetry=on', '--typing=on', '--dur=30000'],
  ['type-t1-off', '--sessions=1', '--telemetry=off', '--typing=on', '--dur=30000'],
  ['prof-t1', '--sessions=1', '--telemetry=on', '--profile=on', '--dur=20000'],
  ['prof-t4', '--sessions=4', '--telemetry=on', '--profile=on', '--dur=20000'],
  ['prof-type-t1', '--sessions=1', '--telemetry=on', '--typing=on', '--profile=on', '--dur=30000'],
  ['idle-t1-tabs', '--sessions=1', '--telemetry=on', '--tabs=on', '--dur=30000'],
  ['prof-t1-tabs', '--sessions=1', '--telemetry=on', '--tabs=on', '--profile=on', '--dur=20000']
]

const only = process.argv.slice(2)
for (const [tag, ...args] of RUNS) {
  if (only.length > 0 && !only.includes(tag)) continue
  console.log(`\n${'='.repeat(78)}\n== ${tag}\n${'='.repeat(78)}`)
  const r = spawnSync(ELECTRON, [join(__dirname, 'perf-probe.cjs'), `--tag=${tag}`, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) console.log(`!! ${tag} 가 ${r.status} 로 끝났다`)
}
console.log('\n비교표: node tests/perf-compare.cjs')
