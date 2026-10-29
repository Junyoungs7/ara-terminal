// 2.0 앱 잠금 — main·preload·렌더러가 같이 보는 모양과 상수(설계: agent_talk/PLAN-v2-lock.md).

/**
 * off = 잠금 안 씀(지금과 같다) · locked-startup = 앱을 켰고 아직 안 풀었다(DK 없음 — 비밀값을 못 읽는다) ·
 * unlocked = 풀림 · locked = 실행 중 잠금(DK 는 메모리에 남아 세션 재연결이 된다).
 */
export type LockStateName = 'off' | 'locked-startup' | 'unlocked' | 'locked'

export type LockView = {
  state: LockStateName
  /** 구글 OTP 를 등록했나(분실 흐름을 열 수 있나). */
  otp: boolean
  mcpWhileLocked: boolean
  /** 0 = 자동 잠금 끔. */
  autoLockMin: number
  shortcut: string
  /** 비밀번호를 정하거나 바꾼 때(ms). 잠금을 안 쓰면 null. */
  changedAt: number | null
  /** 지금 열린 세션 수 — 잠금 화면의 "세션 N개 계속 동작 중". 이름·주소는 안 싣는다. */
  sessions: number
  /** 틀린 시도 대기가 남았으면 그 ms(0 = 바로 시도 가능). */
  waitMs: { pw: number; otp: number }
}

export type LockFail = 'wrong' | 'wait' | 'state' | 'weak' | 'noOtp' | 'expired'
export type LockResult = { ok: true } | { ok: false; reason: LockFail; waitMs?: number }

export const isLockedState = (s: LockStateName): boolean => s === 'locked' || s === 'locked-startup'

export const AUTO_LOCK_OPTIONS = [0, 5, 10, 15, 30, 60] as const
export const DEFAULT_LOCK_SHORTCUT = 'Ctrl+Alt+L'
/** 시안 L-forgot "8자 이상". */
export const LOCK_MIN_PASSWORD = 8
/** 5번 틀리면 30초 기다린다(비밀번호·OTP 각각, main 이 센다). */
export const LOCK_MAX_FAILS = 5
export const LOCK_WAIT_MS = 30_000
