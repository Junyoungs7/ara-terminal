// ssh 도메인 IPC 핸들러 (계획서 §C F3). 프로필 조회→비밀 복호(vault)→호스트키 TOFU→연결→세션 편입.
// 실패는 구조화된 SshConnectResult로 반환(예외 던지지 않음): 고아 secretRef/호스트키/인증 구분.
import type { SshConnectResult } from '@shared/ipc'
import { handle } from './handle'
import type { ProfileStore } from '../secrets/ProfileStore'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { connectSsh } from '../sessions/ssh/SshBackend'
import { hostId } from '../sessions/ssh/hostkey'

// 프로필 id → 연결 → 세션 편입. registerSshIpc(renderer 경유) 와 F23 MCP ssh_connect/session_create 가
// 이 함수 하나를 공유한다(같은 함수의 두 번째 호출자 — F16 패턴). acceptHostKey 는 호출측이 정한다:
// MCP 경로는 항상 false 로 고정해 부른다(AI 가 TOFU 를 대신 수락할 수 없다, 설계 §1.3).
export async function connectByProfile(
  profiles: ProfileStore,
  ws: WorkspaceStore,
  sessions: MainSessionManager,
  profileId: string,
  acceptHostKey: boolean
): Promise<SshConnectResult> {
  const profile = profiles.get(profileId)
  if (!profile) return { ok: false, reason: 'network', message: '프로필을 찾을 수 없습니다.' }
  // W4sat F21: rdp 프로필은 이 경로로 오지 않는다(렌더러가 rdp:launch 로 분기) — 방어적 가드.
  // MCP ssh_connect/session_create 도 이 함수를 거치므로 AI 가 profileId 로 rdp 프로필을 넘겨도
  // 여기서 막힌다(신뢰 경계 밖 인자 재확인, 설계 §5 M1과 같은 결의 검증).
  if (profile.type !== 'ssh') return { ok: false, reason: 'network', message: 'SSH 프로필이 아닙니다.' }

  // 비밀 조회: 고아 secretRef면 연결 차단 + 재인증 프롬프트(RC-2).
  const lookup = profiles.lookupSecret(profile)
  if (!lookup.ok) return { ok: false, reason: 'orphanSecret' }

  const outcome = await connectSsh(profile, {
    knownHosts: ws.getKnownHosts(),
    secret: lookup.secret,
    acceptHostKey,
    onHostKeyAccepted: (id, host) => ws.addKnownHost(id, host)
  })

  if (!outcome.ok) return outcome

  // 연결된 백엔드를 로컬과 동일 세션 파이프라인에 편입(별도 경로 금지).
  const title = sessions.nextTitle(profile.name)
  const id = sessions.adopt(outcome.backend, {
    type: 'ssh',
    profileId: profile.id,
    title,
    serverKey: profile.name,
    cwd: undefined,
    shell: undefined
  })
  return { ok: true, id, title }
}

export function registerSshIpc(
  profiles: ProfileStore,
  ws: WorkspaceStore,
  sessions: MainSessionManager
): void {
  handle('ssh:connect', ({ profileId, acceptHostKey }): Promise<SshConnectResult> =>
    connectByProfile(profiles, ws, sessions, profileId, acceptHostKey === true)
  )

  // 호스트키 재설정(트리 우클릭 → 사용자 확인 후). 프로필의 host:port 항목만 지운다.
  handle('ssh:forgetHostKey', ({ profileId }) => {
    const profile = profiles.get(profileId)
    if (!profile) return { ok: true as const, removed: false }
    return { ok: true as const, removed: ws.removeKnownHost(hostId(profile.host, profile.port)) }
  })
}
