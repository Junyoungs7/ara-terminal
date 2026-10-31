// 출처: stablyai/orca src/main/crash-reporting/renderer-recovery-circuit-breaker.ts@7a7f46f8a3 (MIT)
// FD-04 자동 재로드 횟수 제한. 0-6 utilityHost 의 재시작 정책도 같은 차단기를 쓴다.

export type RecoveryCircuitBreakerOptions = { windowMs: number; maxRecoveries: number }

export const DEFAULT_RENDERER_RECOVERY_WINDOW_MS = 60_000
export const DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES = 3

// 로드에 성공해도 기록을 지우지 않는다 — 크래시 루프는 매번 로드를 끝낼 수 있다.
export class RecoveryCircuitBreaker {
  private readonly windowMs: number
  private readonly maxRecoveries: number
  private attempts: number[] = []

  constructor(options: RecoveryCircuitBreakerOptions) {
    this.windowMs = options.windowMs
    this.maxRecoveries = options.maxRecoveries
  }

  recentRecoveryCount(now: number): number {
    this.pruneExpired(now)
    return this.attempts.length
  }

  /** 허용된 시도만 센다 — 거절된 시도가 창을 늘리지 않는다. */
  registerRecoveryAttempt(now: number): { allowed: boolean; recentRecoveryCount: number } {
    this.pruneExpired(now)
    if (this.attempts.length >= this.maxRecoveries) return { allowed: false, recentRecoveryCount: this.attempts.length }
    this.attempts.push(now)
    return { allowed: true, recentRecoveryCount: this.attempts.length }
  }

  /** 사용자가 직접 다시 불러오기를 눌렀을 때. */
  reset(): void {
    this.attempts = []
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs
    this.attempts = this.attempts.filter((t) => t > cutoff)
  }
}
