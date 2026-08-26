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

// 반환값은 서비스 자체다: 종료 정리(before-quit)에 쓰고, **MCP 도 같은 인스턴스를 쓴다**
// (2026-08-26 — 아라의 server_run 이 화면과 같은 폴러·타임아웃·세션 정리를 공유해야 한다).
export function registerRemoteIpc(
  sessions: MainSessionManager,
  getWebContents: (sessionId?: string) => WebContents | null,
  profiles: ProfileStore
): RemoteConsoleService {
  const svc = createRemoteConsoleService(
    (sessionId) => sessions.sshClient(sessionId),
    (e) => pushSend(getWebContents(e.sessionId), 'remote:data', e),
    undefined,
    // 권한 올리기용 비밀번호 — **그 세션이 붙을 때 쓴 그 비밀번호**다(새로 받지 않는다).
    // 여기서만 vault 를 읽고 stdin 으로 넘긴다. 렌더러는 이 값을 볼 수 없고 보낼 수도 없다.
    (sessionId) => {
      const meta = sessions.snapshot().find((s) => s.id === sessionId)
      const profile = meta?.profileId ? profiles.get(meta.profileId) : undefined
      if (!profile) return null
      const look = profiles.lookupSecret(profile)
      return look.ok ? look.secret : null
    }
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
