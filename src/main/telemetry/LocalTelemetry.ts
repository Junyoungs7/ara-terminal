// FB-0008: 로컬 셸 리소스 게이지. RemoteTelemetry.ts(SSH /proc 폴링)와 같은 폴링 주기·표시 형식으로
// 로컬 세션에도 CPU%/메모리를 낸다. Node os 모듈만 쓴다(새 의존성 금지) — CPU 는 os.cpus() 스냅샷
// 차분(원격과 동일 계산, cpuPctOf 재사용), 메모리는 os.totalmem()/freemem().
// GPU: Windows 에 신뢰성 있는 무의존 조회 방법이 없다(원격처럼 nvidia-smi 를 부르는 것은 "외부 명령
// 강제 실행"이라 로컬에서는 하지 않기로 함) — 생략. gaugesOf() 는 gpuPct 가 없으면 그 칸을 그대로 뺀다.
import * as os from 'node:os'
import type { RemoteStats } from '@shared/types'
import { cpuPctOf, type CpuSample } from './RemoteTelemetry'

const POLL_MS = 2500 // RemoteTelemetry.POLL_MS 와 동일(표시 형식 통일 요구사항).

// ── 순수 함수(픽스처 단위 테스트 대상) ──

// os.cpus() 원자료 → 누적 total/idle. RemoteTelemetry 의 CpuSample 과 같은 모양이라 cpuPctOf() 를 그대로 쓴다.
export function cpuSampleOf(cpus: os.CpuInfo[]): CpuSample {
  let total = 0
  let idle = 0
  for (const c of cpus) {
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    idle += c.times.idle
  }
  return { total, idle }
}

// 바이트 단위 총/가용 메모리 → RemoteStats 의 kB 필드. freeBytes 가 totalBytes 를 넘는 등의 이상치도
// 사용량이 음수가 되지 않게 방어한다(0 분할·상한 없음 — 값 자체가 항상 0 이상인 os 값이라 상한은 불필요).
export function memStatsOf(totalBytes: number, freeBytes: number): { memTotalKb: number; memUsedKb: number } {
  const memTotalKb = Math.round(totalBytes / 1024)
  const memUsedKb = Math.max(0, memTotalKb - Math.round(freeBytes / 1024))
  return { memTotalKb, memUsedKb }
}

// ── 폴링 서비스 ──

export type LocalTelemetryService = {
  start(sessionId: string): void
  stop(sessionId: string): void
  stopAll(): void
  activeCount(): number
}

export function createLocalTelemetryService(
  emit: (sessionId: string, stats: RemoteStats) => void,
  intervalMs: number = POLL_MS
): LocalTelemetryService {
  const subs = new Map<string, { timer: NodeJS.Timeout; prev: CpuSample | null }>()

  function tick(sessionId: string): void {
    const sub = subs.get(sessionId)
    if (!sub) return
    const cur = cpuSampleOf(os.cpus())
    emit(sessionId, { cpuPct: cpuPctOf(cur, sub.prev), ...memStatsOf(os.totalmem(), os.freemem()) })
    sub.prev = cur
  }

  function stop(sessionId: string): void {
    const sub = subs.get(sessionId)
    if (!sub) return
    clearInterval(sub.timer)
    subs.delete(sessionId)
  }

  return {
    start(sessionId) {
      if (subs.has(sessionId)) return
      subs.set(sessionId, { timer: setInterval(() => tick(sessionId), intervalMs), prev: null })
      tick(sessionId) // 첫 화면을 주기만큼 기다리지 않게(RemoteTelemetry 관행과 동일).
    },
    stop,
    stopAll() {
      for (const id of [...subs.keys()]) stop(id)
    },
    activeCount: () => subs.size
  }
}
