import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppLock, LockedError, type RawVault } from '../src/main/secrets/AppLock'
import { base32Decode, totpAt } from '../src/main/secrets/totp'
import { LOCK_WAIT_MS } from '../src/shared/lock'

// 메모리 vault — safeStorage 층은 SafeStorageSecretStore 의 몫(tests/secrets.test.ts)이라 여기선 통과로 둔다.
// setMany 는 실물처럼 전부-아니면-아무것도. failNext 로 디스크 쓰기 실패를 흉내 낸다.
function memVault(): RawVault & { raw: Map<string, string>; failNext: boolean } {
  const raw = new Map<string, string>()
  const v = {
    raw,
    failNext: false,
    get: (k: string) => raw.get(k) ?? null,
    set: (k: string, x: string) => void raw.set(k, x),
    delete: (k: string) => void raw.delete(k),
    has: (k: string) => raw.has(k),
    keys: () => [...raw.keys()],
    setMany(next: Record<string, string | null>) {
      if (v.failNext) {
        v.failNext = false
        throw new Error('디스크 쓰기 실패(시험)')
      }
      for (const [k, x] of Object.entries(next)) x === null ? raw.delete(k) : raw.set(k, x)
    }
  }
  return v
}

const protect = { enc: (s: string) => 'P:' + s, dec: (s: string) => s.replace(/^P:/, '') }
const KDF = { N: 2 ** 10, r: 8, p: 1 } // 시험 속도용 — 실물은 2^15
// 시험용 비밀번호(실제 같은 값 금지 규칙) — 길이만 맞춘 무의미한 문자열.
const PW1 = 'test-pass-one'
const PW2 = 'test-pass-two'

let dir: string
let lockPath: string
let now: number
const mk = (vault: RawVault) => new AppLock(lockPath, vault, protect, { kdf: KDF, now: () => now })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ara-lock-'))
  lockPath = join(dir, 'lock.json')
  now = 1_800_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AppLock', () => {
  it('기본은 off — 층이 그대로 통과한다(기존 사용자는 아무것도 안 바뀐다)', () => {
    const v = memVault()
    const l = mk(v)
    expect(l.state()).toBe('off')
    l.store.set('k', 'v1')
    expect(v.raw.get('k')).toBe('v1')
    expect(l.store.get('k')).toBe('v1')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('켜기 → 값이 봉해지고 lock.json 에 비밀번호·평문이 없다', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    expect(await l.enable(PW1)).toEqual({ ok: true })
    expect(l.state()).toBe('unlocked')
    expect(v.raw.get('srv-1')).not.toContain('server-secret-a')
    expect(l.store.get('srv-1')).toBe('server-secret-a')
    const file = readFileSync(lockPath, 'utf8')
    expect(file).not.toContain(PW1)
    expect(file).not.toContain('server-secret-a')
    // .bak 도 같은 내용(옛 상태가 남지 않는다)
    expect(readFileSync(lockPath + '.bak', 'utf8')).toBe(file)
    // 켠 뒤 새로 저장하는 값도 봉한다
    l.store.set('srv-2', 'server-secret-b')
    expect(v.raw.get('srv-2')).not.toContain('server-secret-b')
  })

  it('짧은 비밀번호는 거절', async () => {
    const l = mk(memVault())
    expect(await l.enable('short')).toEqual({ ok: false, reason: 'weak' })
    expect(l.state()).toBe('off')
  })

  it('다시 켜면 locked-startup — 풀기 전엔 비밀값을 못 읽는다', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    await mk(v).enable(PW1)
    const l = mk(v)
    expect(l.state()).toBe('locked-startup')
    expect(l.mcpBlocked()).toBe(true)
    expect(l.store.has('srv-1')).toBe(true)
    expect(() => l.store.get('srv-1')).toThrow(LockedError)
    expect(() => l.store.set('x', 'y')).toThrow(LockedError)
    expect(await l.unlock(PW2)).toEqual({ ok: false, reason: 'wrong' })
    expect(await l.unlock(PW1)).toEqual({ ok: true })
    expect(l.store.get('srv-1')).toBe('server-secret-a')
  })

  it('5회 틀리면 30초 대기 — 그 사이엔 맞는 비밀번호도 안 받는다', async () => {
    const v = memVault()
    await mk(v).enable(PW1)
    const l = mk(v)
    for (let i = 0; i < 4; i++) expect((await l.unlock(PW2)).ok).toBe(false)
    expect(await l.unlock(PW2)).toEqual({ ok: false, reason: 'wait', waitMs: LOCK_WAIT_MS })
    expect((await l.unlock(PW1)) as unknown).toMatchObject({ ok: false, reason: 'wait' })
    expect(l.view(0).waitMs.pw).toBe(LOCK_WAIT_MS)
    now += LOCK_WAIT_MS
    expect(await l.unlock(PW1)).toEqual({ ok: true })
  })

  it('실행 중 잠금 — DK 는 남아 세션 재연결이 된다. MCP 는 스위치대로', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    await l.enable(PW1)
    expect(l.lock()).toBe(true)
    expect(l.state()).toBe('locked')
    expect(l.store.get('srv-1')).toBe('server-secret-a')
    expect(l.mcpBlocked()).toBe(true)
    expect(l.setPrefs({ mcpWhileLocked: true })).toMatchObject({ ok: false, reason: 'state' })
    await l.unlock(PW1)
    l.setPrefs({ mcpWhileLocked: true, autoLockMin: 7 })
    expect(l.view(0).autoLockMin).toBe(0) // 목록 밖 값은 무시
    l.lock()
    expect(l.mcpBlocked()).toBe(false)
  })

  it('켜기 도중 vault 쓰기가 실패하면 원상복구 — 값은 평문 그대로, 잠금은 off', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    v.failNext = true
    await expect(l.enable(PW1)).rejects.toThrow()
    expect(l.state()).toBe('off')
    expect(l.store.get('srv-1')).toBe('server-secret-a')
    expect(readFileSync(lockPath, 'utf8')).not.toContain('"key"')
    expect(mk(v).state()).toBe('off')
  })

  it('끄기 → safeStorage 만으로 되돌림', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    await l.enable(PW1)
    expect(await l.disable(PW2)).toEqual({ ok: false, reason: 'wrong' })
    expect(await l.disable(PW1)).toEqual({ ok: true })
    expect(l.state()).toBe('off')
    expect(v.raw.get('srv-1')).toBe('server-secret-a')
    expect(mk(v).state()).toBe('off')
  })

  it('끄기 도중 vault 쓰기가 실패하면 아무것도 안 바뀐다', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    await l.enable(PW1)
    v.failNext = true
    await expect(l.disable(PW1)).rejects.toThrow()
    expect(l.state()).toBe('unlocked')
    const again = mk(v)
    expect(await again.unlock(PW1)).toEqual({ ok: true })
    expect(again.store.get('srv-1')).toBe('server-secret-a')
  })

  it('비밀번호 변경 — DK 다시 감싸기만, 값은 그대로', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    await l.enable(PW1)
    const sealedBefore = v.raw.get('srv-1')
    expect(await l.change(PW1, PW2)).toEqual({ ok: true })
    expect(v.raw.get('srv-1')).toBe(sealedBefore)
    const again = mk(v)
    expect((await again.unlock(PW1)).ok).toBe(false)
    expect(await again.unlock(PW2)).toEqual({ ok: true })
    expect(again.store.get('srv-1')).toBe('server-secret-a')
    // .bak 에 옛 비밀번호로 풀리는 감싼 DK 가 남지 않는다
    expect(readFileSync(lockPath + '.bak', 'utf8')).toBe(readFileSync(lockPath, 'utf8'))
  })

  it('암호문을 다른 키 자리로 옮기면 풀리지 않는다(AAD)', async () => {
    const v = memVault()
    v.raw.set('a', 'value-a')
    v.raw.set('b', 'value-b')
    const l = mk(v)
    await l.enable(PW1)
    v.raw.set('b', v.raw.get('a')!)
    expect(() => l.store.get('b')).toThrow()
  })

  it('켜기 도중 꺼진 흔적(안 봉한 값)은 풀 때 봉한다', async () => {
    const v = memVault()
    await mk(v).enable(PW1)
    v.raw.set('late', 'plain-left-behind')
    const l = mk(v)
    expect(() => l.store.get('late')).toThrow(LockedError)
    await l.unlock(PW1)
    expect(v.raw.get('late')).not.toContain('plain-left-behind')
    expect(l.store.get('late')).toBe('plain-left-behind')
  })

  it('OTP 등록 → 분실 흐름: 비밀값 삭제 + 새 비밀번호, 틀린 OTP 는 5회 후 대기', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    const l = mk(v)
    await l.enable(PW1)
    const begun = l.otpBegin()!
    expect(begun.uri).toContain('otpauth://totp/')
    const code = (t: number) => totpAt(base32Decode(begun.secret), Math.floor(t / 1000))
    expect(l.otpConfirm('000000').ok).toBe(code(now) === '000000')
    expect(l.otpConfirm(code(now))).toEqual({ ok: true })
    expect(l.view(0).otp).toBe(true)
    // lock.json 의 OTP 비밀은 protect 로 싼 것
    expect(readFileSync(lockPath, 'utf8')).toContain('P:' + begun.secret)

    const locked = mk(v)
    expect(await locked.forgotReset(PW2)).toMatchObject({ ok: false, reason: 'expired' })
    const wrong = code(now) === '111111' ? '222222' : '111111'
    for (let i = 0; i < 4; i++) expect(locked.forgotVerify(wrong)).toEqual({ ok: false, reason: 'wrong' })
    expect(locked.forgotVerify(wrong)).toMatchObject({ ok: false, reason: 'wait' })
    expect(locked.forgotVerify(code(now))).toMatchObject({ ok: false, reason: 'wait' })
    now += LOCK_WAIT_MS
    expect(locked.forgotVerify(code(now))).toEqual({ ok: true })
    expect(await locked.forgotReset(PW2)).toEqual({ ok: true, removed: 1 })
    expect(locked.state()).toBe('unlocked')
    expect(v.raw.size).toBe(0)
    const again = mk(v)
    expect(await again.unlock(PW2)).toEqual({ ok: true })
    expect(again.view(0).otp).toBe(true) // OTP 등록은 남는다
  })

  it('lock.json 에 셸 키가 적혀 있으면 기본 키를 쓴다', async () => {
    const v = memVault()
    const l = mk(v)
    l.setPrefs({ shortcut: 'Ctrl+Shift+9' })
    expect(l.shortcut()).toBe('Ctrl+Shift+9')
    l.setPrefs({ shortcut: 'Ctrl+L' })
    expect(l.shortcut()).toBe('Ctrl+Alt+L')
  })

  it('OTP 미등록이면 분실 흐름을 못 연다', async () => {
    const v = memVault()
    await mk(v).enable(PW1)
    expect(mk(v).forgotVerify('123456')).toEqual({ ok: false, reason: 'noOtp' })
  })

  it('고친 lock.json(범위 밖 kdf)은 틀린 비밀번호로 다룬다', async () => {
    const v = memVault()
    await mk(v).enable(PW1)
    const f = JSON.parse(readFileSync(lockPath, 'utf8'))
    f.key.kdf.N = 2 ** 30
    require('node:fs').writeFileSync(lockPath, JSON.stringify(f))
    expect(await mk(v).unlock(PW1)).toEqual({ ok: false, reason: 'wrong' })
  })

  it('이 PC 에서 못 푸는 저장값(safeStorage 실패)은 건너뛴다 — 켜기·풀기·끄기가 막히지 않고 그 값은 원래 바이트 그대로', async () => {
    const v = memVault()
    v.raw.set('srv-1', 'server-secret-a')
    v.raw.set('bad', 'foreign-bytes')
    const get = v.get
    // 다른 Local State 로 암호화된 값 — SafeStorageSecretStore.get 이 던지는 것을 흉내 낸다.
    v.get = (k: string) => {
      if (k === 'bad') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return get(k)
    }
    const l = mk(v)
    expect(await l.enable(PW1)).toEqual({ ok: true })
    expect(v.raw.get('bad')).toBe('foreign-bytes')
    expect(v.raw.get('srv-1')).not.toContain('server-secret-a')
    expect(l.store.get('srv-1')).toBe('server-secret-a')
    // 풀기의 봉하기 고리도 던지지 않는다
    v.raw.set('late', 'plain-left-behind')
    const again = mk(v)
    expect(await again.unlock(PW1)).toEqual({ ok: true })
    expect(v.raw.get('late')).not.toContain('plain-left-behind')
    expect(v.raw.get('bad')).toBe('foreign-bytes')
    // 끄기도 — 봉한 값만 되돌리고 못 푸는 값은 그대로
    expect(await again.disable(PW1)).toEqual({ ok: true })
    expect(v.raw.get('srv-1')).toBe('server-secret-a')
    expect(v.raw.get('late')).toBe('plain-left-behind')
    expect(v.raw.get('bad')).toBe('foreign-bytes')
  })

  it('꺼져 있을 때 잠금 시도는 안내(hint)를 부르고, 켜진 뒤엔 부르지 않고 잠근다', async () => {
    const v = memVault()
    let hints = 0
    const lk = mk(v)
    expect(lk.lockOrHint(() => hints++)).toBe(false)
    expect(hints).toBe(1)
    await lk.enable(PW1)
    expect(lk.lockOrHint(() => hints++)).toBe(true)
    expect(lk.lockOrHint(() => hints++)).toBe(false) // 이미 잠김 — 안내 아님
    expect(hints).toBe(1)
  })
})
