// M0 0-6·0-8 — 멈춤 감시(FD-02)·진단 프로브(FD-03)·렌더러 복구·안전 그래픽(FD-04)·utility 헬퍼의 순수 로직.
// Orca(7a7f46f8a3) 의 동거 시험을 줄여 옮긴 것 + 아라 쪽(시험 훅·utilityHost) 판정.
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmpdir() }, dialog: {}, utilityProcess: {} }))
const logged = vi.hoisted(() => [] as string[])
vi.mock('../src/main/log/MainErrorLog', () => ({ logMainError: (scope: string) => void logged.push(scope) }))

import { consumeHangDetectionMarker, createHangWatchdogDetectionLoop, hangDetectionMarkerPath, writeHangDetectionMarker } from '../src/main/stability/hangDetection'
import { RecoveryCircuitBreaker } from '../src/main/stability/recoveryBreaker'
import {
  applyGpuFallbackCommandLineSwitches,
  engageGpuFallbackAfterCrashBurst,
  GPU_FALLBACK_MARKER_FILE,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEngagementHandlers
} from '../src/main/stability/gpuFallbackPolicy'
import {
  delayMs,
  eventLoopDelayProbeStatus,
  isEventLoopDelayProbeEnabled,
  setEventLoopDelayProbe,
  startEventLoopDelayProbe
} from '../src/main/stability/eventLoopProbe'
import {
  devTiming,
  HANG_REPORT_FILE,
  installRendererRecovery,
  RENDERER_GONE_EVENT_SCOPE,
  RENDERER_GONE_WATCHDOG_SCOPE,
  RENDERER_LIVENESS_INTERVAL_MS,
  reportPreviousHang,
  shouldRunHangWatchdog,
  testBlockMainMs
} from '../src/main/stability/stability'
import { startUtilityHost, type UtilityChild } from '../src/main/stability/utilityHost'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ara-stability-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('FD-02 멈춤 판정 루프', () => {
  const T = 45_000
  const C = 5_000
  function loop() {
    let now = 0
    const detected = vi.fn()
    const resolved = vi.fn()
    const l = createHangWatchdogDetectionLoop({ timeoutMs: T, checkIntervalMs: C, now: () => now, onHangDetected: detected, onHangResolved: resolved })
    return { l, detected, resolved, advance: (ms: number) => (now += ms) }
  }

  it('맥박이 오는 동안은 울리지 않는다', () => {
    const { l, detected, advance } = loop()
    for (let i = 0; i < 100; i++) {
      advance(C)
      l.recordHeartbeat()
      l.tick()
    }
    expect(detected).not.toHaveBeenCalled()
  })

  it('타임아웃을 넘으면 한 번만, 잰 시간으로 울린다. 경계값은 넘은 게 아니다', () => {
    const { l, detected, advance } = loop()
    l.recordHeartbeat()
    for (let i = 0; i < 9; i++) {
      advance(C)
      l.tick()
    }
    expect(detected).not.toHaveBeenCalled()
    for (let i = 0; i < 4; i++) {
      advance(C)
      l.tick()
    }
    expect(detected).toHaveBeenCalledTimes(1)
    expect(detected).toHaveBeenCalledWith(50_000)
  })

  it('큰 틈은 절전으로 보고 다시 센다', () => {
    const { l, detected, advance } = loop()
    l.recordHeartbeat()
    advance(T * 4)
    l.tick()
    for (let i = 0; i < 9; i++) {
      advance(C)
      l.tick()
    }
    expect(detected).not.toHaveBeenCalled()
  })

  it('감지 뒤 맥박이 돌아오면 회복을 알리고, 다음 멈춤도 잡는다', () => {
    const { l, detected, resolved, advance } = loop()
    l.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(C)
      l.tick()
    }
    advance(C)
    l.recordHeartbeat()
    expect(resolved).toHaveBeenCalledWith(13 * C)
    for (let i = 0; i < 12; i++) {
      advance(C)
      l.tick()
    }
    expect(detected).toHaveBeenCalledTimes(2)
  })
})

describe('FD-02 표식·보고 파일', () => {
  it('왕복하고 소비하면 지운다. 깨진 표식은 null 로 지운다', () => {
    const p = hangDetectionMarkerPath(dir)
    const m = { detectedAt: 1, parentPid: 2, unresponsiveMs: 45_000, selfRecovered: true }
    writeHangDetectionMarker(p, m)
    expect(consumeHangDetectionMarker(p)).toEqual(m)
    expect(existsSync(p)).toBe(false)
    expect(consumeHangDetectionMarker(p)).toBeNull()
    writeFileSync(p, 'not json')
    expect(consumeHangDetectionMarker(p)).toBeNull()
    expect(existsSync(p)).toBe(false)
  })

  it('selfRecovered 가 없으면 안 풀린 멈춤이다', () => {
    const p = hangDetectionMarkerPath(dir)
    writeFileSync(p, JSON.stringify({ detectedAt: 1, parentPid: 2, unresponsiveMs: 1 }))
    expect(consumeHangDetectionMarker(p)?.selfRecovered).toBe(false)
  })

  it('다음 실행: 표식을 로그 폴더의 hang-report.ndjson 한 줄로 옮긴다', () => {
    const logs = join(dir, 'logs')
    expect(reportPreviousHang(dir, logs)).toBeNull()
    expect(existsSync(join(logs, HANG_REPORT_FILE))).toBe(false)
    writeHangDetectionMarker(hangDetectionMarkerPath(dir), { detectedAt: 1000, parentPid: 42, unresponsiveMs: 5_100, selfRecovered: true })
    expect(reportPreviousHang(dir, logs)?.parentPid).toBe(42)
    const line = JSON.parse(readFileSync(join(logs, HANG_REPORT_FILE), 'utf8').trim())
    expect(line).toMatchObject({ previousPid: 42, unresponsiveMs: 5_100, selfRecovered: true })
    expect(existsSync(hangDetectionMarkerPath(dir))).toBe(false)
  })
})

describe('시험용 훅 — 배포본에서는 무시', () => {
  it('main 막기 스위치는 isPackaged 면 null', () => {
    const env = { ARA_TEST_BLOCK_MAIN_MS: '5000' }
    expect(testBlockMainMs(true, env)).toBeNull()
    expect(testBlockMainMs(false, env)).toEqual({ blockMs: 5000, afterMs: 3000 })
    expect(testBlockMainMs(false, { ...env, ARA_TEST_BLOCK_MAIN_AFTER_MS: '0' })).toEqual({ blockMs: 5000, afterMs: 0 })
    expect(testBlockMainMs(false, {})).toBeNull()
    expect(testBlockMainMs(false, { ARA_TEST_BLOCK_MAIN_MS: 'abc' })).toBeNull()
  })

  it('감시 타이밍 env 도 배포본은 기본값, 감시는 배포본이면 늘 켠다', () => {
    expect(devTiming(true, '2000', 45_000)).toBe(45_000)
    expect(devTiming(false, '2000', 45_000)).toBe(2000)
    expect(devTiming(false, '-1', 45_000)).toBe(45_000)
    expect(shouldRunHangWatchdog(true, {})).toBe(true)
    expect(shouldRunHangWatchdog(false, {})).toBe(false)
    expect(shouldRunHangWatchdog(false, { ARA_HANG_WATCHDOG_FORCE: '1' })).toBe(true)
  })
})

describe('FD-03 진단 프로브', () => {
  it('기본 꺼짐 — env 가 1 일 때만 켜진다', () => {
    expect(isEventLoopDelayProbeEnabled({})).toBe(false)
    expect(startEventLoopDelayProbe(() => dir, {})).toBeNull()
    expect(isEventLoopDelayProbeEnabled({ ARA_EVENT_LOOP_PROBE: '1' })).toBe(true)
    const stop = startEventLoopDelayProbe(() => dir, { ARA_EVENT_LOOP_PROBE: '1' })
    expect(stop).toBeTypeOf('function')
    stop?.()
  })

  it('실행 중에 켜고 끈다 — 두 번 켜도 하나, 끄면 최근 값도 지운다', () => {
    expect(eventLoopDelayProbeStatus()).toEqual({ on: false, last: null })
    const a = setEventLoopDelayProbe(true, () => dir)
    expect(setEventLoopDelayProbe(true, () => dir)).toBe(a)
    expect(eventLoopDelayProbeStatus().on).toBe(true)
    expect(setEventLoopDelayProbe(false, () => dir)).toBeNull()
    expect(eventLoopDelayProbeStatus()).toEqual({ on: false, last: null })
  })

  it('표본 간격(10ms)을 뺀 값이 지연이다', () => {
    expect(delayMs(10e6)).toBe(0)
    expect(delayMs(5e6)).toBe(0)
    expect(delayMs(35.555e6)).toBe(25.56)
  })
})

describe('FD-04 렌더러 복구 차단기', () => {
  it('한도까지 허용하고 막는다. 창이 지나면 다시 연다. reset 은 지운다', () => {
    const b = new RecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 3 })
    expect(b.registerRecoveryAttempt(0).allowed).toBe(true)
    expect(b.registerRecoveryAttempt(1_000).allowed).toBe(true)
    expect(b.registerRecoveryAttempt(2_000)).toEqual({ allowed: true, recentRecoveryCount: 3 })
    expect(b.registerRecoveryAttempt(3_000)).toEqual({ allowed: false, recentRecoveryCount: 3 })
    expect(b.recentRecoveryCount(60_500)).toBe(2)
    expect(b.registerRecoveryAttempt(62_001).allowed).toBe(true)
    b.reset()
    expect(b.recentRecoveryCount(62_002)).toBe(0)
  })
})

describe('FD-04 GPU 크래시 → 안전 그래픽', () => {
  it('창 안 문턱에서 한 번만 걸린다. 창 밖으로 나간 크래시는 안 센다', () => {
    const t = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    for (const at of [0, 29_531, 55_136, 74_178]) expect(t.recordGpuCrash(at).shouldEngageFallback).toBe(false)
    const u = new GpuCrashFallbackTracker({ windowMs: 30_000, threshold: 3 })
    u.recordGpuCrash(0)
    u.recordGpuCrash(15_000)
    expect(u.recordGpuCrash(30_000)).toEqual({ shouldEngageFallback: true, crashesInWindow: 3 })
    expect(u.recordGpuCrash(30_100).shouldEngageFallback).toBe(false)
    expect(u.recordGpuCrash(Number.NaN).shouldEngageFallback).toBe(false)
  })

  it('Windows GPU 자식의 크래시 모양 종료만 센다', () => {
    expect(isGpuFallbackCrashCandidate({ platform: 'win32', processType: 'GPU', reason: 'crashed' })).toBe(true)
    expect(isGpuFallbackCrashCandidate({ platform: 'win32', processType: 'GPU', reason: 'clean-exit' })).toBe(false)
    expect(isGpuFallbackCrashCandidate({ platform: 'win32', processType: 'Utility', reason: 'crashed' })).toBe(false)
    expect(isGpuFallbackCrashCandidate({ platform: 'linux', processType: 'GPU', reason: 'crashed' })).toBe(false)
  })

  it('표식은 그 빌드에만 붙는다 — 버전이 바뀌면 지운다', () => {
    const env = { appVersion: '2.2.0', electronVersion: '31.3.1', platform: 'win32' as const }
    writeGpuFallbackMarker(dir, { engagedAt: 1, crashesInWindow: 3, userConfirmed: true }, env)
    expect(readActiveGpuFallbackMarker(dir, env)?.userConfirmed).toBe(true)
    expect(readActiveGpuFallbackMarker(dir, { ...env, appVersion: '2.2.1' })).toBeNull()
    expect(existsSync(join(dir, GPU_FALLBACK_MARKER_FILE))).toBe(false)
    writeFileSync(join(dir, GPU_FALLBACK_MARKER_FILE), '{"schemeVersion":1}')
    expect(readActiveGpuFallbackMarker(dir, env)).toBeNull()
    expect(existsSync(join(dir, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('스위치는 Windows 에서만 단다', () => {
    const appended: string[] = []
    applyGpuFallbackCommandLineSwitches({ appendSwitch: (n) => appended.push(n) }, 'win32')
    expect(appended).toEqual(['disable-gpu', 'disable-software-rasterizer', 'in-process-gpu'])
    expect(applyGpuFallbackCommandLineSwitches({ appendSwitch: () => {} }, 'darwin')).toEqual([])
  })

  function handlers(over: Partial<GpuFallbackEngagementHandlers> = {}) {
    const order: string[] = []
    const h: GpuFallbackEngagementHandlers = {
      isQuitting: () => false,
      persistMarker: vi.fn(() => (order.push('persist'), true)),
      confirmMarker: vi.fn(() => void order.push('confirm')),
      clearMarker: vi.fn(() => void order.push('clear')),
      promptForRestart: vi.fn(async () => (order.push('prompt'), 'restart' as const)),
      onPromptFailed: vi.fn(),
      onEngaged: vi.fn(),
      onRestartDeferred: vi.fn(() => void order.push('deferred')),
      restartIntoSafeGraphics: vi.fn(() => void order.push('restart')),
      ...over
    }
    return { h, order }
  }
  const E = { reason: 'crashed', exitCode: -2147483645, crashesInWindow: 3, engagedAt: 1 }

  it('묻기 전에 적고, 받아들이면 확정 후 다시 시작한다', async () => {
    const { h, order } = handlers()
    await engageGpuFallbackAfterCrashBurst(E, h)
    expect(order).toEqual(['persist', 'prompt', 'confirm', 'restart'])
  })

  it('[계속 사용]은 표식을 지운다. 묻기 실패는 표식을 남긴다. 못 적었으면 다시 시작하지 않는다', async () => {
    const a = handlers({ promptForRestart: vi.fn(async () => 'continue' as const) })
    await engageGpuFallbackAfterCrashBurst(E, a.h)
    expect(a.order).toEqual(['persist', 'clear', 'deferred'])
    const b = handlers({ promptForRestart: vi.fn(async () => Promise.reject(new Error('no display'))) })
    await engageGpuFallbackAfterCrashBurst(E, b.h)
    expect(b.h.clearMarker).not.toHaveBeenCalled()
    expect(b.h.onPromptFailed).toHaveBeenCalled()
    const c = handlers({ persistMarker: vi.fn(() => false) })
    await engageGpuFallbackAfterCrashBurst(E, c.h)
    expect(c.h.restartIntoSafeGraphics).not.toHaveBeenCalled()
  })
})

describe('0-6 utilityHost — 시작·메시지·재시작 한도·종료', () => {
  class FakeChild extends EventEmitter implements UtilityChild {
    sent: unknown[] = []
    killed = false
    postMessage(m: unknown): void {
      this.sent.push(m)
    }
    kill(): boolean {
      this.killed = true
      this.emit('exit', 1)
      return true
    }
  }
  function host(maxRestarts = 2) {
    const children: FakeChild[] = []
    let now = 0
    const onMessage = vi.fn()
    const onGiveUp = vi.fn()
    const h = startUtilityHost({
      modulePath: 'x.js',
      serviceName: 'test',
      maxRestarts,
      windowMs: 60_000,
      now: () => now,
      onMessage,
      onGiveUp,
      fork: () => {
        const c = new FakeChild()
        children.push(c)
        return c
      }
    })
    return { h, children, onMessage, onGiveUp, advance: (ms: number) => (now += ms) }
  }

  it('메시지를 주고받는다', () => {
    const { h, children, onMessage } = host()
    expect(h.post({ op: 'ping' })).toBe(true)
    expect(children[0].sent).toEqual([{ op: 'ping' }])
    children[0].emit('message', { op: 'pong' })
    expect(onMessage).toHaveBeenCalledWith({ op: 'pong' })
  })

  it('비정상 종료는 한도까지 다시 띄우고, 넘으면 포기를 알린다', () => {
    const { h, children, onGiveUp } = host(2)
    children[0].emit('exit', 3)
    children[1].emit('exit', 3)
    expect(children).toHaveLength(3)
    expect(h.restarts).toBe(2)
    children[2].emit('exit', 7)
    expect(children).toHaveLength(3)
    expect(onGiveUp).toHaveBeenCalledWith(7)
    expect(h.running).toBe(false)
    expect(h.post('x')).toBe(false)
  })

  it('창이 지나면 다시 띄울 수 있다. 정상 종료(0)는 다시 띄우지 않는다', () => {
    const a = host(1)
    a.children[0].emit('exit', 1)
    a.advance(61_000)
    a.children[1].emit('exit', 1)
    expect(a.children).toHaveLength(3)
    const b = host()
    b.children[0].emit('exit', 0)
    expect(b.children).toHaveLength(1)
  })

  it('stop 은 죽이고 다시 띄우지 않는다', () => {
    const { h, children } = host()
    h.stop()
    expect(children[0].killed).toBe(true)
    expect(children).toHaveLength(1)
    expect(h.running).toBe(false)
  })
})

// 시험 훅 — 배포본/비활성에서는 window 에 안 생기고, 켜면 지정 영역만 던질 표식이 선다.
import { crashArea, installTestCrash, shouldCrash, subscribeCrash } from '../src/renderer/testCrash'
describe('testCrash 훅', () => {
  it('꺼져 있으면 window 에 노출하지 않는다', () => {
    const w: { __araTestCrash?: unknown } = {}
    installTestCrash(false, w)
    installTestCrash(undefined, w)
    expect(w.__araTestCrash).toBeUndefined()
  })
  it('켜면 노출되고, 부른 영역만 표식·통지를 받는다', () => {
    const w: { __araTestCrash?: (a: string) => void } = {}
    installTestCrash(true, w)
    let hits = 0
    const off = subscribeCrash('sidebar', () => hits++)
    w.__araTestCrash!('sidebar')
    expect(shouldCrash('sidebar')).toBe(true)
    expect(shouldCrash('main')).toBe(false)
    expect(hits).toBe(1)
    off()
    crashArea('sidebar')
    expect(hits).toBe(1)
  })
})

// STAB-2판: render-process-gone 이 안 와도 감시가 복구한다. 이벤트·감시가 겹쳐도 다시 불러오기는 한 번.
describe('FD-04 렌더러 죽음 감시', () => {
  function fakeWindow() {
    const wc = Object.assign(new EventEmitter(), { crashed: false, pid: 100, reloads: 0 }) as EventEmitter & {
      crashed: boolean
      pid: number
      reloads: number
      isCrashed: () => boolean
      getOSProcessId: () => number
      reload: () => void
    }
    wc.isCrashed = () => wc.crashed
    wc.getOSProcessId = () => wc.pid
    wc.reload = () => {
      wc.reloads++
      wc.crashed = false
      wc.pid = 200
      alive.add(200)
    }
    const win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false })
    const alive = new Set([100])
    installRendererRecovery(win as never, () => false, (pid) => alive.has(pid))
    return { win, wc, alive }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    logged.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('살아 있는 동안은 아무것도 안 한다', () => {
    const { wc } = fakeWindow()
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 10)
    expect(wc.reloads).toBe(0)
    expect(logged).toEqual([])
  })

  it('이벤트 없이 프로세스가 사라지면 감시가 한 번 다시 불러온다', () => {
    const { wc, alive } = fakeWindow()
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS)
    alive.delete(100) // 죽었다, isCrashed 도 false, 이벤트도 없다(실측 모양)
    wc.pid = 0 // 죽은 뒤 pid 를 못 돌려줘도 마지막으로 본 pid 로 판정
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 10)
    expect(wc.reloads).toBe(1)
    expect(logged).toEqual([RENDERER_GONE_WATCHDOG_SCOPE])
  })

  it('isCrashed 만 서도 감시가 복구한다', () => {
    const { wc } = fakeWindow()
    wc.crashed = true
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 5)
    expect(wc.reloads).toBe(1)
  })

  it('이벤트가 오면 바로(250ms 뒤) 복구하고, 뒤이은 감시는 같은 죽음으로 본다', () => {
    const { wc, alive } = fakeWindow()
    alive.delete(100)
    wc.crashed = true
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    vi.advanceTimersByTime(300)
    expect(wc.reloads).toBe(1)
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 10)
    expect(wc.reloads).toBe(1)
    expect(logged).toEqual([RENDERER_GONE_EVENT_SCOPE])
  })

  it('감시가 먼저 복구한 뒤 늦게 온 이벤트는 다시 부르지 않는다', () => {
    const { wc, alive } = fakeWindow()
    alive.delete(100)
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS + 300)
    expect(wc.reloads).toBe(1)
    // 다시 불러오는 사이(새 렌더러 확인 전)에 온 이벤트
    wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 })
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS) // 새 렌더러(200) 확인 → pending 풀림
    // 새 렌더러가 산 뒤에 온 옛 이벤트
    wc.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 })
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 5)
    expect(wc.reloads).toBe(1)
    expect(logged).toEqual([RENDERER_GONE_WATCHDOG_SCOPE])
  })

  it('복구된 새 렌더러가 또 죽으면 다시 복구한다', () => {
    const { wc, alive } = fakeWindow()
    alive.delete(100)
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 3)
    expect(wc.reloads).toBe(1)
    alive.delete(200)
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 3)
    expect(wc.reloads).toBe(2)
  })

  it('응답 없음이면 바로 확인한다 — 살아서 멈춘 렌더러는 다시 부르지 않는다', () => {
    const { wc, alive } = fakeWindow()
    wc.emit('unresponsive')
    vi.advanceTimersByTime(300)
    expect(wc.reloads).toBe(0)
    alive.delete(100)
    wc.emit('unresponsive')
    vi.advanceTimersByTime(300)
    expect(wc.reloads).toBe(1)
  })

  it('창이 닫히면 감시를 멈춘다', () => {
    const { win, wc } = fakeWindow()
    win.emit('closed')
    wc.crashed = true
    vi.advanceTimersByTime(RENDERER_LIVENESS_INTERVAL_MS * 5)
    expect(wc.reloads).toBe(0)
  })
})
