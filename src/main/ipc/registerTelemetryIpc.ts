// telemetry·logtail IPC 핸들러 (W1 F9/F10/F13). 둘 다 활성 SSH 세션의 커넥션을 재사용하는
// 읽기 전용 원격 관측이라 한 파일에서 등록한다(새 연결 금지 — sftp:* 와 같은 규칙).
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { SftpService } from '../sftp/SftpService'
import { createTelemetryService } from '../telemetry/RemoteTelemetry'
import { createLocalTelemetryService } from '../telemetry/LocalTelemetry'
import { createHostStatsService } from '../telemetry/HostStats'
import { createLogTailService } from '../telemetry/LogTail'
import { fetchTmuxSessions } from '../telemetry/TmuxSessions'
import { pushSend } from '../util/windowPush'

// 반환값은 종료 정리용(before-quit) — 원격에 tail 이 남지 않게 한다.
export function registerTelemetryIpc(
  sessions: MainSessionManager,
  // F32: sessionId 를 주면 그 세션을 가진 창으로 보낸다(하단바가 창마다 따로 있으므로).
  getWebContents: (sessionId?: string) => WebContents | null,
  // 로그 뷰어 [이전 불러오기] 는 tail 이 아니라 SFTP 로 파일을 거슬러 읽는다 — 같은 커넥션을 재사용한다.
  sftp: SftpService
): { stopAll: () => void } {
  // sessionId 를 주면 그 세션의 창으로, 안 주면 본창으로(내 PC 자원처럼 창에 안 매인 것).
  const send = (channel: string, payload: unknown, sessionId?: string): void =>
    pushSend(getWebContents(sessionId), channel, payload)
  const client = (sessionId: string) => sessions.sshClient(sessionId)

  const telemetry = createTelemetryService(client, (d) => send(`telemetry:data:${d.sessionId}`, d, d.sessionId))
  // FB-0008: 로컬 세션엔 ports(ss/netstat) 가 없다 — 빈 배열로 채워 TelemetryData 계약은 그대로 둔다
  // (상태바 게이지는 stats 만 본다, [모니터] 탭은 로컬 세션에서 안 뜬다).
  const localTelemetry = createLocalTelemetryService((sessionId, stats) =>
    send(`telemetry:data:${sessionId}`, { sessionId, ports: [], stats }, sessionId)
  )
  // F29: 세션과 무관한 내 PC 통계(sys:data). 위 localTelemetry 와 계산은 같지만 구독 단위가 다르다.
  const host = createHostStatsService((s) => send('sys:data', s))
  const logs = createLogTailService(
    client,
    (d) => send(`logtail:data:${d.id}`, d),
    (d) => send(`logtail:exit:${d.id}`, d)
  )

  // sshClient(id) 가 있으면 원격, 없고 세션이 존재하면 로컬, 둘 다 아니면(세션 없음) 아무 것도 안 한다.
  handle('telemetry:start', ({ sessionId }) => {
    if (sessions.sshClient(sessionId)) {
      localTelemetry.stop(sessionId)
      telemetry.start(sessionId)
    } else if (sessions.has(sessionId)) {
      telemetry.stop(sessionId)
      localTelemetry.start(sessionId)
    }
    return { ok: true } as const
  })
  handle('telemetry:stop', ({ sessionId }) => {
    telemetry.stop(sessionId)
    localTelemetry.stop(sessionId)
    return { ok: true } as const
  })
  // F29: 내 PC 통계. 세션이 없어도 돈다 — 패널이 열려 있는 동안만.
  handle('sys:start', () => {
    host.start()
    return { ok: true } as const
  })
  handle('sys:stop', () => {
    host.stop()
    return { ok: true } as const
  })
  handle('logtail:start', ({ sessionId, path }) => ({ id: logs.start(sessionId, path) }))
  handle('logtail:stop', ({ id }) => {
    logs.stop(id)
    return { ok: true } as const
  })
  // [이전 불러오기] — tail 이 못 보여 주는 과거를 SFTP 로 직접 읽는다(뒤에서부터 창 단위).
  handle('logtail:history', ({ sessionId, path, before }) => sftp.readWindow(sessionId, path, before))
  // FB-monitor: tmux 서브메뉴 — 대상 세션이 SSH 가 아니거나 클라이언트가 없으면(로컬·끊김) 그냥 에러로 처리.
  handle('tmux:listSessions', ({ sessionId }) => {
    const c = client(sessionId)
    return c ? fetchTmuxSessions(c) : Promise.resolve({ status: 'error' as const, sessions: [] })
  })

  return {
    stopAll: () => {
      telemetry.stopAll()
      localTelemetry.stopAll()
      host.stop()
      logs.stopAll()
    }
  }
}
