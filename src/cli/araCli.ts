// M14 R2 `ara` CLI 진입점 — 빌드하면 out/main/araCli.js(electron.vite.config.ts 의 main 입력). 설치본은 resources\bin\ara.cmd 가
// 아라 실행 파일을 ELECTRON_RUN_AS_NODE=1 로 띄워 이 파일을 돌린다(node 없는 PC — OR-2·M4 데몬과 같은 길).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnDetached } from '../main/util/runProcess'
import { isNodeBinary, run } from './main'

/** 판 = 아라 package.json. 설치본은 이 파일이 app.asar.unpacked 에 있고 package.json 은 app.asar 안이다(Electron 의 node 모드도 asar 를 읽는다). */
function appVersion(): string {
  const pkg = join(__dirname, '..', '..', 'package.json')
  for (const p of [pkg.replace('app.asar.unpacked', 'app.asar'), pkg]) {
    try {
      return String((JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version)
    } catch {
      /* 다음 후보 */
    }
  }
  return 'unknown'
}

/** 아라 창 띄우기 — 같은 실행 파일을 node 모드 없이, 지금 폴더에서(탐색기 `아라` 와 같은 길 — 켜져 있으면 그 창이 받는다). */
function launchApp(): void {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawnDetached(process.execPath, [], { cwd: process.cwd(), env })
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

void run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  version: appVersion(),
  ...(isNodeBinary(process.execPath) ? {} : { launchApp })
}).then((code) => {
  process.exitCode = code
})
