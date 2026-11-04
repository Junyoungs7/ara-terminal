// 패키지된 ARA.exe 를 node 모드로 띄워(창 없음) main 번들이 바깥에서 require 하는 모듈이 asar 안에서 풀리는지 본다.
// 2026-11-04 2.2.1: node_modules 가 junction 인 폴더(OFA-perf)에서 빌드하자 electron-builder 가 하위 의존성 292개를 못 찾고
// ("cannot find path for dependency" 경고만) 빼먹어, 설치 후 첫 실행이 "Cannot find module 'asn1'" 로 죽었다. dist:win 끝에서 돈다.
const fs = require('fs')
const path = require('path')
const res = process.argv[2] // .../resources
const app = path.join(res, 'app.asar')
const main = path.join(app, 'out', 'main')
const ids = new Set()
for (const f of fs.readdirSync(main, { recursive: true })) {
  if (!String(f).endsWith('.js')) continue
  const src = fs.readFileSync(path.join(main, String(f)), 'utf8')
  for (const m of src.matchAll(/require\(["']([^"'.\/][^"']*)["']\)/g)) ids.add(m[1])
}
const builtin = new Set(require('module').builtinModules)
const bad = []
for (const id of ids) {
  const base = id.startsWith('node:') ? id.slice(5) : id
  if (builtin.has(base) || builtin.has(base.split('/')[0]) || id === 'electron') continue
  try {
    require.resolve(id, { paths: [main] })
    require(require.resolve(id, { paths: [main] }))
  } catch (e) {
    bad.push(id + ' :: ' + String(e.message).split('\n')[0])
  }
}
console.log('externals', ids.size, 'failed', bad.length)
if (ids.size === 0) { console.error("external require 를 하나도 못 찾았다 — 검사 자체가 깨졌다"); process.exit(1) }
if (bad.length) process.exitCode = 1
for (const b of bad) console.log('  ' + b)
