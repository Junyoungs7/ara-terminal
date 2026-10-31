// 출처: stablyai/orca src/main/diagnostics/event-loop-delay-probe.ts@7a7f46f8a3 (MIT)
// FD-03 진단 프로브 — main 이벤트 루프 지연(p50·p99·max)과 처리량(표본 수·이용률 ELU)을 1초 창마다 한 줄씩 남긴다.
// **기본 꺼짐.** `ARA_EVENT_LOOP_PROBE=1` 일 때만 켠다(배포본에서도 진단용으로 켤 수 있다 — 기록만 하고 동작을 바꾸지 않는다).
// 결과: 앱 로그 폴더의 event-loop-delay.ndjson.
// Orca 의 main-thread-churn-probe(자식 프로세스 생성 비용 집계)는 옮기지 않았다 — spawn 지점에 계측을 심어야 해서 S0 작업과 겹친다.
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export const EVENT_LOOP_DELAY_PROBE_ENV = 'ARA_EVENT_LOOP_PROBE'
export const EVENT_LOOP_DELAY_REPORT_FILE = 'event-loop-delay.ndjson'

const RESOLUTION_MS = 10
const REPORT_EVERY_MS = 1_000

export type EventLoopDelayWindow = {
  pid: number
  t: number
  windowMs: number
  /** 표본 간격을 뺀 지연(ms). */
  p50: number
  p99: number
  max: number
  samples: number
  /** 이벤트 루프 이용률 0~1 — 창 동안 얼마나 바빴나. */
  elu: number
}

export function isEventLoopDelayProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVENT_LOOP_DELAY_PROBE_ENV] === '1'
}

/** 히스토그램은 표본 사이 간격 전체를 기록한다 — 간격을 빼야 지연이다. */
export function delayMs(ns: number): number {
  return Math.round(Math.max(0, ns / 1e6 - RESOLUTION_MS) * 100) / 100
}

/** 켜졌으면 끄는 함수를, 꺼져 있으면 null 을 돌려준다. logDir 는 호출마다 읽는다(설정에서 폴더를 바꿀 수 있다). */
export function startEventLoopDelayProbe(logDir: () => string, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (!isEventLoopDelayProbeEnabled(env)) return null
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  let lastElu = performance.eventLoopUtilization()
  const timer = setInterval(() => {
    const elu = performance.eventLoopUtilization(lastElu)
    lastElu = performance.eventLoopUtilization()
    const report: EventLoopDelayWindow = {
      pid: process.pid,
      t: Date.now(),
      windowMs: REPORT_EVERY_MS,
      p50: delayMs(histogram.percentile(50)),
      p99: delayMs(histogram.percentile(99)),
      max: delayMs(histogram.max),
      samples: histogram.count,
      elu: Math.round(elu.utilization * 1000) / 1000
    }
    histogram.reset()
    appendFile(join(logDir(), EVENT_LOOP_DELAY_REPORT_FILE), `${JSON.stringify(report)}\n`).catch(() => {
      /* 진단 기록 실패로 앱을 흔들지 않는다 */
    })
  }, REPORT_EVERY_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    histogram.disable()
  }
}
