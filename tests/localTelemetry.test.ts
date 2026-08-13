// FB-0008 — 로컬 리소스 게이지 검증. cpuSampleOf/memStatsOf 는 순수 함수(픽스처로 검증), 폴링 수명은
// RemoteTelemetry 의 "폴링 수명" 테스트와 같은 패턴(구독 0 → 정지). os.cpus()/totalmem()/freemem() 은
// 실제 머신 값이라(모킹하지 않음) CPU%·메모리 총량은 "유효 범위 안"까지만 확인한다.
import { describe, it, expect } from 'vitest'
import type { CpuInfo } from 'node:os'
import { cpuSampleOf, memStatsOf, createLocalTelemetryService } from '../src/main/telemetry/LocalTelemetry'
import { cpuPctOf } from '../src/main/telemetry/RemoteTelemetry'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeCore(user: number, idle: number): CpuInfo {
  return { model: 'fake', speed: 1000, times: { user, nice: 0, sys: 0, idle, irq: 0 } }
}

describe('cpuSampleOf (os.cpus() → 누적 total/idle)', () => {
  it('여러 코어의 total/idle 을 합산한다', () => {
    const s = cpuSampleOf([fakeCore(100, 200), fakeCore(50, 300)])
    expect(s).toEqual({ total: 100 + 200 + 50 + 300, idle: 200 + 300 })
  })

  it('코어가 없으면 0', () => {
    expect(cpuSampleOf([])).toEqual({ total: 0, idle: 0 })
  })

  it('RemoteTelemetry 의 cpuPctOf 와 그대로 맞물린다(같은 CpuSample 모양)', () => {
    const prev = cpuSampleOf([fakeCore(1000, 9000)])
    const cur = cpuSampleOf([fakeCore(1200, 9000)]) // busy 만 200 늘고 idle 은 그대로
    expect(cpuPctOf(cur, prev)).toBe(100)
    expect(cpuPctOf(cur, null)).toBe(0) // 첫 바퀴 기준점 없음
  })
})

describe('memStatsOf (바이트 → kB)', () => {
  it('총량·사용량을 kB 로 환산한다', () => {
    const KB = 1024
    expect(memStatsOf(32 * 1024 * KB, 12 * 1024 * KB)).toEqual({ memTotalKb: 32 * 1024, memUsedKb: 20 * 1024 })
  })

  it('가용 메모리가 총량을 넘는 이상치도 사용량이 음수가 되지 않는다', () => {
    expect(memStatsOf(1000, 5000).memUsedKb).toBe(0)
  })
})

describe('createLocalTelemetryService (폴링 수명)', () => {
  it('start 는 즉시 한 바퀴(cpuPct=0, 기준점 없음) 돌고, stop 이후엔 멈춘다', async () => {
    const got: { sessionId: string; stats: { cpuPct: number; memTotalKb: number; memUsedKb: number } }[] = []
    const svc = createLocalTelemetryService((sessionId, stats) => got.push({ sessionId, stats }), 30)
    svc.start('s1')
    expect(got).toHaveLength(1)
    expect(got[0].stats.cpuPct).toBe(0) // 첫 바퀴는 diff 기준점이 없다
    expect(got[0].stats.memTotalKb).toBeGreaterThan(0)
    await wait(80)
    expect(got.length).toBeGreaterThan(1) // 폴러가 도는 중
    svc.stop('s1')
    const after = got.length
    await wait(80)
    expect(got.length).toBe(after) // stop 이후 더 안 온다
    expect(svc.activeCount()).toBe(0)
  })

  it('두 번째 바퀴부터는 cpuPct 가 0~100 범위의 유효값(실머신 값)', async () => {
    const got: number[] = []
    const svc = createLocalTelemetryService((_id, stats) => got.push(stats.cpuPct), 20)
    svc.start('s2')
    await wait(60)
    svc.stop('s2')
    for (const pct of got) {
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
  })

  it('같은 세션에 start 를 두 번 불러도 폴러는 하나(= 새로고침)', () => {
    const svc = createLocalTelemetryService(() => {}, 50)
    svc.start('s3')
    svc.start('s3')
    expect(svc.activeCount()).toBe(1)
    svc.stopAll()
    expect(svc.activeCount()).toBe(0)
  })
})
