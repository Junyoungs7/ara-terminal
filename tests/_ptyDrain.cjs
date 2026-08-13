// 하네스용 종료 배수 — src/main/sessions/PtyBackend.ts 의 drainKilledPtys 와 같은 일을 한다.
// 하네스는 실 main 을 쓰지 않고 raw node-pty 를 직접 스폰하므로(smoke-boot.cjs 등 30여 개) 그 쪽
// 구현을 재사용할 수 없다 — 로직이 바뀌면 두 곳을 같이 고쳐라. 왜 필요한지는 PtyBackend.ts 의
// "종료 배수(Windows conpty)" 주석에 실측과 함께 적혀 있다. 요약하면: p.kill() 뒤 node-pty 의
// 네이티브 exit 콜백이 메인 루프에 도착하기 전에 app.exit() 하면 프로세스가 즉사한다(0xC0000409).
// 상한 근거는 PtyBackend.ts 주석 참조. 하네스 쪽만 더 크게 잡는다: 스모크는 렌더러를 여러 번
// 리로드하면서 이전 세션을 정리하지 않아 종료 시점에 pty 가 **24개**까지 쌓인다(앱의 실사용 세션
// 수와 다르다). 실측으로 상한을 넘긴 채 종료하면 예외 없이 죽었다 —
// pending 12·4·19·1 네 번 전부 SIGSEGV, pending 0 이면 전부 정상. 그래서 상한은 "여기서 포기한다"가
// 아니라 "여기까지는 기다린다"에 가깝게 넉넉히 잡는다. 정상 경로는 여전히 27~78ms 다.
const EXIT_DRAIN_CAP_MS = 15000
const EXIT_DRAIN_POLL_MS = 5

const exitReported = (p) => p && p._agent && p._agent._exitCode !== undefined

// kill() 을 이미 부른 pty 들을 넘긴다. 전부 exit 콜백이 도착하거나 상한에 닿으면 resolve.
async function drainPtyExits(ptys) {
  if (process.platform !== 'win32') return
  const pending = new Set([...ptys].filter(Boolean))
  const deadline = Date.now() + EXIT_DRAIN_CAP_MS
  while (pending.size > 0 && Date.now() < deadline) {
    for (const p of pending) if (exitReported(p)) pending.delete(p)
    if (pending.size === 0) break
    await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_POLL_MS))
  }
}

// kill + 배수 + 종료를 한 줄로. 하네스 끝은 `await killPtysAndExit(ptys, code)` 하나면 된다.
// 재진입 금지: 정상 종료가 배수를 도는 도중 스위트 타임아웃의 fail() 이 겹치면 kill·배수·exit 이
// 두 번 돌고, 그 상태로 app.exit() 이 두 번 불려 그대로 죽는다(2026-08-11 실측: pending=4
// elapsed=5461ms 뒤 SIGSEGV). 먼저 시작한 쪽만 끝까지 간다.
let exiting = false
async function killPtysAndExit(ptys, code) {
  if (exiting) return
  exiting = true
  const list = [...ptys]
  const t0 = Date.now()
  for (const p of list) {
    try {
      p.kill()
    } catch {
      /* 이미 종료 */
    }
    // kill 사이에 메인 루프를 한 번 돌려 앞서 죽은 pty 의 exit 콜백이 뒤 kill 과 겹쳐 들어오게 한다.
    // ponytail: 이걸 넣은 뒤 pending 이 19 → 1 로 줄었지만 각 n=1 이라 인과는 확정 못 했다
    //   (kill 자체는 24개에 76ms 로 빠르다 — 병목은 kill 이 아니라 콜백 도착이다).
    //   해롭지 않고 이론상 맞는 방향이라 남긴다. 진짜 해결은 아래 상한이다.
    await new Promise((resolve) => setImmediate(resolve))
  }
  const killedAt = Date.now()
  await drainPtyExits(list)
  const pending = list.filter((p) => !exitReported(p)).length
  // pending>0 = 상한에 걸린 채 종료한다 = 세그폴트 위험 구간이다. 이때는 **항상** 남긴다 —
  // 나중에 세그폴트가 나면 이 줄 하나로 원인이 갈린다(플래그를 안 켰다고 증거가 사라지면 안 된다).
  // 정상(pending=0)일 때는 ARA_DRAIN_DEBUG=1 을 켠 경우에만 찍어 로그를 더럽히지 않는다.
  // kill 과 배수를 나눠 찍는다 — "kill 이 느렸나, 콜백이 늦었나"가 한 줄로 갈린다.
  if (pending > 0 || process.env.ARA_DRAIN_DEBUG === '1') {
    process.stderr.write(
      `[drain] n=${list.length} pending=${pending} kill=${killedAt - t0}ms drain=${Date.now() - killedAt}ms\n`
    )
  }
  require('electron').app.exit(code)
}

module.exports = { drainPtyExits, killPtysAndExit }
