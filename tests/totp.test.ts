import { describe, it, expect } from 'vitest'
import { base32Decode, base32Encode, hotp, totpAt, verifyTotp } from '../src/main/secrets/totp'

// RFC 6238 부록 B — SHA-1 시드 "12345678901234567890"(ASCII 20바이트), 8자리.
const SEED = Buffer.from('12345678901234567890', 'ascii')
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130']
]

describe('TOTP (RFC 6238)', () => {
  it('부록 B 시험 벡터 — 8자리', () => {
    for (const [t, code] of VECTORS) expect(totpAt(SEED, t, 8)).toBe(code)
  })

  it('6자리는 같은 값의 끝 6자리', () => {
    for (const [t, code] of VECTORS) expect(totpAt(SEED, t)).toBe(code.slice(2))
  })

  it('RFC 4226 부록 D HOTP 벡터', () => {
    expect(hotp(SEED, 0)).toBe('755224')
    expect(hotp(SEED, 9)).toBe('520489')
  })

  it('base32 왕복 + 공백·소문자 허용', () => {
    const b = base32Encode(SEED)
    expect(b).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(b.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(SEED)
  })

  it('±1 창만 받는다', () => {
    const b32 = base32Encode(SEED)
    const t = 1111111111
    expect(verifyTotp(b32, totpAt(SEED, t), t)).toBe(true)
    expect(verifyTotp(b32, totpAt(SEED, t - 30), t)).toBe(true)
    expect(verifyTotp(b32, totpAt(SEED, t + 30), t)).toBe(true)
    expect(verifyTotp(b32, totpAt(SEED, t - 90), t)).toBe(false)
    expect(verifyTotp(b32, '12345', t)).toBe(false)
    expect(verifyTotp(b32, 'abcdef', t)).toBe(false)
  })
})
