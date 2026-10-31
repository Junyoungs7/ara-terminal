// 0-6 utility process 헬퍼 — 무거운 일을 Electron `utilityProcess` 로 띄운다(5-3 배치표의 "utility process" 자리).
// 시작·종료·메시지, 그리고 비정상 종료 시 재시작 — 재시작은 FD-04 와 같은 차단기로 창 안 횟수를 묶는다(무한 재시작 금지).
// Orca 는 utilityProcess 를 쓰지 않아(7a7f46f8a3 grep 0) 옮긴 코드가 아니라 아라 것이다.
import { utilityProcess } from 'electron'
import { RecoveryCircuitBreaker } from './recoveryBreaker'

/** utilityProcess.fork 가 돌려주는 것 중 우리가 쓰는 만큼. 시험이 가짜를 끼운다. */
export type UtilityChild = {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

export type UtilityHostOptions = {
  modulePath: string
  serviceName: string
  args?: string[]
  onMessage?: (message: unknown) => void
  /** 재시작 한도를 넘어 포기했을 때(마지막 종료 코드). */
  onGiveUp?: (code: number) => void
  /** 재시작 정책 — 기본: 60초 안에 3번까지. */
  maxRestarts?: number
  windowMs?: number
  now?: () => number
  fork?: (modulePath: string, args: string[], options: { serviceName: string }) => UtilityChild
}

export type UtilityHost = {
  post(message: unknown): boolean
  stop(): void
  readonly running: boolean
  readonly restarts: number
}

export function startUtilityHost(o: UtilityHostOptions): UtilityHost {
  const fork = o.fork ?? ((p, a, opts) => utilityProcess.fork(p, a, opts) as unknown as UtilityChild)
  const now = o.now ?? Date.now
  const breaker = new RecoveryCircuitBreaker({ windowMs: o.windowMs ?? 60_000, maxRecoveries: o.maxRestarts ?? 3 })
  let child: UtilityChild | null = null
  let stopped = false
  let restarts = 0

  const spawn = (): void => {
    const c = fork(o.modulePath, o.args ?? [], { serviceName: o.serviceName })
    child = c
    c.on('message', (m) => o.onMessage?.(m))
    c.on('exit', (code) => {
      if (child !== c) return
      child = null
      // 우리가 멈췄거나 정상 종료(0)면 다시 띄우지 않는다.
      if (stopped || code === 0) return
      if (!breaker.registerRecoveryAttempt(now()).allowed) {
        o.onGiveUp?.(code)
        return
      }
      restarts++
      spawn()
    })
  }
  spawn()

  return {
    post(message) {
      if (!child) return false
      child.postMessage(message)
      return true
    },
    stop() {
      stopped = true
      child?.kill()
      child = null
    },
    get running() {
      return child !== null
    },
    get restarts() {
      return restarts
    }
  }
}
