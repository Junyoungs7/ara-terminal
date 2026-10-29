// 구글 OTP(TOTP, RFC 6238 — SHA-1·30초·6자리) — 잠금 비밀번호를 잊었을 때 본인 확인에만 쓴다.
// 의존성 없이 Node `crypto` 로 직접 한다(시험: tests/totp.test.ts 가 RFC 6238 부록 B 벡터를 문다).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of buf) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

/** 공백·소문자·`=` 패딩을 받아 준다(사람이 옮겨 적은 키). 모르는 글자면 던진다. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, '').toUpperCase()
  let bits = 0
  let acc = 0
  const out: number[] = []
  for (const ch of clean) {
    const v = B32.indexOf(ch)
    if (v < 0) throw new Error('totp: base32 가 아닙니다')
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', secret).update(msg).digest()
  const off = h[h.length - 1] & 0xf
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const TOTP_STEP = 30

export function totpAt(secret: Buffer, unixSec: number, digits = 6): string {
  return hotp(secret, Math.floor(unixSec / TOTP_STEP), digits)
}

/** ±1 창(앞뒤 30초) — 휴대폰 시계가 조금 어긋나도 받는다. */
export function verifyTotp(secretB32: string, code: string, unixSec: number): boolean {
  if (!/^\d{6}$/.test(code)) return false
  const secret = base32Decode(secretB32)
  const want = Buffer.from(code)
  let ok = false
  for (const d of [-1, 0, 1]) {
    const got = Buffer.from(totpAt(secret, unixSec + d * TOTP_STEP))
    if (timingSafeEqual(got, want)) ok = true
  }
  return ok
}

/** 20바이트(160bit) 무작위 — RFC 4226 권장 길이. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20))

export function otpauthUri(secretB32: string): string {
  const label = encodeURIComponent('A.R.A:잠금')
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=A.R.A&algorithm=SHA1&digits=6&period=${TOTP_STEP}`
}
