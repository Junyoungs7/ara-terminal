// 출처: stablyai/orca src/main/hang-watchdog/main-thread-hang-watchdog-entry.ts@7a7f46f8a3 (MIT)
// FD-02 워커 진입점 — main 의 worker thread 에서 돈다(5-3 배치표). electron-vite 가 out/main/hangWatchdogWorker.js 로 낸다.
// 관찰만 한다: 오탐이 살아 있는 main 을 쓰는 도중에 죽여서는 안 된다.
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  createHangWatchdogDetectionLoop,
  isHangWatchdogWorkerData,
  writeHangDetectionMarker,
  type HangWatchdogWorkerData,
  type MainToHangWatchdogWorkerMessage
} from './hangDetection'

function record(config: HangWatchdogWorkerData, unresponsiveMs: number, selfRecovered: boolean): void {
  try {
    writeHangDetectionMarker(config.markerPath, { detectedAt: Date.now(), parentPid: config.parentPid, unresponsiveMs, selfRecovered })
  } catch {
    // 진단 기록 실패로 감시자를 끝내지 않는다.
  }
}

function runWatchdog(config: HangWatchdogWorkerData): void {
  const port = parentPort
  if (!port) return
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (ms) => record(config, ms, false),
    // 한 멈춤 = 표식 하나. 풀리면 같은 표식을 고쳐 쓴다.
    onHangResolved: (ms) => record(config, ms, true)
  })
  const timer = setInterval(() => loop.tick(), config.checkIntervalMs)
  port.on('message', (m: MainToHangWatchdogWorkerMessage) => {
    if (m.type === 'heartbeat') loop.recordHeartbeat()
    else if (m.type === 'shutdown') {
      clearInterval(timer)
      port.close()
    }
  })
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) runWatchdog(workerData)
