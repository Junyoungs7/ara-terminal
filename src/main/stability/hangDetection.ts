// 출처: stablyai/orca src/main/hang-watchdog/{hang-detection-marker,hang-watchdog-detection-loop,hang-watchdog-worker-protocol}.ts@7a7f46f8a3 (MIT)
// FD-02 멈춤 감시의 순수 부분 — 판정 루프·표식 파일·워커 약속. electron 을 import 하지 않는다(워커와 시험이 같이 쓴다).
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS = 2_000
export const HANG_WATCHDOG_TIMEOUT_MS = 45_000
export const HANG_WATCHDOG_CHECK_INTERVAL_MS = 5_000

export type HangWatchdogWorkerData = {
  parentPid: number
  markerPath: string
  timeoutMs: number
  checkIntervalMs: number
}

export type MainToHangWatchdogWorkerMessage = { type: 'heartbeat' } | { type: 'shutdown' }

// 다음 실행이 소비한다. selfRecovered 는 "멈췄다 풀렸다"와 "끝내 안 풀렸다"를 가른다.
export type HangDetectionMarker = {
  detectedAt: number
  parentPid: number
  unresponsiveMs: number
  selfRecovered: boolean
}

export function hangDetectionMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'main-thread-hang.json')
}

export function writeHangDetectionMarker(markerPath: string, marker: HangDetectionMarker): void {
  writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 })
}

// undefined = 지금 못 읽음(다음 실행에 다시 본다), null = 읽었는데 쓸모없음(지운다).
function readAvailableHangDetectionMarker(markerPath: string): HangDetectionMarker | null | undefined {
  let raw: string
  try {
    if (statSync(markerPath).size > 64 * 1024) return null
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof HangDetectionMarker, unknown>> | null
    if (
      typeof p !== 'object' ||
      !p ||
      typeof p.detectedAt !== 'number' ||
      !Number.isFinite(p.detectedAt) ||
      typeof p.parentPid !== 'number' ||
      !Number.isInteger(p.parentPid) ||
      p.parentPid <= 0 ||
      typeof p.unresponsiveMs !== 'number' ||
      !Number.isFinite(p.unresponsiveMs) ||
      p.unresponsiveMs < 0
    ) {
      return null
    }
    // 회복 증거가 없으면 안 풀린 멈춤으로 본다.
    return { detectedAt: p.detectedAt, parentPid: p.parentPid, unresponsiveMs: p.unresponsiveMs, selfRecovered: p.selfRecovered === true }
  } catch {
    return null
  }
}

export function consumeHangDetectionMarker(markerPath: string): HangDetectionMarker | null {
  const marker = readAvailableHangDetectionMarker(markerPath)
  if (marker === undefined) return null
  try {
    rmSync(markerPath, { force: true })
  } catch {
    // 못 지우면 보고가 한 번 겹칠 뿐 — 부팅을 막지 않는다.
  }
  return marker
}

export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** 감지 뒤 맥박이 돌아왔다 — 교착이 아니라 일시 멈춤이었다. */
  onHangResolved: (unresponsiveMs: number) => void
}

export type HangWatchdogDetectionLoop = { recordHeartbeat: () => void; tick: () => void }

export function createHangWatchdogDetectionLoop(config: HangWatchdogDetectionLoopConfig): HangWatchdogDetectionLoop {
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let detected = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      if (detected) {
        detected = false
        config.onHangResolved(now - lastHeartbeatAt)
      }
      lastHeartbeatAt = now
    },
    tick: () => {
      const now = config.now()
      const tickGap = now - lastTickAt
      // 멈춘 동안에도 전진시켜, 회복을 "긴 절전 틈"으로 잘못 읽지 않게 한다.
      lastTickAt = now
      if (detected) return
      // 절전은 감시자도 멈춘다 — 틈이 크면 침묵 창을 다시 시작한다.
      if (tickGap > config.checkIntervalMs * 3) {
        lastHeartbeatAt = now
        return
      }
      const unresponsiveMs = now - lastHeartbeatAt
      if (unresponsiveMs > config.timeoutMs) {
        detected = true
        config.onHangDetected(unresponsiveMs)
      }
    }
  }
}

export function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  const d = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!d &&
    Number.isInteger(d.parentPid) &&
    (d.parentPid ?? 0) > 0 &&
    typeof d.markerPath === 'string' &&
    Number.isFinite(d.timeoutMs) &&
    (d.timeoutMs ?? 0) > 0 &&
    Number.isFinite(d.checkIntervalMs) &&
    (d.checkIntervalMs ?? 0) > 0
  )
}
