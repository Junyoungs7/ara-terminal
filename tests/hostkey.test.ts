import { describe, it, expect } from 'vitest'
import { fingerprintSha256, hostId, verifyHostKey } from '../src/main/sessions/ssh/hostkey'
import type { KnownHost } from '../src/shared/types'

describe('호스트키 TOFU (RC-6)', () => {
  it('fingerprintSha256는 OpenSSH 표기(SHA256:base64, = 제거)를 낸다', () => {
    const fp = fingerprintSha256(Buffer.from('some-host-key-bytes'))
    expect(fp.startsWith('SHA256:')).toBe(true)
    expect(fp.endsWith('=')).toBe(false)
    // 결정적: 같은 입력은 같은 지문.
    expect(fingerprintSha256(Buffer.from('some-host-key-bytes'))).toBe(fp)
  })

  it('hostId는 host:port 형식', () => {
    expect(hostId('10.0.0.5', 22)).toBe('10.0.0.5:22')
  })

  it('처음 보는 호스트는 new(최초 저장 필요)', () => {
    const v = verifyHostKey({}, '10.0.0.5:22', 'ssh-ed25519', 'SHA256:aaa')
    expect(v.kind).toBe('new')
  })

  it('저장된 지문과 일치하면 known(통과)', () => {
    const known: Record<string, KnownHost> = {
      '10.0.0.5:22': { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa', firstSeen: 'now' }
    }
    expect(verifyHostKey(known, '10.0.0.5:22', 'ssh-ed25519', 'SHA256:aaa').kind).toBe('known')
  })

  it('지문 변조(불일치) 시 mismatch(연결 차단)', () => {
    const known: Record<string, KnownHost> = {
      '10.0.0.5:22': { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa', firstSeen: 'now' }
    }
    const v = verifyHostKey(known, '10.0.0.5:22', 'ssh-ed25519', 'SHA256:EVIL')
    expect(v.kind).toBe('mismatch')
    if (v.kind === 'mismatch') expect(v.known.fingerprint).toBe('SHA256:aaa')
  })
})
