import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron safeStorage 모킹: 실제 DPAPI/Keychain 없이 라운드트립 검증.
// 암호화 = 'enc:' 프리픽스 + 원문(테스트용 가역 변환).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encAvailable,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, '')
  }
}))

let encAvailable = true

const { SafeStorageSecretStore } = await import('../src/main/secrets/SafeStorageSecretStore')

let dir: string
let vaultPath: string

beforeEach(() => {
  encAvailable = true
  dir = mkdtempSync(join(tmpdir(), 'ev-vault-'))
  vaultPath = join(dir, 'secrets.vault')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SafeStorageSecretStore', () => {
  it('set→get 라운드트립', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    s.set('uuid-1', '비밀번호123')
    expect(s.get('uuid-1')).toBe('비밀번호123')
    expect(s.has('uuid-1')).toBe(true)
  })

  it('vault는 암호문(base64)만 저장하며 평문이 파일에 없다', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    s.set('uuid-1', 'PLAINTEXT_SECRET')
    const raw = require('node:fs').readFileSync(vaultPath, 'utf8')
    expect(raw).not.toContain('PLAINTEXT_SECRET')
  })

  it('delete 후 has=false, get=null', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    s.set('k', 'v')
    s.delete('k')
    expect(s.has('k')).toBe(false)
    expect(s.get('k')).toBeNull()
  })

  it('없는 키는 null', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    expect(s.get('nope')).toBeNull()
  })

  it('재인스턴스화 후에도 vault가 유지된다(디스크 영속)', () => {
    new SafeStorageSecretStore(vaultPath).set('persist', '값')
    expect(new SafeStorageSecretStore(vaultPath).get('persist')).toBe('값')
  })

  it('암호화 미가용이면 저장을 거부한다(평문 폴백 금지)', () => {
    encAvailable = false
    const s = new SafeStorageSecretStore(vaultPath)
    expect(() => s.set('k', 'v')).toThrow()
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('손상된 vault는 .bak으로 복구한다', () => {
    // .bak은 "기존 파일이 있을 때"의 atomic write에서 생성된다 → 두 번 set해야 .bak 생성.
    const s0 = new SafeStorageSecretStore(vaultPath)
    s0.set('key', 'recovered') // 1차: 신규 파일(아직 .bak 없음)
    s0.set('key2', 'x') // 2차: 기존 파일을 .bak으로 밀어냄 → .bak에 'recovered' 존재
    expect(existsSync(vaultPath + '.bak')).toBe(true)
    // 주 파일 손상
    writeFileSync(vaultPath, '깨진 vault', 'utf8')
    const s1 = new SafeStorageSecretStore(vaultPath)
    expect(s1.get('key')).toBe('recovered')
  })
  it('setMany(앱 잠금) — 한 번에 바꾸고 .bak 에 옛 값이 남지 않는다, null 은 지운다', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    s.set('a', 'old-a')
    s.set('b', 'old-b')
    s.setMany({ a: 'new-a', b: null })
    expect(s.get('a')).toBe('new-a')
    expect(s.has('b')).toBe(false)
    const fs = require('node:fs')
    expect(fs.readFileSync(vaultPath + '.bak', 'utf8')).toBe(fs.readFileSync(vaultPath, 'utf8'))
    expect(new SafeStorageSecretStore(vaultPath).keys()).toEqual(['a'])
  })

  it('setMany — 암호화 미가용이면 아무것도 안 바뀐다', () => {
    const s = new SafeStorageSecretStore(vaultPath)
    s.set('a', 'old-a')
    encAvailable = false
    expect(() => s.setMany({ a: 'new-a' })).toThrow()
    encAvailable = true
    expect(s.get('a')).toBe('old-a')
  })
})
