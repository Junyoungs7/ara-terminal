// 출처: stablyai/orca src/main/crash-reporting/{gpu-crash-fallback-decision,gpu-fallback-engagement}.ts,
//       src/main/startup/{gpu-fallback-marker,gpu-fallback-switches}.ts@7a7f46f8a3 (MIT)
// FD-04 안전 그래픽 모드의 순수 부분 — GPU 크래시 판정·표식 파일·스위치·진행 순서. electron 을 import 하지 않는다.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 판정 ──
const GPU_FALLBACK_CRASH_REASONS = new Set(['abnormal-exit', 'crashed', 'launch-failed'])
export const DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS = 30_000
export const DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD = 3

export class GpuCrashFallbackTracker {
  private readonly windowMs: number
  private readonly threshold: number
  private readonly recentCrashes: number[] = []
  private engaged = false

  constructor(options: { windowMs: number; threshold: number }) {
    this.windowMs = options.windowMs
    this.threshold = options.threshold
  }

  /** 문턱을 넘을 때 한 번만 알린다 — disengage() 가 다시 무장시킨다. */
  recordGpuCrash(msSinceLaunch: number): { shouldEngageFallback: boolean; crashesInWindow: number } {
    if (this.engaged || !Number.isFinite(msSinceLaunch) || msSinceLaunch < 0) {
      return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
    }
    // 시계가 뒤로 가도 정렬을 지킨다.
    const at = Math.max(msSinceLaunch, this.recentCrashes.at(-1) ?? 0)
    this.recentCrashes.push(at)
    const cutoff = at - this.windowMs
    let stale = 0
    while (stale < this.recentCrashes.length && this.recentCrashes[stale] < cutoff) stale += 1
    this.recentCrashes.splice(0, stale)
    if (this.recentCrashes.length >= this.threshold) {
      this.engaged = true
      return { shouldEngageFallback: true, crashesInWindow: this.recentCrashes.length }
    }
    return { shouldEngageFallback: false, crashesInWindow: this.recentCrashes.length }
  }

  hasEngaged(): boolean {
    return this.engaged
  }

  disengage(): void {
    this.engaged = false
  }
}

export function isGpuFallbackCrashCandidate(a: { platform: NodeJS.Platform; processType: string | undefined; reason: string }): boolean {
  return a.platform === 'win32' && (a.processType ?? '').toLowerCase() === 'gpu' && GPU_FALLBACK_CRASH_REASONS.has(a.reason)
}

// ── 표식 파일(ready 전에 읽는다 — 그때는 설정 저장소가 없다) ──
export const GPU_FALLBACK_MARKER_FILE = 'gpu-fallback.json'
export const GPU_FALLBACK_SCHEME_VERSION = 3

export type GpuFallbackEnvironment = { appVersion: string; electronVersion: string; platform: NodeJS.Platform }

export type GpuFallbackMarker = {
  schemeVersion: number
  engagedAt: number
  crashesInWindow: number
  userConfirmed: boolean
  appVersion: string
  electronVersion: string
  platform: 'win32'
}

const markerPath = (userDataPath: string): string => join(userDataPath, GPU_FALLBACK_MARKER_FILE)

export function readGpuFallbackMarker(userDataPath: string): GpuFallbackMarker | null {
  try {
    const p = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<Record<keyof GpuFallbackMarker, unknown>>
    if (
      p.schemeVersion !== GPU_FALLBACK_SCHEME_VERSION ||
      typeof p.engagedAt !== 'number' ||
      !Number.isFinite(p.engagedAt) ||
      typeof p.crashesInWindow !== 'number' ||
      !Number.isFinite(p.crashesInWindow) ||
      typeof p.userConfirmed !== 'boolean' ||
      typeof p.appVersion !== 'string' ||
      typeof p.electronVersion !== 'string' ||
      p.platform !== 'win32'
    ) {
      return null
    }
    return {
      schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
      engagedAt: p.engagedAt,
      crashesInWindow: p.crashesInWindow,
      userConfirmed: p.userConfirmed,
      appVersion: p.appVersion,
      electronVersion: p.electronVersion,
      platform: 'win32'
    }
  } catch {
    return null
  }
}

export function writeGpuFallbackMarker(
  userDataPath: string,
  info: { engagedAt: number; crashesInWindow: number; userConfirmed: boolean },
  env: GpuFallbackEnvironment
): void {
  const marker: GpuFallbackMarker = {
    schemeVersion: GPU_FALLBACK_SCHEME_VERSION,
    ...info,
    appVersion: env.appVersion,
    electronVersion: env.electronVersion,
    platform: 'win32'
  }
  writeFileSync(markerPath(userDataPath), JSON.stringify(marker))
}

export function clearGpuFallbackMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // 다음 실행에 다시 검증된다.
  }
}

/** 크래시 난 그 빌드에만 붙는다 — 업데이트하면 하드웨어 가속을 다시 시도한다. */
export function readActiveGpuFallbackMarker(userDataPath: string, env: GpuFallbackEnvironment): GpuFallbackMarker | null {
  const marker = readGpuFallbackMarker(userDataPath)
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) clearGpuFallbackMarker(userDataPath)
    return null
  }
  if (env.platform !== 'win32' || marker.appVersion !== env.appVersion || marker.electronVersion !== env.electronVersion) {
    clearGpuFallbackMarker(userDataPath)
    return null
  }
  return marker
}

// ── 스위치 ── Windows 11 에서 disable-gpu 만으로는 GPU 자식이 남는다(Orca 주석). in-process-gpu 로 없앤다.
const GPU_FALLBACK_COMMAND_LINE_SWITCHES = ['disable-gpu', 'disable-software-rasterizer', 'in-process-gpu'] as const

export function applyGpuFallbackCommandLineSwitches(
  commandLine: { appendSwitch(name: string, value?: string): void },
  platform: NodeJS.Platform
): readonly string[] {
  const switches = platform === 'win32' ? GPU_FALLBACK_COMMAND_LINE_SWITCHES : []
  for (const name of switches) commandLine.appendSwitch(name)
  return switches
}

// ── 진행 순서 ──
export type GpuFallbackRestartDecision = 'restart' | 'continue'

export type GpuFallbackEngagement = { reason: string; exitCode: number | null; crashesInWindow: number; engagedAt: number }

export type GpuFallbackEngagementHandlers = {
  isQuitting: () => boolean
  /** 표식을 쓴다. 못 쓰면 false. */
  persistMarker: (e: GpuFallbackEngagement) => boolean
  confirmMarker: (e: GpuFallbackEngagement) => void
  clearMarker: () => void
  promptForRestart: () => Promise<GpuFallbackRestartDecision>
  onPromptFailed: (error: unknown) => void
  onEngaged: (e: GpuFallbackEngagement) => void
  onRestartDeferred: (e: GpuFallbackEngagement) => void
  restartIntoSafeGraphics: (e: GpuFallbackEngagement) => void
}

/** 묻기 전에 먼저 적는다 — 사용자가 답하기 전에 Chromium 이 죽을 수 있다. */
export async function engageGpuFallbackAfterCrashBurst(e: GpuFallbackEngagement, h: GpuFallbackEngagementHandlers): Promise<void> {
  h.onEngaged(e)
  const persisted = h.persistMarker(e)
  let decision: GpuFallbackRestartDecision
  try {
    decision = await h.promptForRestart()
  } catch (error) {
    // 묻지 못했으면 표식을 남긴다 — 다음 실행이 안전하다.
    h.onPromptFailed(error)
    return
  }
  if (h.isQuitting()) return
  if (decision !== 'restart') {
    if (persisted) h.clearMarker()
    h.onRestartDeferred(e)
    return
  }
  if (!persisted) return
  h.confirmMarker(e)
  h.restartIntoSafeGraphics(e)
}
