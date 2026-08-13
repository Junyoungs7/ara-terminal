// ProfileStore — ConnectionProfile CRUD를 WorkspaceStore(비밀 제외 메타) + SecretStore(vault 비밀)로 조율.
// 계획서 §B.4/§C F3: 비밀은 vault 암호문으로만, workspace.json엔 secretRef만. 삭제 시 vault 키 동기 삭제(고아 방지).
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ProfileInput, SecretRef } from '@shared/types'
import type { SecretStore } from './SecretStore'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'

export type SecretLookup =
  | { ok: true; secret: string | null } // null = 비밀 없는 인증(키+패스프레이즈 없음)
  | { ok: false; reason: 'orphanSecret' } // secretRef가 vault에 없음(고아 참조)

export class ProfileStore {
  constructor(
    private readonly ws: WorkspaceStore,
    private readonly vault: SecretStore
  ) {}

  list(): ConnectionProfile[] {
    return this.ws.getProfiles()
  }

  get(id: string): ConnectionProfile | undefined {
    return this.ws.getProfile(id)
  }

  // 저장: 비밀(input.secret)은 vault에, 나머지는 workspace.json에. 신규는 uuid 발급.
  // 키 회전: 기존 프로필의 secretRef.key를 재사용해 덮어쓴다(같은 key). input.secret 미지정 시 기존 비밀 유지.
  save(input: ProfileInput): ConnectionProfile {
    const existing = input.id ? this.ws.getProfile(input.id) : undefined
    const id = existing?.id ?? input.id ?? randomUUID()

    // rdp: 인증 방식 선택이 없다(비밀번호뿐) — secret 을 주면 vault 에 넣고 참조만 남긴다.
    // 주지 않으면 기존 참조를 그대로 둔다(= 비밀번호 유지, ssh 의 "키 회전" 규칙과 같다).
    if (input.type === 'rdp') {
      const existingRef = existing ? refOf(existing) : undefined
      let secretRef = existingRef
      if (input.secret !== undefined && input.secret !== '') {
        const key = existingRef?.key ?? id
        this.vault.set(key, input.secret)
        secretRef = { store: 'vault', key }
      }
      const profile: ConnectionProfile = {
        id,
        type: 'rdp',
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        ...(secretRef ? { secretRef } : {}),
        group: input.group
      }
      this.ws.upsertProfile(profile)
      return profile
    }

    // secretRef 키: 기존 것 재사용(키 회전 = 덮어쓰기), 없으면 프로필 id를 vault 키로.
    // ssh↔rdp 로 타입을 바꿔도 같은 키를 이어 쓴다 — 안 그러면 옛 키가 vault 에 고아로 남는다.
    const existingRef = existing ? refOf(existing) : undefined
    let secretRef: SecretRef | undefined = existingRef

    if (input.secret !== undefined && input.secret !== '') {
      const key = existingRef?.key ?? id
      this.vault.set(key, input.secret) // 평문 → 암호화(safeStorage). 실패(미가용) 시 예외.
      secretRef = { store: 'vault', key }
    }

    const profile: ConnectionProfile =
      input.authType === 'password'
        ? {
            id,
            type: 'ssh',
            name: input.name,
            host: input.host,
            port: input.port,
            username: input.username,
            auth: { type: 'password', secretRef: secretRef ?? { store: 'vault', key: id } },
            group: input.group
          }
        : {
            id,
            type: 'ssh',
            name: input.name,
            host: input.host,
            port: input.port,
            username: input.username,
            auth: { type: 'key', keyPath: input.keyPath ?? '', ...(secretRef ? { secretRef } : {}) },
            group: input.group
          }

    this.ws.upsertProfile(profile)
    return profile
  }

  // 삭제: 프로필 제거 + vault 키 동기 삭제(고아 참조 방지, 계획서 §B.4). ssh·rdp 둘 다 지운다.
  delete(id: string): void {
    const removed = this.ws.removeProfile(id)
    const ref = removed ? refOf(removed) : undefined
    if (ref) this.vault.delete(ref.key)
  }

  // 연결 시 비밀 조회. ssh = 비밀번호/패스프레이즈, rdp = 저장해 둔 비밀번호(없으면 secret:null →
  // 호출측이 사용자에게 입력받는다).
  lookupSecret(profile: ConnectionProfile): SecretLookup {
    const ref = refOf(profile)
    if (!ref) return { ok: true, secret: null } // 키 인증 + 패스프레이즈 없음 / rdp 미저장
    if (!this.vault.has(ref.key)) return { ok: false, reason: 'orphanSecret' }
    return { ok: true, secret: this.vault.get(ref.key) }
  }
}

function refOf(profile: ConnectionProfile): SecretRef | undefined {
  return profile.type === 'rdp' ? profile.secretRef : profile.auth.secretRef
}
