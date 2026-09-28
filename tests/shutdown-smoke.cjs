// FIX-shutdown 실기동 회귀 가드 — kill 한 pty 의 네이티브 exit 콜백을 기다리지 않고 프로세스를
// 끝내면 즉사하는 결함(0xC0000409 / 0xC0000005)이 다시 살아나지 않는지 확인한다.
//
// 원인(FIX-shutdown 조사): node-pty 의 Windows conpty 경로는 kill() 에서
// ConptyClosePseudoConsole → TerminateProcess 를 부르고(node-pty src/win/conpty.cc PtyKill),
// 셸이 죽으면 네이티브 스레드(같은 파일 SetupExitCallback)가 WaitForSingleObject 에서 깨어나
// ThreadSafeFunction 으로 exit 을 메인 루프에 올린다. 그 콜백이 도착하기 전에 프로세스를 끝내면
// 그 스레드가 사라지는 중인 V8 환경을 만져 즉사한다. 콜백 도착까지 실측 14~16ms.
// 수정: PtyBackend.drainKilledPtys() 가 그 콜백(agent._exitCode)을 기다린 뒤 종료한다.
//
// 이 하네스는 **대조군을 먼저 돌려 결함이 실제로 재현되는지 확인**한 뒤 수정본을 검증한다.
// 대조군이 안 죽으면 가드가 죽은 것이므로 통과시키지 않는다(조용히 초록이 되는 가드 금지).
//
// 커버 범위: 실 MainSessionManager + 실 PtyBackend 로 진짜 로컬 pty 를 띄우고 죽인 뒤 종료하는 경로.
//
// 셸 기본값이 cmd.exe 인 이유 — 정직하게: 이 결함과 **별개로**, powershell 세션을 kill 하면 약
// 13~25% 확률로 프로세스가 비정상 종료하는 두 번째 문제가 있다(배수를 넣어도 그대로다).
// 이 가드의 대상이 아니다 — 여기서 같이 빨개지면 정작 고친 것이 회귀했는지를 못 읽는다.
// 재현은 `ARA_SHUTDOWN_SHELL` 을 비우고(= PtyBackend 기본 셸) 돌리면 된다:
//   ARA_SHUTDOWN_SHELL= ARA_SHUTDOWN_RUNS=15 node tests/shutdown-smoke.cjs
//
// 🔴 **2026-09-21: 그 두 번째 문제의 원인을 찾았다**(준영님 제보 —
//    `Assertion failed! … conpty.node … remove_pty_baton`, 세션 떼어낸 뒤 종료).
//    `node_modules/node-pty/src/win/conpty.cc:106` 이 **pty 마다 자기 네이티브 스레드에서**
//      assert(remove_pty_baton(baton->id));
//    를 부르는데, 그 함수가 고치는 `ptyHandles` 는 **잠금 없는 전역 std::vector** 다(:65).
//    여러 pty 가 거의 동시에 죽으면 `remove_if`+`erase` 가 겹쳐 하나가 false 를 받고 어설션이
//    터진다. `destroyAll()` 이 세션을 연달아 kill 하는 것이 정확히 그 조건이고, **세션이 많을수록
//    확률이 오른다** — 그래서 간헐적이고, 그래서 배수를 넣어도 안 사라졌다(배수는 *기다리는*
//    장치지 *겹치지 않게 하는* 장치가 아니다).
//    ⚠️ 우리 코드의 결함이 아니다. 완화는 **kill 을 겹치지 않게 하는 것**(하나씩 죽이고 그 exit
//    콜백을 받은 뒤 다음) — `PtyBackend.killInTurn`(#203, 2026-09-28). before-quit 순서는 안 건드렸다.
//    실측(powershell, 세션 8개): 전 7/200 실패 → 후 0/200. 배수 경과 중앙값 29ms → 139ms(최대 244ms).
//    세션 4개는 전 2/30 → 후 0/30 — 이쪽은 표본이 작아 증거가 약하다(agent_talk/R14-A-done.md).
//    그래서 이제 기본 셸을 powershell 로 돌려도 초록이어야 한다. 빨개지면 줄 세우기가 깨진 것이다.
// 자세한 실측은 agent_talk/FIX-shutdown-done.md §"남은 것".
// 부모(node)·자식(electron) 양쪽에서 걸리도록 분기 **앞**에 둔다 — 자식만 걸면 부모의 예외가
// 그대로 새고, 부모만 걸면 정작 창을 띄우는 자식이 무방비다.
require('./_harnessGuard.cjs')

const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' : undefined
const RUNS = Number(process.env.ARA_SHUTDOWN_RUNS || 10)
const CONTROL_RUNS = Number(process.env.ARA_SHUTDOWN_CONTROL_RUNS || 3)
// 세션 수가 어설션 확률을 올린다(#203) — 조건을 바꿔 재려고 환경변수로 받는다.
const SESSIONS_PER_RUN = Number(process.env.ARA_SHUTDOWN_SESSIONS || 4)
const CHILD_TIMEOUT_MS = 30000

// ── 부모(node): 자식 electron 을 반복 실행해 종료 코드를 센다 ────────────────────────────────
if (process.env.ARA_SHUTDOWN_CHILD !== '1') {
  const { spawnSync } = require('node:child_process')
  const electronPath = require('electron') // node 에서 require 하면 실행 파일 경로 문자열이다.

  const runChild = (extraEnv) => {
    const r = spawnSync(electronPath, [__filename], {
      env: { ...process.env, ARA_SHUTDOWN_CHILD: '1', ...extraEnv },
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      windowsHide: true
    })
    // status===null 은 타임아웃(매달림). 크래시는 0 이 아닌 코드로 온다.
    const label =
      r.status === null ? `HANG/${r.signal}` : `0x${(r.status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
    return { ok: r.status === 0, label, stderr: (r.stderr || '').trim() }
  }

  console.log(`대조군(배수 없음) ${CONTROL_RUNS}회 — 여기서 죽어야 가드가 살아 있는 것이다`)
  const control = []
  for (let i = 0; i < CONTROL_RUNS; i++) {
    const r = runChild({ ARA_SHUTDOWN_NODRAIN: '1' })
    control.push(r)
    console.log(`  control${i + 1}: exit=${r.label}`)
  }
  const controlCrashed = control.filter((x) => !x.ok).length
  if (controlCrashed === 0) {
    console.error(
      `SHUTDOWN SMOKE FAIL: 대조군이 ${CONTROL_RUNS}회 모두 정상 종료했다 — 이 하네스가 더는 결함을 ` +
        `재현하지 못한다(node-pty 동작이 바뀌었을 수 있다). 초록으로 넘기지 않는다.`
    )
    process.exit(1)
  }
  console.log(`  → 대조군 ${controlCrashed}/${CONTROL_RUNS} 비정상 종료: 재현 확인`)

  console.log(`수정본(배수 있음) ${RUNS}회`)
  const fixed = []
  for (let i = 0; i < RUNS; i++) {
    const r = runChild({})
    fixed.push(r)
    console.log(`  run${i + 1}: exit=${r.label}`)
  }

  const bad = fixed.filter((x) => !x.ok)
  for (const b of bad) if (b.stderr) console.error('  stderr: ' + b.stderr.split('\n').slice(0, 5).join('\n  '))
  console.log(`SHUTDOWN SMOKE: ${RUNS - bad.length}/${RUNS} 정상 종료 (세션 ${SESSIONS_PER_RUN}개 kill 후 종료)`)
  if (bad.length) {
    console.error(`SHUTDOWN SMOKE FAIL: 비정상 종료 ${bad.length}회 — ${bad.map((b) => b.label).join(', ')}`)
    process.exit(1)
  }
  console.log('SHUTDOWN SMOKE PASS')
  process.exit(0)
}

// ── 자식(electron): 실 세션 매니저로 pty 를 띄우고 죽인 뒤 종료한다 ─────────────────────────
const { app } = require('electron')
const { mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { MainSessionManager, drainKilledPtys } = require('./.shutdown-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ara-shutdown-')))

const noop = () => {}
const sessions = new MainSessionManager({ data: noop, exit: noop, cwd: noop })

app.whenReady().then(async () => {
  for (let i = 0; i < SESSIONS_PER_RUN; i++) {
    await sessions.create({
      type: 'local',
      shell: (process.env.ARA_SHUTDOWN_SHELL ?? DEFAULT_SHELL) || undefined,
      profileId: null,
      title: `shutdown-${i}`,
      serverKey: 'localhost'
    })
  }
  // 셸이 실제로 프롬프트를 뱉어 스트림이 흐르는 상태에서 죽인다(조용한 pty 는 레이스를 못 만든다).
  // 3초인 이유: 800ms 로 잡으면 이 가드가 10% 쯤 흔들린다 — 스폰 직후 1초 안에 kill 하면 **또 다른**
  // 레이스가 있다(conpty 초기화 중 종료로 보인다. FIX-shutdown-done.md §8). 그건 이 가드의 대상이
  // 아니라서 그 구간을 피해 세운다. 3초로는 27/27 통과, 800ms 로는 9/10·15/15 로 흔들렸다.
  await new Promise((r) => setTimeout(r, Number(process.env.ARA_SHUTDOWN_ALIVE_MS || 3000)))
  sessions.destroyAll()
  const t0 = Date.now()
  if (process.env.ARA_SHUTDOWN_NODRAIN !== '1') await drainKilledPtys()
  // 대조군: #203 부터 kill 은 줄을 서서 **한 마이크로태스크 뒤에** 일어난다(PtyBackend.killInTurn).
  // 그냥 exit 하면 죽인 pty 가 하나도 없어 대조군이 결함을 못 만든다(실측: powershell 0/3).
  // 한 턴 양보해 첫 pty 를 죽인 뒤 곧장 끝낸다 — "kill 하고 exit 을 안 기다림" 이 그대로 재현된다.
  else await new Promise((r) => setImmediate(r))
  // 배수 경과를 동기로 파일에 남긴다 — Windows 의 파이프 stderr 는 비동기 flush 라 즉시 종료하면
  // 사라진다(fix-destroyed-smoke.cjs 주석과 같은 함정).
  if (process.env.ARA_SHUTDOWN_LOG) {
    require('node:fs').appendFileSync(process.env.ARA_SHUTDOWN_LOG, `drain=${Date.now() - t0}ms\n`)
  }
  app.exit(0)
})

setTimeout(() => app.exit(3), 20000)
