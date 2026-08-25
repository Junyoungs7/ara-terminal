// 창 push 우회 스캔 (FIX-destroyed 재발 근절 — scan-magic-numbers.mjs 와 같은 계열).
// src/main 어디서든 webContents.send()/postMessage() 를 직접 호출하면 실패한다 — 창으로 나가는
// 모든 push 는 util/windowPush.ts 의 pushSend/pushMessage 단일 헬퍼만 거쳐야 한다(isDestroyed 가드가
// 거기 한 곳에만 있다). 새 IPC 도메인을 추가할 때 이 가드를 깜빡하고 직접 `wc.send(...)` 를 쓰는
// 우회 호출부가 다시 생기는 걸 CI 에서 막는다. 위반 시 exit 1.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, sep } from 'node:path'

const ROOT = 'src/main'
// 이 파일만 실제 wc.send/postMessage 를 호출할 수 있다(가드가 여기 있다).
const ALLOWED = join(ROOT, 'util', 'windowPush.ts').split(sep).join('/')
const SEND_LIKE = /\.(send|postMessage)\(/
// 이름만 같고 webContents 가 아닌 호출들(false positive):
//  - AraSession.send()      : 대화 턴을 시작하는 퍼블릭 API
//  - ws.send() / sock.write : F25 RDP 릴레이의 WebSocket·TLS 소켓(창이 아니라 원격으로 나간다)
//  - engine.send()          : #123 아라 엔진 — claude 프로세스의 **stdin** 으로 나간다(창이 아니다)
const KNOWN_NON_PUSH = /\bara\.send\(|\bws\.send\(|\bengine\??\.send\(|\bchat\.send\(|\bsession\.send\(/

function walk(dir) {
  let out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (extname(p) === '.ts') out.push(p)
  }
  return out
}

const violations = []
for (const file of walk(ROOT)) {
  const posixPath = file.split(sep).join('/')
  if (posixPath === ALLOWED) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (KNOWN_NON_PUSH.test(line)) return
    if (SEND_LIKE.test(line)) violations.push(`${posixPath}:${i + 1}  → ${line.trim()}`)
  })
}

if (violations.length) {
  console.error(
    '창 push 우회 스캔 실패 — webContents.send()/postMessage() 직접 호출 발견, ' +
      "util/windowPush.ts 의 pushSend/pushMessage 를 쓰세요:\n" + violations.join('\n')
  )
  process.exit(1)
}
console.log('창 push 우회 스캔 통과 (모든 push 가 windowPush.ts 를 거친다)')
