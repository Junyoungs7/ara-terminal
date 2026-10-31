// tests/perf-baseline.cjs 의 순수 부분 — 통계·허용폭·게이트 판정(Electron 없이).
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const perf = createRequire(import.meta.url)('./perf-baseline.cjs')

describe('perf-baseline 통계', () => {
  it('중앙값·MAD', () => {
    expect(perf.median([5, 1, 3])).toBe(3)
    expect(perf.median([4, 1, 3, 2])).toBe(2.5)
    expect(perf.mad([1, 2, 3, 4, 100])).toBe(1)
  })

  it('흩어짐이 작으면 바닥, 크면 3×MAD/중앙값', () => {
    expect(perf.summarize('startupMs', [1000, 1000, 1000, 1000, 1000]).tolerance).toBe(0.1)
    // MAD 100, 중앙값 1000 → 0.3
    expect(perf.summarize('startupMs', [800, 900, 1000, 1100, 1200]).tolerance).toBe(0.3)
  })

  it('CPU 는 %p — 바닥 1.0, 3×MAD', () => {
    expect(perf.summarize('idleCpuPct', [0.1, 0.2, 0.2, 0.3, 0.2]).tolerance).toBe(1)
    expect(perf.summarize('idleCpuPct', [1, 2, 3, 4, 5]).tolerance).toBe(3)
  })
})

describe('perf-baseline 게이트 판정', () => {
  const base = {
    startupMs: perf.summarize('startupMs', [1000, 1000, 1000]),
    idleMemMB: perf.summarize('idleMemMB', [400, 400, 400]),
    idleCpuPct: perf.summarize('idleCpuPct', [0.5, 0.5, 0.5]),
    workspaceMs: perf.summarize('workspaceMs', [2000, 2000, 2000])
  }

  it('상한 안이면 통과, 넘으면 그 지표만 실패', () => {
    const ok = perf.judge(base, { startupMs: 1100, idleMemMB: 420, idleCpuPct: 1.5, workspaceMs: 2200 })
    expect(ok.every((v: { ok: boolean }) => v.ok)).toBe(true)
    const bad = perf.judge(base, { startupMs: 1101, idleMemMB: 400, idleCpuPct: 1.6, workspaceMs: 2000 })
    expect(bad.filter((v: { ok: boolean }) => !v.ok).map((v: { metric: string }) => v.metric)).toEqual(['startupMs', 'idleCpuPct'])
  })

  it('양성 대조: 3초 지연은 켜는 시간·작업 공간을 넘긴다', () => {
    const v = perf.judge(base, { startupMs: 4000, idleMemMB: 400, idleCpuPct: 0.5, workspaceMs: 5000 })
    expect(v.filter((x: { ok: boolean }) => !x.ok).map((x: { metric: string }) => x.metric)).toEqual(['startupMs', 'workspaceMs'])
  })

  it('다른 PC 는 비교하지 않는다', () => {
    const m = { cpu: 'X', cores: 8, ramGB: 16, platform: 'win32', osRelease: '10.0.1' }
    expect(perf.sameMachine(m, { ...m, osRelease: '10.0.2' })).toBe(true)
    expect(perf.sameMachine(m, { ...m, ramGB: 32 })).toBe(false)
  })
})
