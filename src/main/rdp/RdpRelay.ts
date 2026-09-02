// RDP 릴레이 — 렌더러의 IronRDP WASM 클라이언트(WebSocket)와 원격 RDP 서버(TCP+TLS)를 잇는다.
//
// 왜 필요한가: IronRDP WASM 은 브라우저용이라 생 TCP 를 못 연다. 브라우저였다면 외부 게이트웨이가
// 필요하지만 우리는 Electron 이라 그 릴레이를 main 안에 둘 수 있다 — 외부 인프라·추가 설치 0.
//
// 보안 설계(F8 포워딩과 같은 원칙):
//  - **접속 대상은 main 이 정한다.** 클라이언트가 보낸 RDCleanPath destination 은 참고만 하고
//    실제 연결은 start() 인자(프로필에서 온 host:port)로만 한다 — 렌더러가 임의 호스트로 피벗 불가.
//  - 리스너는 **127.0.0.1 전용**, 포트는 OS 가 주는 임시 포트.
//  - **1회용 토큰**을 URL 경로로 요구하고, 연결 1개만 받고 리스너를 닫는다(다른 로컬 프로세스가
//    붙는 창을 최소화).
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { buildCleanPathError, buildCleanPathResponse, parseCleanPathRequest } from './rdcleanpath'

const HANDSHAKE_TIMEOUT_MS = 15_000
const ACCEPT_TIMEOUT_MS = 30_000 // 렌더러가 이 안에 붙지 않으면 리스너를 닫는다(고아 방지).

export type RdpRelayHandle = {
  /** ws://127.0.0.1:<port>/<token> — 렌더러가 proxyAddress 로 그대로 쓴다. */
  url: string
  /** 같은 1회용 토큰. 렌더러가 authToken() 으로도 넣어 프로토콜 수준에서 한 번 더 검증된다. */
  token: string
  close(): void
}

type StartOpts = {
  host: string
  port: number
  /** 릴레이가 끝났을 때(정상 종료·오류) 알림 — 호출측이 상태를 정리한다. */
  onClosed?: (reason?: string) => void
}

function extractCertChain(peer: tls.PeerCertificate | tls.DetailedPeerCertificate | null): Buffer[] {
  const certs: Buffer[] = []
  const seen = new Set<string>()
  let cur = peer as tls.DetailedPeerCertificate | null
  while (cur && cur.raw) {
    const fp = cur.fingerprint256 || cur.raw.toString('hex')
    if (seen.has(fp)) break
    seen.add(fp)
    certs.push(Buffer.from(cur.raw))
    cur = cur.issuerCertificate && cur.issuerCertificate !== cur ? cur.issuerCertificate : null
  }
  return certs
}

// Windows RDP 의 자체 서명 인증서는 keyUsage 비트가 좁게 잡혀 있는 경우가 많은데, Electron 이 쓰는
// BoringSSL 은 협상된 암호 방식과 그 비트가 맞지 않으면 KEY_USAGE_BIT_INCORRECT 로 끊는다
// (mstsc 는 통과하는 서버가 여기서 막힌다). 암호 방식마다 요구하는 비트가 다르므로 후보를 순서대로
// 시도한다: ①ECDHE(digitalSignature 필요) ②RSA 키 교환(keyEncipherment 필요) ③기본값.
const TLS_ATTEMPTS: { label: string; opts: tls.ConnectionOptions }[] = [
  {
    label: 'ECDHE',
    opts: {
      minVersion: 'TLSv1.2',
      ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA'
    }
  },
  { label: 'RSA-KX', opts: { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA' } },
  { label: '기본', opts: {} }
]

// TCP 연결 → X.224 요청 전달 → 확인 응답 수신 → TLS 승격 → 인증서 추출.
// RDP 서버는 자체 서명 인증서가 일반적이라 검증하지 않는다 — 대신 인증서 체인을 그대로
// 클라이언트에 넘겨 IronRDP 가 판단하게 한다.
function tcpAndX224(host: string, port: number, x224Request: Buffer): Promise<{ tcp: net.Socket; x224Response: Buffer }> {
  return new Promise((resolve, reject) => {
    const tcp = net.createConnection({ host, port }, () => tcp.write(x224Request))
    const fail = (msg: string) => {
      tcp.destroy()
      reject(new Error(msg))
    }
    tcp.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail('RDP 핸드셰이크 시간 초과'))
    tcp.once('error', (e) => fail(`TCP 연결 실패: ${e.message}`))
    tcp.once('data', (x224Response) => {
      if (x224Response.length === 0) return fail('RDP 서버가 X.224 응답 없이 연결을 닫았습니다')
      tcp.removeAllListeners('error')
      tcp.removeAllListeners('data')
      tcp.setTimeout(0)
      resolve({ tcp, x224Response: Buffer.from(x224Response) })
    })
  })
}

async function rdpHandshake(
  host: string,
  port: number,
  x224Request: Buffer
): Promise<{ x224Response: Buffer; certChain: Buffer[]; socket: tls.TLSSocket }> {
  let lastErr = 'TLS 핸드셰이크 실패'
  for (const attempt of TLS_ATTEMPTS) {
    // X.224 는 TLS 승격 전 단계라 재시도마다 TCP 부터 다시 맺어야 한다(같은 소켓을 재사용할 수 없다).
    const { tcp, x224Response } = await tcpAndX224(host, port, x224Request)
    try {
      const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const sock = tls.connect(
          { socket: tcp, servername: host, rejectUnauthorized: false, ...attempt.opts },
          () => resolve(sock)
        )
        sock.once('error', (e) => reject(e))
      })
      if (attempt.label !== 'ECDHE') console.log(`[rdp] TLS 승격 성공(${attempt.label} 방식)`)
      return { x224Response, certChain: extractCertChain(socket.getPeerCertificate(true)), socket }
    } catch (e) {
      lastErr = `TLS 핸드셰이크 실패(${attempt.label}): ${e instanceof Error ? e.message : String(e)}`
      console.warn('[rdp]', lastErr)
      tcp.destroy()
    }
  }
  throw new Error(lastErr)
}

/**
 * ⚠️ TEMP-DIAG(#165 · 2026-09-02) — **확인되면 이 상수와 아래 스니퍼를 함께 지운다**(`grep TEMP-DIAG`).
 *
 * RDP 클립보드가 양방향으로 죽었는데 **같은 서버에서 MobaXterm 은 된다** → 서버 정책이 아니다.
 * 남은 후보가 둘인데 코드만 봐서는 못 가린다: 클라이언트가 `cliprdr` 채널을 **광고조차 안 하는가**,
 * 아니면 광고하는데 서버가 안 붙여 주는가.
 *
 * 릴레이가 TLS 를 끝내므로 **여기 지나는 바이트는 평문 RDP** 다 — 이 앱에서 그 스트림을 볼 수 있는
 * 자리는 여기뿐이다. MCS Connect Initial 안 CS_NET 블록([MS-RDPBCGR] 2.2.1.3.4)의 채널 이름은
 * 8바이트 ASCII 라 그대로 읽힌다. 채널 목록은 접속 초반에 한 번만 지나가므로 앞쪽 몇 덩어리만 본다.
 */
const SVC_SNIFF = ['cliprdr', 'rdpdr', 'rdpsnd', 'drdynvc', 'rdpgfx', 'rail']
const SVC_SNIFF_CHUNKS = 16

function pipe(ws: WebSocket, sock: tls.TLSSocket, done: (reason?: string) => void): void {
  let closed = false
  const finish = (reason?: string) => {
    if (closed) return
    closed = true
    try {
      sock.destroy()
    } catch {
      /* 이미 닫힌 소켓 */
    }
    try {
      ws.close()
    } catch {
      /* 이미 닫힌 소켓 */
    }
    done(reason)
  }
  sock.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk)
  })
  sock.on('error', (e) => finish(e.message))
  sock.on('close', () => finish())
  // TEMP-DIAG(#165): 위 SVC_SNIFF 주석 참고. 판정 한 줄만 남기고 통과시킨다 — 바이트는 안 건드린다.
  const svcSeen = new Set<string>()
  let sniffLeft = SVC_SNIFF_CHUNKS
  ws.on('message', (data) => {
    const buf = data as Buffer
    if (sniffLeft > 0 && Buffer.isBuffer(buf)) {
      sniffLeft -= 1
      for (const name of SVC_SNIFF) if (buf.includes(name)) svcSeen.add(name)
      // 창이 닫히는 순간 한 번만 말한다. 하나도 없으면 그게 답이다("(없음)").
      if (sniffLeft === 0) {
        console.log('[rdp-diag svc] 클라이언트가 광고한 정적 채널:', [...svcSeen].join(', ') || '(없음)')
      }
    }
    sock.write(buf)
  })
  ws.on('error', (e) => finish(e.message))
  ws.on('close', () => finish())
}

// 릴레이 하나를 띄운다. 반환된 url 을 렌더러가 proxyAddress 로 쓴다.
export function startRdpRelay({ host, port, onClosed }: StartOpts): Promise<RdpRelayHandle> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(24).toString('hex')
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    let accepted = false
    let acceptTimer: ReturnType<typeof setTimeout> | null = null

    const shutdown = (reason?: string) => {
      if (acceptTimer) clearTimeout(acceptTimer)
      acceptTimer = null
      try {
        wss.close()
      } catch {
        /* 이미 닫힘 */
      }
      try {
        http.close()
      } catch {
        /* 이미 닫힘 */
      }
      onClosed?.(reason)
    }

    http.on('upgrade', (req, socket, head) => {
      // 1회용 토큰 경로가 아니면 즉시 끊는다. 연결도 하나만 받는다.
      if (accepted || req.url !== `/${token}`) {
        socket.destroy()
        return
      }
      accepted = true
      if (acceptTimer) clearTimeout(acceptTimer)
      acceptTimer = null
      wss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
        // 첫 메시지 = RDCleanPath 요청. 그 뒤부터는 순수 바이트 릴레이.
        ws.once('message', async (data) => {
          try {
            const req0 = parseCleanPathRequest(Buffer.from(data as Buffer))
            // 실제 관문은 URL 경로의 1회용 토큰이다(위 upgrade 검사). proxy_auth 는 클라이언트가
            // 어떤 형식으로 실어 보낼지 구현마다 달라 여기서 하드 실패로 만들지 않는다 — 불일치는
            // 기록만 하고 진행한다(이걸로 막으면 정상 접속이 "general error" 로 죽는다).
            if (req0.proxyAuth && req0.proxyAuth !== token) {
              console.warn('[rdp] proxy_auth 가 URL 토큰과 다릅니다(무시하고 진행)')
            }
            // destination 은 참고만 한다 — 실제 접속은 main 이 정한 host:port 로 한다.
            void req0.destination
            const { x224Response, certChain, socket: tlsSock } = await rdpHandshake(host, port, req0.x224ConnectionRequest)
            ws.send(buildCleanPathResponse(`${host}:${port}`, x224Response, certChain))
            pipe(ws, tlsSock, (reason) => shutdown(reason))
          } catch (e) {
            try {
              ws.send(buildCleanPathError(1))
            } catch {
              /* 이미 닫힘 */
            }
            ws.close()
            const reason = e instanceof Error ? e.message : String(e)
            console.error('[rdp] 릴레이 실패:', reason)
            shutdown(reason)
          }
        })
      })
    })

    http.once('error', (e) => {
      shutdown(e.message)
      reject(e)
    })

    // 포트 0 = OS 가 임시 포트를 준다. loopback 에만 바인드한다.
    http.listen(0, '127.0.0.1', () => {
      const addr = http.address()
      if (!addr || typeof addr === 'string') {
        shutdown('릴레이 포트를 확인할 수 없습니다')
        reject(new Error('릴레이 포트를 확인할 수 없습니다'))
        return
      }
      acceptTimer = setTimeout(() => {
        if (!accepted) shutdown('클라이언트가 연결하지 않았습니다')
      }, ACCEPT_TIMEOUT_MS)
      resolve({ url: `ws://127.0.0.1:${addr.port}/${token}`, token, close: () => shutdown() })
    })
  })
}
