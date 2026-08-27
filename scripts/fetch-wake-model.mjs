// 깨우기 말 모델 받아 두기 — **설치본에 함께 넣는다**(2026-08-27 준영님 결정).
//
// 왜 내려받게 하지 않나: 개인 PC 에서 쓸 때 사내 서버에 붙으려면 VPN 을 켜야 한다. 음성 하나
// 켜자고 VPN 을 켜게 할 수는 없다. 바깥(alphacephei.com)에서 받게 하는 것도 사내망에서 막힐 수
// 있고 DLP 검토 대상이 하나 는다 — 그래서 **설치할 때 이미 들어 있게** 한다.
//
// 파일은 **저장소에 안 넣는다**(87MB). 빌드 기계가 한 번 받아 resources/voice/ 에 캐시하고,
// electron-builder 가 그 폴더를 설치본에 싣는다. 이미 있으면 건너뛴다.
//   npm run voice:model      # 받기(빌드 전에 한 번)
//
// 모델을 바꿀 때는 URL 과 크기를 함께 고친다 — 크기가 다르면 받다 만 파일로 보고 다시 받는다.
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'resources', 'voice')

/**
 * Vosk 한국어 소형 모델(Apache-2.0). 오프라인으로 돌고 네이티브 모듈이 필요 없다(WASM).
 * 큰 모델은 1GB 가 넘어 설치본에 못 싣는다 — 깨우는 말 한 마디를 가리는 데는 소형으로 충분하다.
 */
const MODEL = {
  url: 'https://alphacephei.com/vosk/models/vosk-model-small-ko-0.22.zip',
  file: 'vosk-model-small-ko-0.22.zip',
  bytes: 86_914_329
}

const out = join(DIR, MODEL.file)

if (existsSync(out) && statSync(out).size === MODEL.bytes) {
  console.log(`이미 있음: resources/voice/${MODEL.file} (${(MODEL.bytes / 1024 / 1024).toFixed(0)}MB)`)
  process.exit(0)
}

mkdirSync(DIR, { recursive: true })
console.log(`받는 중: ${MODEL.url}`)

const res = await fetch(MODEL.url)
if (!res.ok || !res.body) {
  console.error(`실패 (${res.status}). 바깥 인터넷이 막혀 있으면 이 파일만 따로 받아 ${DIR} 에 두면 된다.`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(out))

const got = statSync(out).size
if (got !== MODEL.bytes) {
  unlinkSync(out) // 받다 만 파일을 남기지 않는다 — 다음 빌드가 그걸 정상으로 볼 수 있다
  console.error(`크기가 다르다: ${got} ≠ ${MODEL.bytes}. 지웠으니 다시 받아라.`)
  process.exit(1)
}
console.log(`완료: resources/voice/${MODEL.file} (${(got / 1024 / 1024).toFixed(0)}MB)`)
