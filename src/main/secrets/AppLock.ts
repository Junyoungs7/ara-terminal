// 2.0 앱 잠금 — 상태 기계 + 잠금 층 SecretStore (설계: agent_talk/PLAN-v2-lock.md · v2-lock-impl-task.md).
//
// 상태는 main 의 **이 객체 하나**가 쥔다: off / locked-startup / unlocked / locked.
//   · 앱을 켰는데 lock.json 에 감싼 DK 가 있으면 locked-startup — DK 가 없으니 비밀값을 **못 읽는다**(던진다).
//   · 실행 중 잠금(locked)은 화면·입력만 막는다. DK 는 메모리에 남아 세션 재연결이 그대로 된다(윈도우 잠금처럼).
//
// 🔴 데이터 유실 금지 — 순서가 안전장치다:
//   · 켜기 = lock.json 먼저 → vault. 그 사이 꺼지면 "잠금 켬 + 평문 값"이 남는데, 평문 값은 그대로 읽히고
//     다음 풀기 때 sweep 이 봉한다. 반대 순서였다면 "봉한 값 + DK 없음" = 영구 유실이다.
//   · 끄기 = vault(평문으로) 먼저 → lock.json. 같은 이유.
//   · 분실 초기화 = vault 비우기 먼저 → 새 DK. 그 사이 꺼지면 다시 분실 흐름을 타면 된다.
// 🔴 비밀번호·DK·OTP 비밀을 로그·예외 문구에 싣지 않는다.
import type { SecretStore } from './SecretStore'
import { deriveKek, isSealed, KDF_DEFAULT, newDataKey, newKdf, openValue, sealValue, unwrapDk, wrapDk, type KdfParams, type Wrapped } from './lockCrypto'
import { newTotpSecret, otpauthUri, verifyTotp } from './totp'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { lockShortcutProblem } from '@shared/keymap'
import {
  AUTO_LOCK_OPTIONS,
  DEFAULT_LOCK_SHORTCUT,
  LOCK_MAX_FAILS,
  LOCK_MIN_PASSWORD,
  LOCK_WAIT_MS,
  type LockResult,
  type LockStateName,
  type LockView
} from '@shared/lock'

/** SafeStorageSecretStore 가 이 모양이다(시험은 메모리 가짜를 넘긴다). */
export type RawVault = SecretStore & { keys(): string[]; setMany(next: Record<string, string | null>): void }
/** OTP 비밀은 잠금 층 **밖**(safeStorage 만)이다 — 비밀번호를 잊었을 때 써야 하므로. */
export type Protect = { enc(s: string): string; dec(s: string): string }

type LockFile = {
  v: 1
  key?: { kdf: KdfParams; dk: Wrapped; changedAt: number }
  otp?: string
  mcpWhileLocked?: boolean
  autoLockMin?: number
  shortcut?: string
}

export type LockPrefs = { mcpWhileLocked?: boolean; autoLockMin?: number; shortcut?: string }

const RESET_WINDOW_MS = 5 * 60_000

export class LockedError extends Error {
  constructor() {
    super('아라가 잠겨 있어 저장된 비밀을 읽을 수 없습니다.')
  }
}

export class AppLock {
  private file: LockFile
  private st: LockStateName
  private dk: Buffer | null = null
  private tries = { pw: { fails: 0, until: 0 }, otp: { fails: 0, until: 0 } }
  private pendingOtp: string | null = null
  private resetUntil = 0
  private onChange: () => void = () => {}

  constructor(
    private readonly path: string,
    private readonly vault: RawVault,
    private readonly protect: Protect,
    private readonly opts: { kdf?: { N: number; r: number; p: number }; now?: () => number } = {}
  ) {
    cleanupTemp(path)
    this.file = readJsonWithBackup<LockFile>(path, { v: 1 })
    this.st = this.file.key ? 'locked-startup' : 'off'
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  setOnChange(fn: () => void): void {
    this.onChange = fn
  }

  state(): LockStateName {
    return this.st
  }

  /** 잠긴 동안 외부 도구(MCP)를 막나. 켤 때 잠금(DK 없음)은 스위치와 무관하게 막는다. */
  mcpBlocked(): boolean {
    return this.st === 'locked-startup' || (this.st === 'locked' && this.file.mcpWhileLocked !== true)
  }

  autoLockMin(): number {
    return this.file.key ? (this.file.autoLockMin ?? 0) : 0
  }

  /** lock.json 은 고칠 수 있다 — 셸 키(Ctrl+L 등)가 들어 있으면 main 이 그 키를 셸에서 빼앗게 되므로 기본 키로. */
  shortcut(): string {
    const s = this.file.shortcut
    return s && lockShortcutProblem(s) === null ? s : DEFAULT_LOCK_SHORTCUT
  }

  view(sessions: number): LockView {
    const t = this.now()
    return {
      state: this.st,
      otp: !!this.file.otp,
      mcpWhileLocked: this.file.mcpWhileLocked === true,
      autoLockMin: this.file.autoLockMin ?? 0,
      shortcut: this.shortcut(),
      changedAt: this.file.key?.changedAt ?? null,
      sessions,
      waitMs: { pw: Math.max(0, this.tries.pw.until - t), otp: Math.max(0, this.tries.otp.until - t) }
    }
  }

  // ── 잠금 층 SecretStore ─────────────────────────────────────────────────────
  // 호출자(ProfileStore·AraSession·MCP·araMcp)는 이 객체를 SecretStore 로만 본다 — 고칠 곳이 index.ts 한 줄이다.
  readonly store: SecretStore = {
    get: (key) => {
      const raw = this.vault.get(key)
      if (raw === null) return null
      if (isSealed(raw)) {
        if (!this.dk) throw new LockedError()
        return openValue(this.dk, key, raw)
      }
      // 잠금은 켰는데 아직 안 봉한 값(켜기 도중 꺼진 흔적) — 풀기 전엔 이것도 내주지 않는다.
      if (this.file.key && !this.dk) throw new LockedError()
      return raw
    },
    set: (key, value) => {
      if (!this.file.key) return this.vault.set(key, value)
      if (!this.dk) throw new LockedError()
      this.vault.set(key, sealValue(this.dk, key, value))
    },
    delete: (key) => this.vault.delete(key),
    has: (key) => this.vault.has(key)
  }

  // ── 틀린 시도 지연 ─────────────────────────────────────────────────────────
  private waiting(kind: 'pw' | 'otp'): number {
    return Math.max(0, this.tries[kind].until - this.now())
  }

  private fail(kind: 'pw' | 'otp'): LockResult {
    const t = this.tries[kind]
    t.fails++
    if (t.fails >= LOCK_MAX_FAILS) {
      t.fails = 0
      t.until = this.now() + LOCK_WAIT_MS
      return { ok: false, reason: 'wait', waitMs: LOCK_WAIT_MS }
    }
    return { ok: false, reason: 'wrong' }
  }

  private async openDk(password: string): Promise<Buffer | null> {
    const key = this.file.key
    if (!key) return null
    try {
      return unwrapDk(await deriveKek(password, key.kdf), key.dk)
    } catch {
      return null // 범위 밖 kdf(고친 파일) 등 — 틀린 것으로 다룬다
    }
  }

  /** 비밀번호를 확인하고 DK 를 돌려준다. 틀림·대기는 LockResult 로. */
  private async check(password: string): Promise<{ dk: Buffer } | LockResult> {
    const w = this.waiting('pw')
    if (w > 0) return { ok: false, reason: 'wait', waitMs: w }
    const dk = await this.openDk(password)
    if (!dk) return this.fail('pw')
    this.tries.pw = { fails: 0, until: 0 }
    return { dk }
  }

  private writeFile(next: LockFile): void {
    // 두 번 쓴다 — `.bak` 에 옛 감싼 DK(=옛 비밀번호로 풀리는 것)가 남지 않게(SafeStorageSecretStore.setMany 와 같은 이유).
    writeJsonAtomic(this.path, next)
    this.file = next
    writeJsonAtomic(this.path, next)
  }

  private async newKey(password: string, dk: Buffer): Promise<NonNullable<LockFile['key']>> {
    const kdf = newKdf(this.opts.kdf ?? KDF_DEFAULT)
    return { kdf, dk: wrapDk(await deriveKek(password, kdf), dk), changedAt: this.now() }
  }

  private set(next: LockStateName): void {
    this.st = next
    this.onChange()
  }

  // ── 잠그기·풀기 ───────────────────────────────────────────────────────────
  lock(): boolean {
    if (this.st !== 'unlocked') return false
    this.set('locked')
    return true
  }

  async unlock(password: string): Promise<LockResult> {
    if (this.st !== 'locked' && this.st !== 'locked-startup') return { ok: false, reason: 'state' }
    const r = await this.check(password)
    if (!('dk' in r)) {
      this.onChange() // 대기 시간을 모든 창에 알린다
      return r
    }
    this.dk = r.dk
    this.sweep()
    this.set('unlocked')
    return { ok: true }
  }

  /** 켜기 도중 꺼진 흔적(안 봉한 값)을 봉한다. 실패해도 값은 그대로 읽히므로 치명적이지 않다. */
  private sweep(): void {
    const dk = this.dk
    if (!dk) return
    const next: Record<string, string> = {}
    for (const k of this.vault.keys()) {
      const raw = this.vault.get(k)
      if (raw !== null && !isSealed(raw)) next[k] = sealValue(dk, k, raw)
    }
    if (Object.keys(next).length === 0) return
    try {
      this.vault.setMany(next)
    } catch {
      /* 다음 풀기 때 다시 한다 */
    }
  }

  // ── 켜기·끄기·바꾸기 ───────────────────────────────────────────────────────
  async enable(password: string): Promise<LockResult> {
    if (this.st !== 'off') return { ok: false, reason: 'state' }
    if (password.length < LOCK_MIN_PASSWORD) return { ok: false, reason: 'weak' }
    // 먼저 전부 읽는다 — 하나라도 못 읽으면(이미 봉한 값·safeStorage 실패) 아무것도 쓰기 전에 멈춘다.
    const plain: Record<string, string> = {}
    for (const k of this.vault.keys()) {
      const v = this.vault.get(k)
      if (v === null) continue
      if (isSealed(v)) throw new Error('lock: 이미 잠금으로 봉한 값이 있어 켤 수 없습니다(lock.json 이 없어졌을 수 있다)')
      plain[k] = v
    }
    const dk = newDataKey()
    const prev = this.file
    this.writeFile({ ...prev, key: await this.newKey(password, dk) })
    try {
      const sealed: Record<string, string> = {}
      for (const [k, v] of Object.entries(plain)) sealed[k] = sealValue(dk, k, v)
      this.vault.setMany(sealed)
    } catch (e) {
      // 원상복구 — vault 는 setMany 가 전부-아니면-아무것도라 그대로다. lock.json 만 되돌린다.
      this.writeFile(prev)
      dk.fill(0)
      throw e
    }
    this.dk = dk
    this.set('unlocked')
    return { ok: true }
  }

  async disable(password: string): Promise<LockResult> {
    if (this.st !== 'unlocked' || !this.dk) return { ok: false, reason: 'state' }
    const r = await this.check(password)
    if (!('dk' in r)) return r
    const plain: Record<string, string> = {}
    for (const k of this.vault.keys()) {
      const raw = this.vault.get(k)
      if (raw !== null && isSealed(raw)) plain[k] = openValue(r.dk, k, raw) // 하나라도 못 풀면 던진다 — 아무것도 안 바뀐다
    }
    this.vault.setMany(plain)
    const rest = { ...this.file }
    delete rest.key
    this.writeFile(rest)
    this.dk.fill(0)
    this.dk = null
    this.set('off')
    return { ok: true }
  }

  async change(oldPassword: string, newPassword: string): Promise<LockResult> {
    if (this.st !== 'unlocked' || !this.dk) return { ok: false, reason: 'state' }
    if (newPassword.length < LOCK_MIN_PASSWORD) return { ok: false, reason: 'weak' }
    const r = await this.check(oldPassword)
    if (!('dk' in r)) return r
    // DK 는 그대로 — 감싸기만 다시 한다(vault 를 안 건드린다).
    this.writeFile({ ...this.file, key: await this.newKey(newPassword, this.dk) })
    this.onChange()
    return { ok: true }
  }

  setPrefs(p: LockPrefs): LockResult {
    if (this.st !== 'off' && this.st !== 'unlocked') return { ok: false, reason: 'state' }
    const next = { ...this.file }
    if (typeof p.mcpWhileLocked === 'boolean') next.mcpWhileLocked = p.mcpWhileLocked
    if (typeof p.autoLockMin === 'number' && (AUTO_LOCK_OPTIONS as readonly number[]).includes(p.autoLockMin)) {
      next.autoLockMin = p.autoLockMin
    }
    if (typeof p.shortcut === 'string' && p.shortcut.length <= 32) next.shortcut = p.shortcut
    this.writeFile(next)
    this.onChange()
    return { ok: true }
  }

  // ── 구글 OTP ───────────────────────────────────────────────────────────────
  /** 등록 시작 — 새 비밀을 만들어 보여 준다. 확인 코드가 맞을 때까지 저장하지 않는다. */
  otpBegin(): { secret: string; uri: string } | null {
    if (this.st !== 'unlocked') return null
    this.pendingOtp = newTotpSecret()
    return { secret: this.pendingOtp, uri: otpauthUri(this.pendingOtp) }
  }

  otpConfirm(code: string): LockResult {
    if (this.st !== 'unlocked' || !this.pendingOtp) return { ok: false, reason: 'state' }
    const w = this.waiting('otp')
    if (w > 0) return { ok: false, reason: 'wait', waitMs: w }
    if (!verifyTotp(this.pendingOtp, code, Math.floor(this.now() / 1000))) return this.fail('otp')
    this.tries.otp = { fails: 0, until: 0 }
    this.writeFile({ ...this.file, otp: this.protect.enc(this.pendingOtp) })
    this.pendingOtp = null
    this.onChange()
    return { ok: true }
  }

  // ── 비밀번호 분실(A안) — OTP 확인 → 저장된 비밀값 삭제 → 새 비밀번호 ─────────────
  forgotVerify(code: string): LockResult {
    if (this.st !== 'locked' && this.st !== 'locked-startup') return { ok: false, reason: 'state' }
    if (!this.file.otp) return { ok: false, reason: 'noOtp' }
    const w = this.waiting('otp')
    if (w > 0) return { ok: false, reason: 'wait', waitMs: w }
    let secret: string
    try {
      secret = this.protect.dec(this.file.otp)
    } catch {
      return { ok: false, reason: 'noOtp' } // 다른 PC·계정으로 옮긴 파일 — safeStorage 가 못 푼다
    }
    if (!verifyTotp(secret, code, Math.floor(this.now() / 1000))) {
      const r = this.fail('otp')
      this.onChange()
      return r
    }
    this.tries.otp = { fails: 0, until: 0 }
    this.resetUntil = this.now() + RESET_WINDOW_MS
    return { ok: true }
  }

  /** 반환 removed = 지운 비밀값 수. 서버 목록·설정·기록은 vault 밖이라 그대로다. */
  async forgotReset(newPassword: string): Promise<LockResult & { removed?: number }> {
    if (this.st !== 'locked' && this.st !== 'locked-startup') return { ok: false, reason: 'state' }
    if (this.resetUntil <= this.now()) return { ok: false, reason: 'expired' }
    if (newPassword.length < LOCK_MIN_PASSWORD) return { ok: false, reason: 'weak' }
    const keys = this.vault.keys()
    // 순서: 비밀값 삭제 먼저 → 새 DK. (머리 주석)
    this.vault.setMany(Object.fromEntries(keys.map((k) => [k, null])))
    const dk = newDataKey()
    this.writeFile({ ...this.file, key: await this.newKey(newPassword, dk) })
    this.dk?.fill(0)
    this.dk = dk
    this.resetUntil = 0
    this.tries.pw = { fails: 0, until: 0 }
    this.set('unlocked')
    return { ok: true, removed: keys.length }
  }
}
