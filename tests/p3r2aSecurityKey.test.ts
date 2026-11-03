// P3 R2-A TM-13 — Orca ssh-security-key-identity.test.ts 의 판별 시험 부분 그대로(orcaRef ec112c6b01). 전송 고르기(requiresSystemSshForSecurityKey)는 아라에 없어 뺐다.
import { describe, expect, it } from 'vitest'
import { isOpenSshSecurityKeyPrivateKey, isOpenSshSecurityKeyPublicKey } from '../src/main/sessions/ssh/securityKey'
import { createOpenSshPrivateKeyFixture, createOpenSshPublicKeyFixture } from './p3r2aSecurityKeyFixture'
const ED25519_SECURITY_KEY = 'sk-ssh-ed25519@openssh.com'
const ECDSA_SECURITY_KEY = 'sk-ecdsa-sha2-nistp256@openssh.com'
describe('isOpenSshSecurityKeyPrivateKey', () => {
  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'recognizes unencrypted %s keys',
    (keyType) => {
      expect(isOpenSshSecurityKeyPrivateKey(createOpenSshPrivateKeyFixture([keyType]))).toBe(true)
    }
  )

  it('recognizes authenticated encrypted envelopes with a trailing tag', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY], {
      cipher: 'aes256-gcm@openssh.com',
      authTag: Buffer.alloc(16, 7)
    })
    expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(true)
  })

  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'recognizes encrypted %s keys from the public section',
    (keyType) => {
      const key = createOpenSshPrivateKeyFixture([keyType], { encrypted: true })
      expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(true)
    }
  )

  it.each(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'])(
    'leaves regular %s keys on ssh2',
    (keyType) => {
      expect(isOpenSshSecurityKeyPrivateKey(createOpenSshPrivateKeyFixture([keyType]))).toBe(false)
    }
  )

  it('supports CRLF armored keys', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    expect(
      isOpenSshSecurityKeyPrivateKey(Buffer.from(key.toString().replaceAll('\n', '\r\n')))
    ).toBe(true)
  })

  it('recognizes OpenSSH envelopes without optional base64 padding', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY], {
      privateBlock: Buffer.alloc(0)
    })
    const unpadded = Buffer.from(key.toString().replace(/=+(?=\n-----END)/, ''))
    expect(unpadded).not.toEqual(key)
    expect(isOpenSshSecurityKeyPrivateKey(unpadded)).toBe(true)
  })

  it('does not match security-key text outside a valid public-key type', () => {
    const key = createOpenSshPrivateKeyFixture(['ssh-ed25519'], {
      privateBlock: Buffer.from(ED25519_SECURITY_KEY)
    })
    expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(false)
    expect(
      isOpenSshSecurityKeyPrivateKey(Buffer.from(`${ED25519_SECURITY_KEY} AAAA comment`))
    ).toBe(false)
  })

  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'validates the %s type inside an OpenSSH public key blob',
    (keyType) => {
      expect(isOpenSshSecurityKeyPublicKey(createOpenSshPublicKeyFixture(keyType))).toBe(true)
    }
  )

  it('recognizes public keys without optional base64 padding', () => {
    const key = createOpenSshPublicKeyFixture(ECDSA_SECURITY_KEY)
    const unpadded = Buffer.from(key.toString().replace(/=+(?=\s)/, ''))
    expect(unpadded).not.toEqual(key)
    expect(isOpenSshSecurityKeyPublicKey(unpadded)).toBe(true)
  })

  it('rejects regular or mismatched OpenSSH public key blobs', () => {
    expect(isOpenSshSecurityKeyPublicKey(createOpenSshPublicKeyFixture('ssh-ed25519'))).toBe(false)
    expect(
      isOpenSshSecurityKeyPublicKey(
        Buffer.from(`${ED25519_SECURITY_KEY} ${Buffer.from('ssh-ed25519').toString('base64')}`)
      )
    ).toBe(false)
  })

  it('rejects malformed and truncated OpenSSH envelopes without throwing', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    const malformedLength = Buffer.concat([
      Buffer.from('openssh-key-v1\0', 'ascii'),
      Buffer.from([0xff, 0xff, 0xff, 0xff])
    ]).toString('base64')
    const malformedKey = Buffer.from(
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${malformedLength}\n-----END OPENSSH PRIVATE KEY-----\n`
    )
    expect(isOpenSshSecurityKeyPrivateKey(key.subarray(0, -20))).toBe(false)
    expect(isOpenSshSecurityKeyPrivateKey(malformedKey)).toBe(false)
    expect(isOpenSshSecurityKeyPrivateKey(Buffer.from('not a private key'))).toBe(false)
  })
})

