// 🔴 R14-A 두 가지를 지킨다.
//
// ① #201 B-4 — `session:exit` 이 **그 세션을 가진 창**으로 가는가.
//    onExit 은 핸들을 지운 **뒤에** 알리고, `destroy()` 길은 kill 전에 이미 지웠다. 그래서 라우터의
//    `winIdOf(id)` 는 그 순간 늘 비어 있고 본창으로 떨어졌다 — 떼어낸 창에 [프로세스 종료] 줄이 안 찍혔다.
//    `sessionClosed.test.ts` 와 같은 방식이다: **알림이 나가는 순간** 라우팅에 쓸 값을 잰다.
//
// ② #203 — 로컬 pty 의 kill 이 **겹치지 않는가**(conpty.cc 의 잠금 없는 벡터 · `remove_pty_baton` 어설션).
//    진짜 conpty 경합은 `tests/shutdown-smoke.cjs` 가 잰다. 여기는 줄 세우기 규칙만 가짜로 잰다.
import { describe, it, expect, vi } from 'vitest'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink } from '../src/main/sessions/ISessionManager'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'

function rig() {
  const exits: { id: string; winId: string | undefined; routerSaw: string | undefined }[] = []
  const sink: SessionSink = {
    data() {},
    cwd() {},
    exit(id, _code, _signal, winId) {
      exits.push({ id, winId, routerSaw: mgr.winIdOf(id) })
    }
  }
  const mgr = new MainSessionManager(sink)
  const fire = new Map<string, () => void>()
  const add = (id: string, winId?: string): string => {
    const backend: SessionBackend = {
      write() {},
      resize() {},
      pause() {},
      resume() {},
      kill() {},
      onData() {},
      onExit(cb) {
        fire.set(id, () => cb(0))
      }
    }
    return mgr.adopt(
      backend,
      { type: 'ssh', title: id, serverKey: 'web-01', profileId: 'p1', cwd: undefined, shell: undefined, ...(winId ? { winId } : {}) },
      id
    )
  }
  return { mgr, exits, add, fire: (id: string) => fire.get(id)!() }
}

describe('#201 B-4 — exit 은 그 세션의 창으로 간다', () => {
  it('★ 셸이 스스로 끝나면 떼어낸 창의 winId 가 함께 나간다', () => {
    const { exits, add, fire } = rig()
    add('a', 'win-2')
    fire('a')
    expect(exits.map((e) => e.winId)).toEqual(['win-2'])
    // 왜 인자로 넘기나: 그 순간 라우터(winIdOf)는 이미 못 찾는다. 이 줄이 원래 결함의 모양이다.
    expect(exits[0].routerSaw).toBeUndefined()
  })

  it('★ destroy() 길(핸들을 먼저 지우고 kill) 에서도 같은 창이다', () => {
    const { mgr, exits, add, fire } = rig()
    add('a', 'win-2')
    mgr.destroy('a')
    fire('a') // kill 뒤 백엔드가 늦게 올리는 exit
    expect(exits.map((e) => e.winId)).toEqual(['win-2'])
  })

  it('떼어낸 뒤·되돌린 뒤의 창을 따른다(moveToWindow 가 옮긴 값)', () => {
    const { mgr, exits, add, fire } = rig()
    add('a')
    add('b', 'win-2')
    mgr.moveToWindow('a', 'win-3')
    mgr.moveToWindow('b', undefined)
    fire('a')
    fire('b')
    expect(exits).toMatchObject([
      { id: 'a', winId: 'win-3' },
      { id: 'b', winId: undefined }
    ])
  })
})

describe('#203 — 로컬 pty kill 을 줄 세운다', () => {
  // 모듈 상태(줄 · 신호 죽음 표시)가 있어 시험마다 새로 불러온다.
  const fresh = async () => {
    vi.resetModules()
    return import('../src/main/sessions/PtyBackend')
  }

  it('★ 앞의 exit 이 도착하기 전에는 다음을 죽이지 않는다', async () => {
    const { killInTurn, drainKilledPtys } = await fresh()
    const log: string[] = []
    const reported = { a: false, b: false }
    void killInTurn(() => log.push('kill:a'), () => reported.a)
    void killInTurn(() => log.push('kill:b'), () => reported.b)
    void killInTurn(() => log.push('kill:c'), () => true)
    await new Promise((r) => setTimeout(r, 30))
    expect(log).toEqual(['kill:a']) // a 의 exit 이 아직이다 — b 는 기다린다
    reported.a = true
    await new Promise((r) => setTimeout(r, 30))
    expect(log).toEqual(['kill:a', 'kill:b'])
    reported.b = true
    await drainKilledPtys() // 종료 배수는 줄이 빌 때까지 기다린다
    expect(log).toEqual(['kill:a', 'kill:b', 'kill:c'])
  })

  it('이미 죽은 pty(kill 이 던짐)는 기다리지 않고 넘어간다', async () => {
    const { killInTurn } = await fresh()
    const log: string[] = []
    void killInTurn(() => {
      throw new Error('already exited')
    }, () => false)
    await killInTurn(() => log.push('kill:b'), () => true)
    expect(log).toEqual(['kill:b'])
  })

  it('★ 신호가 안 오면 상한에서 넘어가고, 그 뒤로는 안 기다린다(종료가 멈추면 안 된다)', async () => {
    const { killInTurn } = await fresh()
    const t0 = Date.now()
    await killInTurn(() => {}, () => false, 50)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    const t1 = Date.now()
    await killInTurn(() => {}, () => false, 50)
    await killInTurn(() => {}, () => false, 50)
    expect(Date.now() - t1).toBeLessThan(40)
  })
})
