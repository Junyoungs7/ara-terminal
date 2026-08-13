import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import type { ConnectionProfile, SshProfile } from '../src/shared/types'

// 이 파일은 전부 ssh 프로필만 다룬다(rdp 판별 유니온은 rdpLaunch.test.ts/workspace 마이그레이션 쪽 담당) —
// save() 의 반환형이 유니온이라 여기서 한 번만 좁혀 나머지 단언을 그대로 둔다.
function asSsh(p: ConnectionProfile): SshProfile {
  if (p.type !== 'ssh') throw new Error('expected ssh profile')
  return p
}
function keyOf(p: ConnectionProfile): string {
  const ssh = asSsh(p)
  return ssh.auth.type === 'password' ? ssh.auth.secretRef.key : ''
}

// 인메모리 SecretStore(vault 자체 로직은 secrets.test.ts에서 검증). 여기선 ProfileStore 조율 로직에 집중.
class FakeVault implements SecretStore {
  private m = new Map<string, string>()
  get(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  set(k: string, v: string) {
    this.m.set(k, v)
  }
  delete(k: string) {
    this.m.delete(k)
  }
  has(k: string) {
    return this.m.has(k)
  }
  raw() {
    return this.m
  }
}

let dir: string
let wsPath: string
let ws: WorkspaceStore
let vault: FakeVault
let store: ProfileStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ev-prof-'))
  wsPath = join(dir, 'workspace.json')
  ws = new WorkspaceStore(wsPath, '0.1.0')
  vault = new FakeVault()
  store = new ProfileStore(ws, vault)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ProfileStore (F3 프로필 CRUD + vault 조율)', () => {
  it('비밀번호 프로필 저장: 비밀은 vault에, workspace.json엔 평문 없음(secretRef만)', () => {
    const p = store.save({
      name: 'dev',
      host: '10.0.4.21',
      port: 22,
      username: 'deploy',
      authType: 'password',
      secret: 'SUPERSECRET_PW',
      group: '개발'
    })
    // vault에 암호(=평문 in fake)로 존재.
    expect(vault.get(p.type === 'ssh' && p.auth.type === 'password' ? p.auth.secretRef.key : '')).toBe('SUPERSECRET_PW')
    // workspace.json 파일에 평문 미노출(완료조건).
    ws.flush()
    const raw = readFileSync(wsPath, 'utf8')
    expect(raw).not.toContain('SUPERSECRET_PW')
    // 재시작(재로드) 후에도 프로필 유지.
    const ws2 = new WorkspaceStore(wsPath, '0.1.0')
    expect(ws2.getProfiles().map((x) => x.name)).toContain('dev')
  })

  it('키 인증 + 패스프레이즈: keyPath는 메타, 패스프레이즈는 vault', () => {
    const p = store.save({
      name: 'prod',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
      authType: 'key',
      keyPath: '~/.ssh/id_ed25519',
      secret: 'PASSPHRASE_X'
    })
    expect(p.type).toBe('ssh')
    if (p.type === 'ssh' && p.auth.type === 'key') {
      expect(p.auth.keyPath).toBe('~/.ssh/id_ed25519')
      expect(p.auth.secretRef).toBeDefined()
      expect(vault.get(p.auth.secretRef!.key)).toBe('PASSPHRASE_X')
    }
  })

  it('키 회전: 같은 프로필 재저장 시 같은 vault 키를 덮어쓴다', () => {
    const p1 = store.save({ name: 'a', host: 'h', port: 22, username: 'u', authType: 'password', secret: 'old' })
    const key1 = keyOf(p1)
    const p2 = store.save({ id: p1.id, name: 'a', host: 'h', port: 22, username: 'u', authType: 'password', secret: 'new' })
    const key2 = keyOf(p2)
    expect(key2).toBe(key1) // 같은 키
    expect(vault.get(key1)).toBe('new') // 덮어써짐
    expect([...vault.raw().keys()].length).toBe(1) // 고아 없음
  })

  it('secret 미지정 재저장 시 기존 비밀 유지(회전 안 함)', () => {
    const p1 = store.save({ name: 'a', host: 'h', port: 22, username: 'u', authType: 'password', secret: 'keepme' })
    const key = keyOf(p1)
    store.save({ id: p1.id, name: 'a-renamed', host: 'h', port: 22, username: 'u', authType: 'password' })
    expect(vault.get(key)).toBe('keepme')
  })

  it('삭제 시 vault 키를 동기 삭제한다(고아 방지)', () => {
    const p = store.save({ name: 'a', host: 'h', port: 22, username: 'u', authType: 'password', secret: 's' })
    const key = keyOf(p)
    expect(vault.has(key)).toBe(true)
    store.delete(p.id)
    expect(vault.has(key)).toBe(false)
    expect(store.list()).toHaveLength(0)
  })

  it('고아 secretRef(vault에 키 없음) → lookupSecret이 orphanSecret 반환(재인증 프롬프트)', () => {
    const p = store.save({ name: 'a', host: 'h', port: 22, username: 'u', authType: 'password', secret: 's' })
    const key = keyOf(p)
    // vault 손상/유실 시뮬레이션: 프로필은 남았지만 vault 키가 사라짐.
    vault.delete(key)
    const look = store.lookupSecret(asSsh(store.get(p.id)!))
    expect(look.ok).toBe(false)
    if (!look.ok) expect(look.reason).toBe('orphanSecret')
  })

  it('키 인증(패스프레이즈 없음)은 secret 없이도 연결 가능(lookup ok, secret=null)', () => {
    const p = store.save({ name: 'k', host: 'h', port: 22, username: 'u', authType: 'key', keyPath: '~/.ssh/id' })
    const look = store.lookupSecret(asSsh(p))
    expect(look.ok).toBe(true)
    if (look.ok) expect(look.secret).toBeNull()
  })
})

// RDP 프로필 — auth 유니온은 없고(인증 방식 선택이 없다) 비밀번호만 옵션으로 vault 에 든다.
describe('ProfileStore — RDP(F21 / 비밀번호 저장 2026-08-07)', () => {
  it('비밀번호 없이 저장하면 auth 도 secretRef 도 없고 vault 도 비어 있다', () => {
    const p = store.save({ type: 'rdp', name: 'win-업무pc', host: '10.0.5.10', port: 3389, username: 'jun' })
    expect(p.type).toBe('rdp')
    expect('auth' in p).toBe(false)
    expect('secretRef' in p).toBe(false)
    expect(vault.raw().size).toBe(0)
  })

  it('비밀번호를 주면 vault 에 들어가고 프로필엔 참조만 남는다(평문 저장 금지)', () => {
    const p = store.save({ type: 'rdp', name: 'win-pc', host: '10.0.5.10', port: 3389, username: 'jun', secret: 'pw1' })
    if (p.type !== 'rdp') throw new Error('expected rdp')
    expect(p.secretRef).toEqual({ store: 'vault', key: p.id })
    expect(vault.get(p.id)).toBe('pw1')
    expect(JSON.stringify(p)).not.toContain('pw1')
    expect(store.lookupSecret(p)).toEqual({ ok: true, secret: 'pw1' })
  })

  it('secret 을 비우고 다시 저장하면 기존 비밀번호가 남는다(이름만 고칠 때 지워지면 안 된다)', () => {
    const p = store.save({ type: 'rdp', name: 'win-pc', host: '10.0.5.10', port: 3389, username: 'jun', secret: 'pw1' })
    const again = store.save({ id: p.id, type: 'rdp', name: '업무 PC', host: '10.0.5.10', port: 3389, username: 'jun' })
    if (again.type !== 'rdp') throw new Error('expected rdp')
    expect(again.name).toBe('업무 PC')
    expect(store.lookupSecret(again)).toEqual({ ok: true, secret: 'pw1' })
  })

  it('저장 안 한 rdp 는 secret:null — 호출측이 "그때 입력받기"로 분기한다', () => {
    const p = store.save({ type: 'rdp', name: 'win-pc', host: '10.0.5.10', port: 3389, username: 'jun' })
    expect(store.lookupSecret(p)).toEqual({ ok: true, secret: null })
  })

  it('삭제: rdp 비밀번호도 vault 에서 함께 지운다(고아 키가 남으면 안 된다)', () => {
    const p = store.save({ type: 'rdp', name: 'win-pc', host: '10.0.5.10', port: 3389, username: 'jun', secret: 'pw1' })
    store.delete(p.id)
    expect(store.list()).toHaveLength(0)
    expect(vault.raw().size).toBe(0)
  })

  it('rdp → ssh 로 타입을 바꿔도 같은 vault 키를 이어 쓴다(옛 키가 고아로 남지 않는다)', () => {
    const rdp = store.save({ type: 'rdp', name: 'box', host: '10.0.5.10', port: 3389, username: 'jun', secret: 'pw1' })
    const ssh = store.save({ id: rdp.id, type: 'ssh', name: 'box', host: '10.0.5.10', port: 22, username: 'jun', authType: 'password', secret: 'pw2' })
    expect(vault.raw().size).toBe(1)
    expect(store.lookupSecret(ssh)).toEqual({ ok: true, secret: 'pw2' })
  })

  it('ssh 프로필과 나란히 저장·조회된다(타입으로만 구분)', () => {
    const rdp = store.save({ type: 'rdp', name: 'win-pc', host: '10.0.5.10', port: 3389, username: 'jun' })
    const ssh = store.save({ name: 'linux-web', host: '10.0.5.20', port: 22, username: 'deploy', authType: 'key', keyPath: '~/.ssh/id' })
    const list = store.list()
    expect(list.map((x) => x.type).sort()).toEqual(['rdp', 'ssh'])
    expect(list.find((x) => x.id === rdp.id)?.name).toBe('win-pc')
    expect(list.find((x) => x.id === ssh.id)?.name).toBe('linux-web')
  })
})
