// OR-2 main 진입점(package.json main → out/main/boot.js). 아라 모듈을 하나도 불러오기 전에 "Oriel 호스트 모드"(main/oriel/host.ts)를 가른다:
// 맞으면 아라 초기화(userData·단일 인스턴스·창) 없이 동봉 Oriel 의 main 을 불러와 Oriel 로 뜬다 — userData·잠금·파이프는 Oriel 이 스스로 정한다.
// 아니면 아라(index.ts) 그대로. index.ts 를 분기 안에 둘 수 없는 이유: import 는 끌어올려지고 index.ts 맨 위 문장들이 바로 아라 초기화다.
// e2e·스모크 하네스는 out/main/index.js 를 직접 띄우므로 이 파일을 거치지 않는다(아라 동작은 같다).
import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { orielHostDir } from './oriel/host'

// 불러오다 던진 오류는 거부(rejection)가 되어 조용히 묻힌다 → 다음 틱에 다시 던져 예전처럼 uncaughtException(오류 창)으로.
const rethrow = (e: unknown): void => process.nextTick(() => { throw e })
const oriel = orielHostDir({ argv: process.argv, env: process.env, resourcesPath: process.resourcesPath, packaged: app.isPackaged })
if (oriel) import(pathToFileURL(join(oriel, 'src', 'main', 'main.mjs')).href).catch(rethrow)
else import('./index').catch(rethrow)
