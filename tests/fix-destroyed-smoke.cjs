// FIX-destroyed 실기동 회귀 가드 — "TypeError: Object has been destroyed" 에러 창 재발 근절 실증.
//
// 재현 경로(agent_talk/FIX-destroyed-done.md 조사): registerAiIpc.ts 의 push 가 유일하게
// `getWebContents()?.send()` 만 쓰고 isDestroyed() 를 확인하지 않았다. AraSession.run() 은 스트림
// 도중 emit.delta() 가 던지면 catch 블록에서 emit.end() 를 가드 없이 재호출하는데, 이 호출도 destroyed
// WebContents 에 떨어지면 다시 던지고 — 이번엔 catch 밖으로 전파돼 `void this.run()`(await/catch 없는
// fire-and-forget) 의 UnhandledPromiseRejection 이 된다. 실측(probe): 이 경로는 index.ts 의
// `process.on('uncaughtException')` 안전망을 타지 않는다.
//
// 이 스모크는 진짜 Electron BrowserWindow 를 만들어 실제로 destroy() 하고, 그 진짜(이미 destroyed)
// WebContents 를 getWebContents() 가 항상 돌려주는 최악의 경우를 실제 registerAiIpc + AraSession +
// ARA_AI_FAKE 스트림으로 실기동한다. 수정 전 코드로 돌리면 UnhandledPromiseRejection 이 잡히고,
// windowPush.ts 단일 가드를 거치는 수정 후 코드는 조용히 무시하고 스트림이 정상 종료된다.
const { app, BrowserWindow } = require('electron')
const { mkdtempSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const real = require('./.fixdestroy-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ofa-fixdestroy-smoke-')))
process.env.ARA_AI_FAKE = '1'
// Electron 기본 동작: 리스너가 없으면 마지막 창이 닫힐 때 앱을 바로 quit() 한다 — 이 스모크는
// 창을 일부러 destroy() 한 뒤에도 계속 돌아야 하므로(스트림이 destroyed 창을 향해 push 되는 걸
// 지켜보는 게 목적이다) 기본 quit 을 막는다(실제 앱의 index.ts 는 반대로 quit 되길 원해서 그대로 둔다).
app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 프로덕션과 동일한 안전망 — 이게 이 결함을 못 잡는다는 걸 실증하는 대조군이기도 하다.
const caught = { uncaught: [], rejected: [] }
process.on('uncaughtException', (err) => caught.uncaught.push(err))
process.on('unhandledRejection', (err) => caught.rejected.push(err))

// 리다이렉트된(비TTY) stdout/stderr 는 Windows 에서 비동기 flush 라 app.exit() 직후 끊길 수 있다 —
// 종료 전에 짧게 양보해 flush 를 보장한다(다른 하네스의 즉시 app.exit() 와 다른 점은 이 한 줄뿐).
async function finish(code) {
  await wait(200)
  app.exit(code)
}
async function fail(msg) {
  console.error('FIX-DESTROYED SMOKE FAIL: ' + msg)
  await finish(1)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('about:blank')
  const wc = win.webContents
  win.destroy()
  await wait(30)
  if (!wc.isDestroyed()) return fail('사전조건 실패: destroy() 후에도 webContents.isDestroyed()===false')
  console.log('사전조건 OK: webContents 가 실제로 destroyed 상태')

  // ── ① windowPush 헬퍼를 이미 destroyed 인 진짜 WebContents 에 직접 호출 ──
  try {
    real.pushSend(wc, 'probe:send', { a: 1 })
    real.pushMessage(wc, 'probe:postMessage', new Uint8Array([1, 2, 3]))
  } catch (e) {
    return fail('pushSend/pushMessage 가 destroyed WebContents 에서 던졌다: ' + e.stack)
  }
  console.log('① pushSend/pushMessage 직접 호출: 안전(예외 없음)')

  // ── ② registerAiIpc 통합 — getWebContents 가 항상 destroyed 인 wc 를 돌려주는 최악의 경우 ──
  const vault = {
    store: new Map([['ai.apiKey.anthropic', 'fake-key-for-smoke']]),
    get(k) { return this.store.get(k) ?? null },
    set(k, v) { this.store.set(k, v) },
    delete(k) { this.store.delete(k) },
    has(k) { return this.store.has(k) }
  }
  const getWebContents = () => wc // 항상 destroyed — getWebContents() 자체의 가드를 우회해 push 쪽만 검증
  const ara = real.registerAiIpc(vault, () => ({ provider: 'anthropic', model: 'claude' }), getWebContents)

  const { turnId } = ara.send({ text: '로그 디렉터리 정리 방법 알려줘' })
  console.log('② AI 스트림 시작(ARA_AI_FAKE=1), turnId=' + turnId)

  // FAKE_ANSWER 전체 스트리밍(약 100ms 간격 6~7 청크) + finish 여유.
  await wait(1500)

  const state = ara.getState()
  const turn = state.turns.find((t) => t.id === turnId)
  console.log('② 스트림 종료 후 turn.end=' + (turn && turn.end) + ' streaming=' + state.streaming)

  const checks = []
  checks.push(['uncaughtException 없음', caught.uncaught.length === 0])
  checks.push(['unhandledRejection 없음', caught.rejected.length === 0])
  checks.push(['스트림이 매달리지 않고 종료(streaming===false)', state.streaming === false])
  checks.push(['턴이 종료 상태로 마감(done/canceled/error 중 하나)', !!turn && !!turn.end])

  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (caught.uncaught.length) console.error('  uncaughtException 상세: ' + caught.uncaught.map((e) => e.stack).join('\n'))
  if (caught.rejected.length) console.error('  unhandledRejection 상세: ' + caught.rejected.map((e) => (e && e.stack) || e).join('\n'))

  if (failed.length) return fail(failed.map(([l]) => l).join(', '))

  console.log('FIX-DESTROYED SMOKE PASS')
  await finish(0)
})

setTimeout(() => fail('timeout (15s) — AI 스트림이 매달렸을 가능성'), 15000)
