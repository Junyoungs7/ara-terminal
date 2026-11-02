// 출처: stablyai/orca src/main/hang-watchdog/{main-thread-hang-watchdog,previous-hang-detection}.ts,
//       src/main/crash-reporting/gpu-fallback-restart-prompt.ts, src/main/window/renderer-recovery-prompt.ts@7a7f46f8a3 (MIT)
// M0 0-8 의 electron 연결부 — FD-02 멈춤 감시·FD-04 렌더러 복구·안전 그래픽 모드. 판정은 순수 모듈(hangDetection·
// recoveryBreaker·gpuFallbackPolicy)에 있고 여기는 이벤트를 잇기만 한다. index.ts 는 이 파일의 함수만 부른다.
//
// Orca 와 다른 점: 멈춤 감시는 macOS 한정·관측 동의 조건을 뺐다(아라는 Windows 가 주 대상, 기록은 로컬 파일뿐).
// 렌더러 복구 창은 Orca 의 진단(설치 폴더 ACL·메모리 부족·로드 정체 감시)을 빼고 [다시 불러오기]/[종료]만 남겼다.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import ko from '../../renderer/i18n/ko.json'
import { logMainError } from '../log/MainErrorLog'

// main 대화상자 문구도 렌더러 ko.json 한 벌에서 읽는다(appMenu.ts 와 같은 방식) — scan-i18n 이 여기 t() 호출의 키도 검사한다.
const t = (key: string): string => (ko as Record<string, string>)[key] ?? key
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath,
  HANG_WATCHDOG_CHECK_INTERVAL_MS,
  HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS,
  HANG_WATCHDOG_TIMEOUT_MS,
  type HangDetectionMarker,
  type HangWatchdogWorkerData,
  type MainToHangWatchdogWorkerMessage
} from './hangDetection'
import { DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES, DEFAULT_RENDERER_RECOVERY_WINDOW_MS, RecoveryCircuitBreaker } from './recoveryBreaker'
import {
  applyGpuFallbackCommandLineSwitches,
  clearGpuFallbackMarker,
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  engageGpuFallbackAfterCrashBurst,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
  type GpuFallbackMarker
} from './gpuFallbackPolicy'

export const HANG_REPORT_FILE = 'hang-report.ndjson'

// ───────── FD-02 멈춤 감시 ─────────

/**
 * 지난 실행이 남긴 표식을 소비해 앱 로그 폴더의 hang-report.ndjson 에 한 줄 남긴다.
 * **감시 워커를 띄우기 전에** 부른다 — 새 워커가 같은 표식 파일을 덮어쓰기 전에 읽어야 한다.
 * 감시가 꺼진 실행에서도 부른다(지난 실행은 켜져 있었을 수 있다).
 */
export function reportPreviousHang(userData: string, logDir: string): HangDetectionMarker | null {
  const marker = consumeHangDetectionMarker(hangDetectionMarkerPath(userData))
  if (!marker) return null
  try {
    mkdirSync(logDir, { recursive: true })
    const line = { reportedAt: new Date().toISOString(), detectedAt: new Date(marker.detectedAt).toISOString(), previousPid: marker.parentPid, unresponsiveMs: marker.unresponsiveMs, selfRecovered: marker.selfRecovered }
    appendFileSync(join(logDir, HANG_REPORT_FILE), `${JSON.stringify(line)}\n`)
  } catch (e) {
    logMainError('hang-report', e)
  }
  return marker
}

/** 시험 빌드에서만 env 숫자를 받는다. 배포본(isPackaged)은 언제나 기본값. */
export function devTiming(isPackaged: boolean, value: string | undefined, fallback: number): number {
  if (isPackaged) return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 감시를 켤까 — 배포본은 늘 켠다. 개발 실행은 디버거 일시정지가 정상이라 `ARA_HANG_WATCHDOG_FORCE=1` 일 때만. */
export function shouldRunHangWatchdog(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return isPackaged || env['ARA_HANG_WATCHDOG_FORCE'] === '1'
}

export function installHangWatchdog(userData: string): { stop: () => void } | null {
  if (!shouldRunHangWatchdog(app.isPackaged, process.env)) return null
  const workerData: HangWatchdogWorkerData = {
    parentPid: process.pid,
    markerPath: hangDetectionMarkerPath(userData),
    timeoutMs: devTiming(app.isPackaged, process.env['ARA_HANG_WATCHDOG_TIMEOUT_MS'], HANG_WATCHDOG_TIMEOUT_MS),
    checkIntervalMs: devTiming(app.isPackaged, process.env['ARA_HANG_WATCHDOG_CHECK_INTERVAL_MS'], HANG_WATCHDOG_CHECK_INTERVAL_MS)
  }
  let worker: Worker
  try {
    worker = new Worker(join(__dirname, 'hangWatchdogWorker.js'), { name: 'ara-main-thread-hang-watchdog', workerData })
  } catch (e) {
    logMainError('hang-watchdog start', e)
    return null
  }
  let stopped = false
  const post = (m: MainToHangWatchdogWorkerMessage): void => {
    if (stopped && m.type === 'heartbeat') return
    try {
      worker.postMessage(m)
    } catch {
      /* 워커가 이미 끝났다 */
    }
  }
  const heartbeat = setInterval(() => post({ type: 'heartbeat' }), HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS)
  const stop = (): void => {
    if (stopped) return
    stopped = true
    app.off('will-quit', stop)
    clearInterval(heartbeat)
    post({ type: 'shutdown' })
  }
  worker.on('error', (e) => {
    logMainError('hang-watchdog worker', e)
    stop()
  })
  worker.once('exit', () => {
    stopped = true
    app.off('will-quit', stop)
    clearInterval(heartbeat)
  })
  worker.unref()
  app.on('will-quit', stop)
  return { stop }
}

/**
 * 시험용 훅 — main 을 N ms 막는다(e2e: 멈춤 감시가 잡는지).
 * `ARA_TEST_BLOCK_MAIN_MS=<ms>` (+ 선택 `ARA_TEST_BLOCK_MAIN_AFTER_MS`, 기본 3000 — 감시가 맥박을 받기 시작한 뒤).
 * 🔴 **배포본에서는 무시된다** — `app.isPackaged` 가 참이면 0 을 돌려준다(index.ts 의 ARA_PERF_INJECT_DELAY_MS 와 같은 선).
 */
export function testBlockMainMs(isPackaged: boolean, env: NodeJS.ProcessEnv): { blockMs: number; afterMs: number } | null {
  if (isPackaged) return null
  const blockMs = Number(env['ARA_TEST_BLOCK_MAIN_MS'])
  if (!Number.isFinite(blockMs) || blockMs <= 0) return null
  const after = Number(env['ARA_TEST_BLOCK_MAIN_AFTER_MS'])
  return { blockMs, afterMs: Number.isFinite(after) && after >= 0 ? after : 3_000 }
}

export function scheduleTestMainBlock(): void {
  const plan = testBlockMainMs(app.isPackaged, process.env)
  if (!plan) return
  setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, plan.blockMs), plan.afterMs)
}

// ───────── FD-04 렌더러 복구 ─────────

const rendererRecoveryPrompt = (): MessageBoxOptions => ({
  type: 'error',
  buttons: [t('rendererRecovery.reload'), t('rendererRecovery.quit')],
  defaultId: 0,
  // Esc 는 다시 시도 — 세션을 날리지 않는다.
  cancelId: 0,
  title: t('rendererRecovery.title'),
  message: t('rendererRecovery.message'),
  detail: t('rendererRecovery.detail')
})

/** 렌더러가 죽으면 다시 불러온다. 60초 안 3번을 넘으면 자동은 멈추고 사용자에게 묻는다(창은 한 번에 하나). */
const RENDERER_RELOAD_DELAY_MS = 250
/**
 * STAB-2판: 죽음 감시 주기. Electron 43 에서 렌더러가 실제로 죽었는데 render-process-gone 이 40초 넘게 안 오는 일이
 * 간헐로 있었다(2026-11-02 STAB-1 진단 — fcrGone:false·pidAliveAtEnd:false·loads:0). 이벤트 하나에만 기대지 않고
 * main 이 주기적으로 본다. 한 번 = isCrashed() + getOSProcessId() + OpenProcess 한 번(process.kill(pid, 0)) —
 * 마이크로초 단위라 2초마다 돌아도 유휴 CPU 에 안 잡힌다. getAppMetrics(모든 자식 순회)는 쓰지 않는다.
 */
export const RENDERER_LIVENESS_INTERVAL_MS = 2_000

/** 복구가 어느 길로 시작됐나 — main-error.log 에 이 이름으로 남는다(e2e STAB-1 이 읽는다). */
export const RENDERER_GONE_EVENT_SCOPE = 'render-process-gone'
export const RENDERER_GONE_WATCHDOG_SCOPE = 'render-process-gone-watchdog'

/** pid 가 아직 살아 있나. 신호 0 = 존재 확인만(Windows: OpenProcess + GetExitCodeProcess). EPERM 은 있다는 뜻. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function installRendererRecovery(win: BrowserWindow, isQuitting: () => boolean, pidAlive: (pid: number) => boolean = isPidAlive): void {
  const breaker = new RecoveryCircuitBreaker({ windowMs: DEFAULT_RENDERER_RECOVERY_WINDOW_MS, maxRecoveries: DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES })
  let prompting = false
  // 복구를 걸었고 새 렌더러가 아직 확인되지 않았다 — 이 사이에 오는 이벤트·감시는 같은 죽음이다(두 번 부르지 않는다).
  let pending = false
  // 복구를 건 죽은 렌더러의 pid. 새 렌더러는 이것과 다른 살아 있는 pid 로 확인한다.
  let deadPid = 0
  // 마지막으로 본 렌더러 pid — 죽은 뒤 getOSProcessId 가 0 을 돌려줘도 그 pid 로 확인한다.
  let lastPid = 0
  const wc = win.webContents
  // 🔴 render-process-gone 처리기 **안에서 바로** reload 하면 Electron 40 에서 Chromium 이
  // "Observers can only be added once!"(NOTREACHED)로 앱째 죽는다(2026-11-01 실측, ME-1 E3). Orca 도 타이머 뒤에
  // 다시 불러온다(createMainWindow-recovery-reload-watchdog.test.ts 가 250ms 를 흘려 보낸다) — 같은 값으로 미룬다.
  const reload = (): void => {
    setTimeout(() => {
      if (!win.isDestroyed()) wc.reload()
    }, RENDERER_RELOAD_DELAY_MS)
  }
  /** 이벤트·감시가 같이 부르는 하나의 복구 경로. */
  const recover = (scope: string, why: string, pid: number): void => {
    if (pending || win.isDestroyed() || isQuitting()) return
    pending = true
    deadPid = pid
    lastPid = 0
    logMainError(scope, why)
    if (breaker.registerRecoveryAttempt(Date.now()).allowed) {
      reload()
      return
    }
    if (prompting) return
    prompting = true
    void dialog
      .showMessageBox(win, rendererRecoveryPrompt())
      .then(({ response }) => {
        if (isQuitting()) return
        if (response === 0) {
          breaker.reset()
          reload()
        } else app.quit()
      })
      .catch((e: unknown) => logMainError('renderer-recovery prompt', e))
      .finally(() => (prompting = false))
  }
  /** 지금 렌더러가 죽었나. 살아 있는 새 렌더러를 보면 pending 을 푼다. */
  const check = (): void => {
    if (win.isDestroyed() || isQuitting()) return
    const crashed = wc.isCrashed()
    const pid = wc.getOSProcessId() || lastPid
    const alive = pid > 0 && pidAlive(pid)
    if (pending) {
      if (!crashed && alive && pid !== deadPid) pending = false
      return
    }
    if (pid > 0 && alive) lastPid = pid
    if (crashed || (pid > 0 && !alive)) recover(RENDERER_GONE_WATCHDOG_SCOPE, `crashed=${crashed} pid=${pid} alive=${alive}`, pid)
  }
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || isQuitting()) return
    // 감시가 먼저 복구를 걸었고 새 렌더러가 이미 살아 있으면 이 이벤트는 늦게 온 옛 죽음이다.
    if (!pending && !wc.isCrashed()) {
      const pid = wc.getOSProcessId()
      if (pid > 0 && pid !== deadPid && pidAlive(pid)) return
    }
    recover(RENDERER_GONE_EVENT_SCOPE, `${details.reason} (exitCode ${details.exitCode})`, wc.getOSProcessId() || lastPid)
  })
  // 새 문서가 다 불러와졌으면 새 렌더러가 산 것이다.
  wc.on('did-finish-load', () => {
    if (pending && !wc.isCrashed()) pending = false
  })
  // 응답 없음 — 죽었는지 바로 한 번 본다. 살아서 멈춘 렌더러는 다시 부르지 않는다(Orca 도 본창 멈춤엔 자동 재로드가 없다).
  wc.on('unresponsive', check)
  const timer = setInterval(check, RENDERER_LIVENESS_INTERVAL_MS)
  timer.unref?.()
  win.on('closed', () => clearInterval(timer))
}

// ───────── FD-04 안전 그래픽 모드 ─────────

const gpuEnv = (): GpuFallbackEnvironment => ({ appVersion: app.getVersion(), electronVersion: process.versions.electron, platform: process.platform })

/** **ready 전에** 부른다. 표식이 살아 있으면 하드웨어 가속을 끄고 스위치를 단다. 켜졌으면 그 표식을 돌려준다. */
export function applySafeGraphicsIfMarked(userData: string): GpuFallbackMarker | null {
  const marker = readActiveGpuFallbackMarker(userData, gpuEnv())
  if (!marker) return null
  app.disableHardwareAcceleration()
  applyGpuFallbackCommandLineSwitches(app.commandLine, process.platform)
  return marker
}

/** GPU 자식이 30초 안 3번 죽으면 표식을 적고(다음 실행부터 가속 끔) 사용자에게 다시 시작을 묻는다. */
export function installGpuCrashFallback(userData: string, isQuitting: () => boolean, parent: () => BrowserWindow | null): void {
  const tracker = new GpuCrashFallbackTracker({ windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS, threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD })
  const write = (engagedAt: number, crashesInWindow: number, userConfirmed: boolean): void =>
    writeGpuFallbackMarker(userData, { engagedAt, crashesInWindow, userConfirmed }, gpuEnv())
  app.on('child-process-gone', (_e, d) => {
    if (!isGpuFallbackCrashCandidate({ platform: process.platform, processType: d.type, reason: d.reason })) return
    const r = tracker.recordGpuCrash(performance.now())
    if (!r.shouldEngageFallback) return
    void engageGpuFallbackAfterCrashBurst(
      { reason: d.reason, exitCode: d.exitCode ?? null, crashesInWindow: r.crashesInWindow, engagedAt: Date.now() },
      {
        isQuitting,
        persistMarker: (g) => {
          try {
            write(g.engagedAt, g.crashesInWindow, false)
            return true
          } catch (e) {
            logMainError('gpu-fallback marker', e)
            return false
          }
        },
        confirmMarker: (g) => {
          try {
            write(g.engagedAt, g.crashesInWindow, true)
          } catch (e) {
            logMainError('gpu-fallback confirm', e)
          }
        },
        clearMarker: () => clearGpuFallbackMarker(userData),
        promptForRestart: async () => {
          const options: MessageBoxOptions = {
            type: 'warning',
            buttons: [t('gpuFallback.restart'), t('gpuFallback.continue')],
            defaultId: 0,
            cancelId: 1,
            title: t('gpuFallback.title'),
            message: t('gpuFallback.message'),
            detail: t('gpuFallback.detail')
          }
          const w = parent()
          const { response } = w && !w.isDestroyed() ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options)
          return response === 0 ? 'restart' : 'continue'
        },
        onPromptFailed: (e) => logMainError('gpu-fallback prompt', e),
        onEngaged: (g) => logMainError('gpu-crash-burst', `${g.reason} ×${g.crashesInWindow} (exitCode ${g.exitCode})`),
        onRestartDeferred: () => tracker.disengage(),
        restartIntoSafeGraphics: () => {
          app.relaunch()
          app.quit()
        }
      }
    )
  })
}
