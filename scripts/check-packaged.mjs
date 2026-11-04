// dist:win 끝 — 방금 만든 win-unpacked/ARA.exe 를 node 모드(ELECTRON_RUN_AS_NODE, 창 없음)로 띄워 check-packaged-requires.cjs 를 돌린다.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const res = join('dist', 'win-unpacked', 'resources')
const r = spawnSync(join('dist', 'win-unpacked', 'ARA.exe'), [join('scripts', 'check-packaged-requires.cjs'), res], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
