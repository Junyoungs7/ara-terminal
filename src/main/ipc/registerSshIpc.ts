// ssh 도메인 IPC 핸들러 (계획서 §C F3). 프로필 조회→비밀 복호(vault)→호스트키 TOFU→연결→세션 편입.
// 실패는 구조화된 SshConnectResult로 반환(예외 던지지 않음): 고아 secretRef/호스트키/인증 구분.
import net from 'node:net'
import type { ConnTestResult, SshConnectResult } from '@shared/ipc'
import type { ProfileInput, SshProfile } from '@shared/types'
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
  acceptHostKey: boolean,
  /**
   * 이번 접속에만 쓰는 비밀번호(2026-08-21). 주어지면 vault 조회를 **건너뛰고** 이 값을 쓴다 —
   * 그래서 비밀번호를 저장하지 않는 사용자도 접속할 수 있다(그전엔 저장 안 하면 orphanSecret 으로
   * 막혀 길이 없었다). 여기서도 vault 에 쓰지 않는다: 저장은 연결 관리자의 [저장]이 하는 일이다.
   * MCP 경로는 이 인자를 주지 않는다(AI 가 비밀번호를 들고 오는 길을 만들지 않는다).
   */
  password?: string
): Promise<SshConnectResult> {
  const profile = profiles.get(profileId)
  if (!profile) return { ok: false, reason: 'network', message: '프로필을 찾을 수 없습니다.' }
  // W4sat F21: rdp 프로필은 이 경로로 오지 않는다(렌더러가 rdp:launch 로 분기) — 방어적 가드.
  // MCP ssh_connect/session_create 도 이 함수를 거치므로 AI 가 profileId 로 rdp 프로필을 넘겨도
  // 여기서 막힌다(신뢰 경계 밖 인자 재확인, 설계 §5 M1과 같은 결의 검증).
  if (profile.type !== 'ssh') return { ok: false, reason: 'network', message: 'SSH 프로필이 아닙니다.' }

  // 비밀: 이번 접속에 받은 것이 우선. 없으면 vault 조회(고아 secretRef면 연결 차단 + 재인증 프롬프트, RC-2).
  let secret: string | null
  if (password !== undefined && password !== '') {
    secret = password
  } else {
    const lookup = profiles.lookupSecret(profile)
    if (!lookup.ok) return { ok: false, reason: 'orphanSecret' }
    secret = lookup.secret
  }

  const outcome = await connectSsh(profile, {
    knownHosts: ws.getKnownHosts(),
    secret,
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

const TEST_TIMEOUT_MS = 8000

/** TCP 로 닿는지만 본다(RDP 테스트). 열려 있으면 즉시 끊는다 — 서버에 세션을 남기지 않는다. */
function probeTcp(host: string, port: number): Promise<ConnTestResult> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    const done = (r: ConnTestResult): void => {
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(TEST_TIMEOUT_MS, () => done({ ok: false, reason: 'network', message: '연결 시간이 초과됐습니다.' }))
    sock.once('connect', () => done({ ok: true, note: 'rdpReachOnly' }))
    sock.once('error', (e) => done({ ok: false, reason: 'network', message: e.message }))
  })
}

/**
 * [접속 테스트] — 세션도, 프로필도 만들지 않는다(2026-08-21 준영님 요청으로 [저장 후 접속] 하나를
 * [접속 테스트]·[저장]·[저장 후 접속] 셋으로 가른 것).
 *
 * **저장하기 전의 폼 값**으로 시험한다 — 그게 [저장]과 이 버튼을 가르는 점이다. 그래서 vault 에
 * 아무것도 쓰지 않고, workspace.json 도 건드리지 않는다. 비밀이 비어 있고 id 가 있으면 그 프로필의
 * vault 비밀을 쓴다(폼의 "비우면 기존 유지"와 같은 규칙).
 *
 * SSH 는 실제로 인증까지 해 보고 **바로 끊는다**. 그래서 "비밀번호가 맞는지"를 탭을 열지 않고 안다 —
 * 이 라운드에서 고친 결함(키 인증 칸에 서버 비밀번호를 넣어 전부 실패)이 바로 이걸로 드러난다.
 *
 * acceptHostKey 는 **항상 false** 이고 onHostKeyAccepted 도 비운다: 테스트가 지문을 대신 수락하면
 * TOFU 가 무의미해진다(MCP 경로와 같은 이유 — 설계 §1.3).
 */
export async function testProfile(
  profiles: ProfileStore,
  ws: WorkspaceStore,
  input: ProfileInput
): Promise<ConnTestResult> {
  if (!input.host || !input.username) {
    return { ok: false, reason: 'network', message: '호스트·사용자를 먼저 입력해 주세요.' }
  }

  // 비밀: 폼에 입력한 것이 우선, 비어 있으면 저장돼 있던 것.
  let secret: string | null = input.secret && input.secret !== '' ? input.secret : null
  if (secret === null && input.id) {
    const saved = profiles.get(input.id)
    if (saved) {
      const lookup = profiles.lookupSecret(saved)
      if (!lookup.ok) return { ok: false, reason: 'orphanSecret' }
      secret = lookup.secret
    }
  }

  // RDP 비밀번호 검증은 wasm 클라이언트 전 경로가 필요해 실제 접속과 다를 게 없다 — 도달까지만 본다.
  if (input.type === 'rdp') return await probeTcp(input.host, input.port)

  // connectSsh 는 auth.type 과 (키 인증이면) keyPath 만 본다 — secretRef 는 deps.secret 이 대신하므로
  // 저장 안 된 폼을 그대로 시험할 수 있다(임시 프로필을 vault 에 넣지 않는 이유).
  const profile: SshProfile = {
    id: input.id ?? 'test',
    type: 'ssh',
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    auth:
      input.authType === 'password'
        ? { type: 'password', secretRef: { store: 'vault', key: input.id ?? 'test' } }
        : { type: 'key', keyPath: input.keyPath ?? '' }
  }

  const outcome = await connectSsh(profile, {
    knownHosts: ws.getKnownHosts(),
    secret,
    acceptHostKey: false,
    onHostKeyAccepted: () => {}
  })
  if (outcome.ok) {
    outcome.backend.kill()
    return { ok: true }
  }
  return { ok: false, reason: outcome.reason, message: 'message' in outcome ? outcome.message : undefined }
}

export function registerSshIpc(
  profiles: ProfileStore,
  ws: WorkspaceStore,
  sessions: MainSessionManager
): void {
  handle('ssh:connect', ({ profileId, acceptHostKey, password }): Promise<SshConnectResult> =>
    connectByProfile(profiles, ws, sessions, profileId, acceptHostKey === true, password)
  )

  handle('conn:test', ({ input }): Promise<ConnTestResult> => testProfile(profiles, ws, input))

  // 호스트키 재설정(트리 우클릭 → 사용자 확인 후). 프로필의 host:port 항목만 지운다.
  handle('ssh:forgetHostKey', ({ profileId }) => {
    const profile = profiles.get(profileId)
    if (!profile) return { ok: true as const, removed: false }
    return { ok: true as const, removed: ws.removeKnownHost(hostId(profile.host, profile.port)) }
  })
}
