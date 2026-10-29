// 2.0 앱 잠금 — 암호 층(설계: agent_talk/PLAN-v2-lock.md, v2-lock-impl-task.md §설계 1).
//
// 비밀값 = AES-256-GCM(데이터 키 DK) → 그 위에 기존 safeStorage. DK 는 잠금 비밀번호에서 scrypt 로 만든
// KEK 로 GCM 감싸 lock.json 에 둔다. **비밀번호 해시는 따로 두지 않는다** — 비밀번호가 맞았나는
// 언랩의 GCM 인증이 성공했나로만 안다(해시를 두면 그것이 곧 오프라인 대입 표적이 하나 더 생긴다).
//
// Node 표준 `crypto` 만 쓴다(electron 없음) — 단위 시험이 그대로 돈다.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'

export type KdfParams = { N: number; r: number; p: number; salt: string } // salt = base64(16B)
export type Wrapped = { iv: string; tag: string; ct: string } // 전부 base64

/** 설계값: N=2^15, r=8, p=1(메모리 32MiB·수십~백 ms). 시험만 더 작은 N 을 넘긴다. */
export const KDF_DEFAULT = { N: 2 ** 15, r: 8, p: 1 } as const

const SEAL_PREFIX = 'ara-lock1:'
const DK_AAD = Buffer.from('ara-lock-dk-v1')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/**
 * lock.json 의 값은 신뢰 경계 밖이다(파일을 고칠 수 있다). N 을 2^30 으로 바꿔 두면 잠금 해제 한 번이
 * 메모리를 다 먹는다 — 범위 밖이면 유도 자체를 거부한다(= 그 비밀번호는 틀린 것으로 다뤄진다).
 */
function checkKdf(k: KdfParams): void {
  const okN = Number.isInteger(k.N) && k.N >= 2 ** 10 && k.N <= 2 ** 20 && (k.N & (k.N - 1)) === 0
  const okR = Number.isInteger(k.r) && k.r >= 1 && k.r <= 16
  const okP = Number.isInteger(k.p) && k.p >= 1 && k.p <= 4
  if (!okN || !okR || !okP || typeof k.salt !== 'string') throw new Error('lock: kdf 매개변수가 범위 밖입니다')
}

export function newKdf(base: { N: number; r: number; p: number } = KDF_DEFAULT): KdfParams {
  return { N: base.N, r: base.r, p: base.p, salt: randomBytes(16).toString('base64') }
}

export function deriveKek(password: string, kdf: KdfParams): Promise<Buffer> {
  checkKdf(kdf)
  // NFC: 같은 한글 비밀번호가 입력기에 따라 자모 분리형으로 올 수 있다.
  const pw = Buffer.from(password.normalize('NFC'), 'utf8')
  return new Promise((resolve, reject) =>
    scrypt(pw, Buffer.from(kdf.salt, 'base64'), KEY_LEN, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (e, key) =>
      e ? reject(e) : resolve(key)
    )
  )
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_LEN)
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
  c.setAAD(aad)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv, tag: c.getAuthTag(), ct }
}

/** 인증 실패면 던진다(호출자가 "틀림"으로 바꾼다). */
function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('lock: 암호문 모양이 틀렸습니다')
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN })
  d.setAAD(aad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

export const newDataKey = (): Buffer => randomBytes(KEY_LEN)

export function wrapDk(kek: Buffer, dk: Buffer): Wrapped {
  const s = seal(kek, dk, DK_AAD)
  return { iv: s.iv.toString('base64'), tag: s.tag.toString('base64'), ct: s.ct.toString('base64') }
}

/** 비밀번호가 틀렸으면(=GCM 인증 실패) null. */
export function unwrapDk(kek: Buffer, w: Wrapped): Buffer | null {
  try {
    const dk = open(kek, Buffer.from(w.iv, 'base64'), Buffer.from(w.tag, 'base64'), Buffer.from(w.ct, 'base64'), DK_AAD)
    return dk.length === KEY_LEN ? dk : null
  } catch {
    return null
  }
}

/**
 * 값 하나를 DK 로 봉한다. AAD 에 vault 키 이름을 넣는다 — 파일을 고쳐 A 의 암호문을 B 자리로
 * 옮겨 놓으면 인증이 깨진다(서버 비밀번호를 다른 서버 칸으로 바꿔치기 못 한다).
 */
export function sealValue(dk: Buffer, key: string, value: string): string {
  const s = seal(dk, Buffer.from(value, 'utf8'), Buffer.from('v:' + key, 'utf8'))
  return SEAL_PREFIX + Buffer.concat([s.iv, s.tag, s.ct]).toString('base64')
}

export function openValue(dk: Buffer, key: string, sealed: string): string {
  const raw = Buffer.from(sealed.slice(SEAL_PREFIX.length), 'base64')
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = raw.subarray(IV_LEN + TAG_LEN)
  return open(dk, iv, tag, ct, Buffer.from('v:' + key, 'utf8')).toString('utf8')
}

export const isSealed = (v: string): boolean => v.startsWith(SEAL_PREFIX)
