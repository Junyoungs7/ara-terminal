import { describe, it, expect, vi } from 'vitest'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionSink, SessionSpec } from '../src/main/sessions/ISessionManager'
import type { Session } from '../src/shared/types'

// 실제 node-pty 셸을 스폰하는 통합성 단위 테스트. 짧은 명령을 실행해 라운드트립을 검증한다.
const isWin = process.platform === 'win32'
const echoSpec = (): SessionSpec => ({
  type: 'local',
  serverKey: 'localhost',
  title: 'test',
  profileId: null,
  cwd: undefined,
  // Windows는 cmd로 단발 실행(빠른 종료), 그 외는 sh.
  shell: isWin ? 'cmd.exe' : '/bin/sh'
})

function collect() {
  const chunks: Uint8Array[] = []
  const cwds: string[] = []
  const opened: Session[] = []
  let exited = false
  let exitCode = -1
  const sink: SessionSink = {
    data(_id, chunk) {
      chunks.push(chunk)
    },
    exit(_id, code) {
      exited = true
      exitCode = code
    },
    cwd(_id, cwd) {
      cwds.push(cwd)
    },
    opened(meta) {
      opened.push(meta)
    }
  }
  const text = () => Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  return { sink, chunks, cwds, opened, text, get exited() { return exited }, get exitCode() { return exitCode } }
}

const waitFor = async (pred: () => boolean, ms = 6000) => {
  const start = Date.now()
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20))
  if (!pred()) throw new Error('timeout waiting for condition')
}

describe('MainSessionManager (node-pty)', () => {
  it('세션 생성 → 명령 실행 → 한글 출력 라운드트립(에코) + 종료', async () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const id = await mgr.create(echoSpec())
    expect(typeof id).toBe('string')
    mgr.attach(id) // 출력은 attach 이후에 sink 로 흐른다(그 전 출력은 재생 버퍼에 보관).
    // 셸에 echo 명령 주입.
    mgr.write(id, 'echo 한글출력테스트\r')
    if (isWin) mgr.write(id, 'exit\r')
    else mgr.write(id, 'exit\n')
    await waitFor(() => c.exited)
    expect(c.text()).toContain('한글출력테스트')
    expect(c.exited).toBe(true)
    mgr.destroyAll()
  })

  it('sink.data는 Uint8Array를 전달한다(transferable 계약)', async () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const id = await mgr.create(echoSpec())
    mgr.attach(id)
    mgr.write(id, isWin ? 'echo x\rexit\r' : 'echo x\nexit\n')
    await waitFor(() => c.exited)
    expect(c.chunks.length).toBeGreaterThan(0)
    expect(c.chunks.every((ch) => ch instanceof Uint8Array)).toBe(true)
    mgr.destroyAll()
  })

  it('snapshot은 활성 세션을 반영하고 destroy 시 정리된다', async () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const id = await mgr.create(echoSpec())
    expect(mgr.snapshot().map((s) => s.id)).toContain(id)
    mgr.destroy(id)
    expect(mgr.snapshot().map((s) => s.id)).not.toContain(id)
  })

  it('pause/resume는 알 수 없는 id에도 예외를 던지지 않는다', () => {
    const mgr = new MainSessionManager(collect().sink)
    expect(() => mgr.pause('nope')).not.toThrow()
    expect(() => mgr.resume('nope')).not.toThrow()
    expect(() => mgr.resize('nope', 80, 24)).not.toThrow()
    expect(() => mgr.destroy('nope')).not.toThrow()
  })
})

// 배칭 로직: 대량 청크가 64KB 버짓 안에서 프레임 타이머로 병합되는지(fake timer).
describe('MainSessionManager 배칭(백프레셔 메커니즘 1)', () => {
  it('버짓 미만 다중 청크는 프레임 타이머 flush로 단일 배치 병합', async () => {
    vi.useFakeTimers()
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    // 스폰 없이 내부 enqueue 경로만 테스트하기 위해 create를 우회 — 실제 pty 대신 수동 주입.
    // create가 pty를 스폰하므로 여기서는 실제 셸을 안 쓰고 enqueue 동작만 확인한다.
    // (private 접근: 배칭 계약을 화이트박스 검증)
    const anyMgr = mgr as unknown as {
      handles: Map<string, { buf: Uint8Array[]; bufBytes: number; timer: NodeJS.Timeout | null }>
      enqueue: (id: string, data: string) => void
      flush: (id: string) => void
    }
    anyMgr.handles.set('t', { buf: [], bufBytes: 0, timer: null, backlog: [], backlogBytes: 0, attached: true } as never)
    anyMgr.enqueue('t', 'a')
    anyMgr.enqueue('t', 'b')
    anyMgr.enqueue('t', 'c')
    expect(c.chunks.length).toBe(0) // 아직 flush 전
    vi.advanceTimersByTime(20) // 16ms 프레임 경과
    expect(c.chunks.length).toBe(1) // 단일 배치로 병합
    expect(Buffer.from(c.chunks[0]).toString()).toBe('abc')
    vi.useRealTimers()
  })
})

// 재생 버퍼(R1.1): 세션 전환·재마운트로 xterm 이 새로 만들어져도 스크롤백을 되살릴 수 있어야 한다.
// attach 전 출력은 흘려보내지 않고 버퍼에만 쌓아 두었다가 attach 시 한 번에 돌려준다(초기 출력 유실 방지).
describe('MainSessionManager 재생 버퍼(attach)', () => {
  // 실제 pty 없이 enqueue/flush 경로만 쓰는 핸들을 심는다(배칭 테스트와 같은 화이트박스 방식).
  const seed = (mgr: MainSessionManager, id: string) => {
    const anyMgr = mgr as unknown as {
      handles: Map<string, unknown>
      enqueue: (id: string, data: string) => void
    }
    anyMgr.handles.set(id, { buf: [], bufBytes: 0, timer: null, backlog: [], backlogBytes: 0, attached: false } as never)
    return (data: string) => anyMgr.enqueue(id, data)
  }
  const text = (u: Uint8Array) => Buffer.from(u).toString('utf8')

  it('attach 전 출력은 sink 로 나가지 않고 attach 가 한 번에 돌려준다', () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const write = seed(mgr, 'a')
    write('접속 배너\r\n')
    write('$ ')
    expect(c.chunks.length).toBe(0) // 구독자 없음 — 유실 대신 보관
    expect(text(mgr.attach('a'))).toBe('접속 배너\r\n$ ')
  })

  it('attach 이후 출력은 라이브로 흐르고, 다시 attach 하면 전체를 재생한다', () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const write = seed(mgr, 'a')
    write('첫줄\r\n')
    mgr.attach('a')
    write('둘째줄\r\n')
    ;(mgr as unknown as { flush: (id: string) => void }).flush('a')
    expect(c.text()).toBe('둘째줄\r\n')
    // 세션 전환으로 xterm 을 새로 만든 경우 — 지금까지의 출력 전체를 되감아 준다.
    expect(text(mgr.attach('a'))).toBe('첫줄\r\n둘째줄\r\n')
  })

  it('재생 버퍼는 상한(256KB)을 넘지 않는다', () => {
    const mgr = new MainSessionManager(collect().sink)
    const write = seed(mgr, 'a')
    const chunk = 'x'.repeat(32 * 1024)
    for (let i = 0; i < 20; i++) write(chunk) // 640KB 주입
    const backlog = mgr.attach('a')
    expect(backlog.length).toBeLessThanOrEqual(256 * 1024)
    expect(backlog.length).toBeGreaterThan(128 * 1024) // 상한 근처까지는 보존
    // 최근 출력이 남는다(앞에서부터 버린다).
    expect(text(backlog).endsWith('x')).toBe(true)
  })

  it('없는 세션 attach 는 빈 버퍼(예외 없음)', () => {
    const mgr = new MainSessionManager(collect().sink)
    expect(mgr.attach('nope').length).toBe(0)
  })
})

// R2.1: 탭 이름은 main 의 meta 가 진실이다(persist 가 session:list 를 그대로 저장한다).
describe('세션 이름 (R2.1 rename · 중복 서버 구분)', () => {
  const seedMeta = (mgr: MainSessionManager, id: string, title: string, serverKey = 'dev') => {
    const anyMgr = mgr as unknown as { handles: Map<string, unknown> }
    anyMgr.handles.set(id, {
      buf: [], bufBytes: 0, timer: null, backlog: [], backlogBytes: 0, attached: false,
      meta: { id, type: 'ssh', profileId: 'p1', title, serverKey }
    } as never)
  }

  it('rename 이 snapshot 의 title 을 바꾼다(= 스냅샷에 저장되는 값)', () => {
    const mgr = new MainSessionManager(collect().sink)
    seedMeta(mgr, 'a', 'dev-server')
    mgr.rename('a', '결제 배포')
    expect(mgr.snapshot()[0].title).toBe('결제 배포')
  })

  it('빈 이름·없는 세션 rename 은 무시한다', () => {
    const mgr = new MainSessionManager(collect().sink)
    seedMeta(mgr, 'a', 'dev-server')
    mgr.rename('a', '')
    mgr.rename('nope', '아무개')
    expect(mgr.snapshot()[0].title).toBe('dev-server')
  })

  it('같은 서버 다중 세션은 ·2, ·3 으로 구분된다', () => {
    const mgr = new MainSessionManager(collect().sink)
    expect(mgr.nextTitle('dev-server')).toBe('dev-server')
    seedMeta(mgr, 'a', 'dev-server')
    expect(mgr.nextTitle('dev-server')).toBe('dev-server·2')
    seedMeta(mgr, 'b', 'dev-server·2')
    expect(mgr.nextTitle('dev-server')).toBe('dev-server·3')
  })

  it('닫힌 세션의 번호는 다시 쓴다(빈 자리 채움)', () => {
    const mgr = new MainSessionManager(collect().sink)
    seedMeta(mgr, 'a', 'dev-server')
    seedMeta(mgr, 'c', 'dev-server·3')
    expect(mgr.nextTitle('dev-server')).toBe('dev-server·2')
  })
})

/**
 * 2026-08-26 준영님 제보 — 아라가 MCP 로 SSH 에 붙였는데 화면에 탭이 안 떴다.
 *
 * 세션 생성 경로는 `register()` 하나로 모인다(로컬 create · SSH adopt 공통). 알림을 거기 두는
 * 이유가 그것이다 — 만드는 자리마다 알림을 흩으면 **다음에 생기는 경로**가 또 빠뜨린다.
 */
describe('세션이 생겼다는 알림(화면이 아는 유일한 길)', () => {
  it('★ create 가 sink.opened 로 메타를 통째로 알린다(id 만으로는 탭을 못 그린다)', async () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const id = await mgr.create(echoSpec())
    expect(c.opened).toHaveLength(1)
    expect(c.opened[0].id).toBe(id)
    expect(c.opened[0].title).toBe('test')
    expect(c.opened[0].serverKey).toBe('localhost')
    mgr.destroyAll()
  })

  it('★ adopt(SSH 가 지나는 길)도 같은 알림을 낸다', () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    // 붙은 백엔드를 흉내낸다 — 편입 경로만 보는 것이라 실제 소켓이 필요 없다.
    const backend = { onData() {}, onExit() {}, write() {}, resize() {}, pause() {}, resume() {}, kill() {} }
    const id = mgr.adopt(backend as never, {
      type: 'ssh',
      profileId: 'p1',
      title: 'KVT',
      serverKey: 'KVT',
      cwd: undefined,
      shell: undefined
    })
    expect(c.opened.map((m) => m.id)).toEqual([id])
    expect(c.opened[0].serverKey).toBe('KVT')
  })

  it('부른 창이 주인이다 — winId 를 주면 메타에 실려 나간다(안 주면 본창)', async () => {
    const c = collect()
    const mgr = new MainSessionManager(c.sink)
    const mine = await mgr.create({ ...echoSpec(), winId: 'w-7' })
    const main = await mgr.create(echoSpec())
    expect(c.opened.find((m) => m.id === mine)!.winId).toBe('w-7')
    expect(c.opened.find((m) => m.id === main)!.winId).toBeUndefined()
    mgr.destroyAll()
  })
})
