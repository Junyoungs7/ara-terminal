// F26 서버 콘솔 IPC. registerTelemetryIpc.ts 와 같은 형태 — 활성 SSH 세션의 커넥션을 재사용하는
// 원격 exec 이라 세션 매니저에서 클라이언트를 주입받는다(새 연결 금지 — sftp:*/telemetry:* 와 같은 규칙).
//
// 이 파일에는 명령 문자열이 한 줄도 없다. 렌더러가 보낸 cmdId·인자를 그대로 서비스에 넘기고,
// 서비스가 shared/remoteCatalog.ts 의 buildCommand() 를 통과시킨다 — 그 표 밖의 명령은 실행되지 않는다.
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { ProfileStore } from '../secrets/ProfileStore'
import { createRemoteConsoleService, type RemoteConsoleService } from '../remote/RemoteConsoleService'
import { pushSend } from '../util/windowPush'

/**
 * 권한 올리기용 비밀번호 — **그 세션이 붙을 때 쓴 그 비밀번호**다(새로 받지 않는다).
 * 여기서만 vault 를 읽고 stdin 으로 넘긴다. 렌더러는 이 값을 볼 수 없고 보낼 수도 없다.
 *
 * **비밀번호 인증 프로필만.** `lookupSecret` 은 인증 방식을 안 본다(ProfileStore.refOf 는 키 인증
 * 프로필의 `auth.secretRef` 도 그대로 돌려준다) — 그리고 키 인증에서 그 vault 값은 로그인
 * 비밀번호가 아니라 **개인키 패스프레이즈**다(SshBackend 가 `cfg.passphrase` 로 쓴다).
 *
 * 걸러 내지 않으면: 암호화된 개인키로 붙은 사용자가 [관리자 권한으로 찾기]를 누르는 순간 그
 * 패스프레이즈가 원격 sudo 의 stdin 으로 나간다. sudo 는 당연히 거절하니 화면에는 아무 일도 없고,
 * **개인키를 지키는 문자열만 남의 장비에 남는다**(2026-08-28 배포 전 감사).
 * 못 보낸 경우는 sudo 가 스스로 실패해 화면이 이유를 보여 준다(RemoteConsoleService.exec).
 *
 * RDP 프로필도 여기서 걸린다 — 원격 exec 자체가 SSH 세션의 것이라 애초에 올 일이 없지만,
 * `type` 을 안 보면 그 저장 비밀번호도 같은 길로 나갈 수 있다.
 */
export function sudoPasswordOf(
  sessions: Pick<MainSessionManager, 'snapshot'>,
  profiles: Pick<ProfileStore, 'get' | 'lookupSecret'>,
  sessionId: string
): string | null {
  const meta = sessions.snapshot().find((s) => s.id === sessionId)
  const profile = meta?.profileId ? profiles.get(meta.profileId) : undefined
  if (!profile) return null
  if (profile.type !== 'ssh' || profile.auth.type !== 'password') return null
  const look = profiles.lookupSecret(profile)
  return look.ok ? look.secret : null
}

// 반환값은 서비스 자체다: 종료 정리(before-quit)에 쓰고, **MCP 도 같은 인스턴스를 쓴다**
// (2026-08-26 — 아라의 server_run 이 화면과 같은 폴러·타임아웃·세션 정리를 공유해야 한다).
export function registerRemoteIpc(
  sessions: MainSessionManager,
  getWebContents: (sessionId?: string) => WebContents | null,
  profiles: ProfileStore,
  // 2026-10-28: 세션을 소유하지 않고 **함께 보는** 창(탐색기 독립 창의 프로세스·서비스 표).
  // 받는 쪽이 sessionId·cmdId 로 거르므로 안 보는 창에는 해가 없다(telemetry 의 alsoTo 와 같다).
  alsoTo: () => WebContents[] = () => []
): RemoteConsoleService {
  const svc = createRemoteConsoleService(
    (sessionId) => sessions.sshClient(sessionId),
    (e) => {
      const owner = getWebContents(e.sessionId)
      pushSend(owner, 'remote:data', e)
      for (const wc of alsoTo()) if (wc !== owner) pushSend(wc, 'remote:data', e)
    },
    undefined,
    (sessionId) => sudoPasswordOf(sessions, profiles, sessionId)
  )

  handle('remote:run', ({ sessionId, cmdId, args }) => svc.run(sessionId, cmdId, args))
  handle('remote:watch', ({ sessionId, cmdId, args }) => {
    svc.watch(sessionId, cmdId, args)
    return { ok: true } as const
  })
  handle('remote:unwatch', ({ sessionId, cmdId }) => {
    svc.unwatch(sessionId, cmdId)
    return { ok: true } as const
  })

  return svc
}
