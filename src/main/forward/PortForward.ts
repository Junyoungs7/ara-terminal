// F8 로컬 포트 포워딩(ssh -L 상당). 세션의 ssh2 커넥션을 재사용해(새 연결 금지 — sftp:*·telemetry:* 와
// 같은 규칙) 내 PC 127.0.0.1:<localPort> 에 리스너를 열고, 들어오는 소켓마다 원격 127.0.0.1:<remotePort> 로
// 파이프한다.
//
//   [내 PC] 브라우저 → 127.0.0.1:8765 → net.Server → forwardOut → [원격] 127.0.0.1:8765
//
// 보안 불변식 (설계 §2 — 협상 대상 아님):
//  1. 로컬 바인드 주소는 LOCAL_BIND 하나뿐이다. 이 파일 어디에도 0.0.0.0 을 쓸 경로가 없고,
//     IPC 계약에도 바인드 주소 필드가 없다 → 사내망 전체가 내 PC 를 경유해 원격에 닿는 사고가 불가능하다.
//  2. 원격 목적지 호스트는 REMOTE_HOST 하나뿐이다. 계약에 remoteHost 가 없으므로 렌더러가
//     "10.0.0.5 로 터널을 파라"를 **표현할 수 없다**(사내망 피벗 1차 방어).
//  3. 활성 SSH 세션이 없으면 만들지 않고(noSession), 이미 만든 것도 소켓이 들어온 순간 스스로 접는다.
//  4. 흘러가는 바이트는 어디에도 남기지 않는다 — pipe 두 줄이 전부다(로깅·버퍼링·검사 없음).
import { createServer, type Server, type Socket } from 'node:net'
import type { Client } from 'ssh2'
import type { ForwardResult, PortForward } from '@shared/types'

// 로컬 리스너 바인드 주소(불변식 1)와 원격 목적지 호스트(불변식 2).
export const LOCAL_BIND = '127.0.0.1'
export const REMOTE_HOST = '127.0.0.1'
// 세션당 상한. 포워딩 무한 생성으로 fd 를 고갈시키는 IPC 남용을 막는 안전판이다.
export const MAX_PER_SESSION = 16

const PORT_MIN = 1
const PORT_MAX = 65535

export type ForwardService = {
  create(sessionId: string, remotePort: number, exactPort?: boolean): Promise<ForwardResult>
  stop(id: string): void
  list(): PortForward[]
  // 세션 종료 훅(registerSessionIpc sink.exit) — 그 세션의 리스너·소켓을 전부 접는다.
  stopSession(sessionId: string): void
  stopAll(): void
}

type Entry = { info: PortForward; server: Server; sockets: Set<Socket> }

// 포트 번호로 쓸 수 있는 값인지. 문자열·음수·0·65536·소수를 전부 걸러 낸다(렌더러는 신뢰 경계 밖이다).
export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
}

// getClient: 세션 id → ssh2 Client(로컬·종료된 세션은 null). RemoteTelemetry 와 같은 주입 형태.
export function createForwardService(getClient: (sessionId: string) => Client | null): ForwardService {
  const entries = new Map<string, Entry>()
  // 생성 중인 키(await 사이에 같은 요청이 또 오면 리스너가 두 개 열린다 — 행 더블클릭이 그 경로다).
  const pending = new Map<string, Promise<ForwardResult>>()

  function stop(id: string): void {
    const e = entries.get(id)
    if (!e) return
    entries.delete(id)
    for (const s of e.sockets) s.destroy()
    e.sockets.clear()
    e.server.close()
  }

  function pipeSocket(e: Entry, socket: Socket): void {
    const client = getClient(e.info.sessionId)
    // 방어적 2차 정리: 세션이 죽었는데 exit 훅을 놓쳐 리스너만 남은 경우 스스로 접는다
    // (RemoteTelemetry.tick 의 죽은 세션 감지와 같은 패턴).
    if (!client) {
      socket.destroy()
      stop(e.info.id)
      return
    }
    e.sockets.add(socket)
    e.info.conns = e.sockets.size
    socket.on('close', () => {
      e.sockets.delete(socket)
      e.info.conns = e.sockets.size
    })
    socket.on('error', () => socket.destroy())
    client.forwardOut(LOCAL_BIND, socket.remotePort ?? 0, REMOTE_HOST, e.info.remotePort, (err, stream) => {
      if (err) {
        // 원격 프로세스가 아직 그 포트를 안 듣고 있는 흔한 경우. 리스너는 유지하고(새로고침하면 성공)
        // 소켓만 끊는다. 사유는 [모니터] 탭이 보여 준다.
        e.info.lastError = err.message
        socket.destroy()
        return
      }
      socket.pipe(stream)
      stream.pipe(socket)
      stream.on('error', () => socket.destroy())
    })
  }

  // 한 번의 listen 시도. 성공하면 실제 포트, 실패(EADDRINUSE 등)하면 null.
  // 실패한 서버 객체는 다시 listen 할 수 있으므로 임의 포트 재시도에 그대로 쓴다.
  function tryListen(server: Server, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const onError = (): void => {
        server.removeListener('listening', onListening)
        resolve(null)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const a = server.address()
        resolve(typeof a === 'object' && a !== null ? a.port : null)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, LOCAL_BIND)
    })
  }

  async function build(
    id: string,
    sessionId: string,
    remotePort: number,
    exactPort: boolean
  ): Promise<ForwardResult> {
    const server = createServer()
    // 요청한 번호를 먼저 시도한다: OAuth 는 redirect_uri 에 포트가 박혀 오고, 미리보기도 같은 번호가
    // URL 을 알아보기 쉽다.
    let localPort = await tryListen(server, remotePort)
    const exact = localPort !== null
    if (localPort === null) {
      if (exactPort) {
        // 임의 포트 폴백 금지: 그 번호가 아니면 콜백이 영영 안 돌아온다. 사유를 그대로 올린다.
        server.close()
        return {
          ok: false,
          reason: 'portInUse',
          message: `로컬 ${remotePort} 포트가 이미 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 시도하세요.`
        }
      }
      localPort = await tryListen(server, 0)
      if (localPort === null) {
        server.close()
        return { ok: false, reason: 'portInUse', message: '로컬 포트를 열 수 없습니다.' }
      }
    }
    // 리스닝 이후의 소켓 오류로 프로세스가 죽지 않게 한다(포워딩 실패는 이 세션만의 문제다).
    server.on('error', () => {})
    const info: PortForward = { id, sessionId, remotePort, localPort, exact, conns: 0 }
    const entry: Entry = { info, server, sockets: new Set() }
    entries.set(id, entry)
    server.on('connection', (socket) => pipeSocket(entry, socket))
    return { ok: true, forward: info }
  }

  return {
    create(sessionId, remotePort, exactPort) {
      if (typeof sessionId !== 'string' || !sessionId || !isValidPort(remotePort)) {
        return Promise.resolve({
          ok: false,
          reason: 'invalid',
          message: `포트 번호가 올바르지 않습니다: ${String(remotePort)}`
        })
      }
      // 로컬 셸·죽은 세션은 여기서 끝난다(불변식 3).
      if (!getClient(sessionId)) {
        return Promise.resolve({ ok: false, reason: 'noSession', message: '활성 SSH 세션이 아닙니다.' })
      }
      const id = `${sessionId}:${remotePort}`
      const found = entries.get(id)
      if (found) return Promise.resolve({ ok: true, forward: found.info }) // 멱등 — 리스너를 늘리지 않는다
      const inFlight = pending.get(id)
      if (inFlight) return inFlight
      const count = [...entries.values()].filter((e) => e.info.sessionId === sessionId).length
      if (count >= MAX_PER_SESSION) {
        return Promise.resolve({
          ok: false,
          reason: 'invalid',
          message: `세션당 포워딩은 ${MAX_PER_SESSION}개까지입니다.`
        })
      }
      const p = build(id, sessionId, remotePort, exactPort === true).finally(() => pending.delete(id))
      pending.set(id, p)
      return p
    },
    stop,
    list: () => [...entries.values()].map((e) => e.info),
    stopSession(sessionId) {
      for (const e of [...entries.values()]) {
        if (e.info.sessionId === sessionId) stop(e.info.id)
      }
    },
    stopAll() {
      for (const id of [...entries.keys()]) stop(id)
    }
  }
}
