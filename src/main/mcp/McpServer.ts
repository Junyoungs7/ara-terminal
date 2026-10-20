// F23 MCP 서버 — main 프로세스 내 HTTP 리스너, 127.0.0.1 고정 바인드(설계 §1.1). 기본 꺼짐 — 설정
// [MCP]에서 명시적으로 켠다(F12·F16 과 같은 원칙). 포트는 상수(설계 §7 오케 확정 4 — 설정으로 노출 안 함).
//
// stdio 를 쓰지 않는 이유(설계 §1.1): A.R.A 는 이미 떠 있는 GUI 앱이고 세션·vault·소켓이 이미 살아
// 있다 — "클라이언트가 서버를 낳는다"는 stdio 의 전제와 안 맞는다. Claude Code 가 원격 HTTP MCP 서버
// 등록을 지원하므로 stdio↔HTTP 프록시 셈은 필요가 증명되지 않았다(YAGNI).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { MCP_DEFAULT_PORT } from '@shared/types'
import { registerMcpTools, type ToolCtx } from './tools'

// 바인드 주소 하드코딩 — 계약·설정에 이 값을 바꿀 경로가 없다(F8 PortForward.LOCAL_BIND 와 같은 형태의
// 불변식). scan:magic·보안 리뷰가 여기 하나만 확인하면 된다.
export const BIND_HOST = '127.0.0.1'

// vault 키(해시만 저장). SafeStorageSecretStore 가 이 문자열을 다시 암호화해서 저장한다(이중 방어).
export const MCP_TOKEN_VAULT_KEY = 'mcp.tokenHash'

/**
 * **아라 자신이 쓰는 토큰**(#124). 사용자에게 보여 주는 토큰과 **별개 키**다.
 *
 * 왜 나눴나: 아라 대화를 열 때마다 우리 토큰을 새로 발급하는데(§3.2 — 그 순간 발급한 토큰),
 * 키가 하나면 그 발급이 **사용자가 외부 클라이언트에 넣어 둔 토큰을 무효로 만든다**
 * (Claude Desktop 에 등록해 둔 것이 조용히 끊긴다). 저장하는 것은 여전히 해시뿐이다.
 */
export const MCP_SELF_TOKEN_VAULT_KEY = 'mcp.tokenHash.self'

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// 상수시간 비교(타이밍 공격 방어). 해시는 항상 64 hex 문자라 길이 분기 자체가 원문 토큰에 대한 정보를
// 새지 않는다. F1a 훅 서버도 이걸 쓴다 — 토큰 비교 방식이 두 벌로 갈리면 한쪽만 약해진다.
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export type TokenVault = { get(key: string): string | null; set(key: string, value: string): void; has(key: string): boolean }

// 256비트 이상 랜덤 토큰(설계 §1.2). base64url — 클라이언트 설정 파일에 그대로 붙여넣기 좋은 형태.
export function issueRawToken(): string {
  return randomBytes(32).toString('base64url')
}

export type McpServerHandle = {
  setEnabled(on: boolean): Promise<{ ok: true; port?: number }>
  isEnabled(): boolean
  port(): number
  connectedCount(): number
  disconnectClient(): void
  // 포트가 실제로 반환된 뒤에 resolve 된다(setEnabled(false)→true 재토글, 테스트의 재시작 경합 방지).
  stop(): Promise<void>
}

// S2(GAP I1): 인증된 로컬 클라이언트만 도달 가능한 경로지만, SessionLog.ts의 MAX_LINE(같은 목적 —
// 상한 없는 버퍼링이 main 힙을 무제한 소비하는 것을 막음)과 같은 크기로 클램프한다.
export const MCP_MAX_BODY_BYTES = 1024 * 1024
export class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      // 상한을 넘는 뒤쪽은 담지 않는다(힙 상한이 목적 — 응답을 정상적으로 보내려면 소켓은 계속
      // 흘려보내야 하므로 req.destroy() 로 끊지 않는다, 끊으면 413 응답 자체가 못 나간다).
      if (total <= MCP_MAX_BODY_BYTES) chunks.push(c)
    })
    req.on('end', () => {
      if (total > MCP_MAX_BODY_BYTES) return reject(new BodyTooLargeError('요청 본문이 너무 큽니다.'))
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolvePromise(undefined)
      try {
        resolvePromise(JSON.parse(raw))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

// vault: 토큰 해시 저장소(SafeStorageSecretStore 를 그대로 넘긴다 — 새 vault 를 만들지 않는다).
// bindPort: 테스트 seam(ARA_AI_FAKE 와 같은 관행) — 0 이면 OS 가 빈 포트를 골라 매 테스트가 고정
// 포트 재바인딩 타이밍(TIME_WAIT)과 경쟁하지 않는다. 프로덕션 호출자는 넘기지 않는다(항상 MCP_DEFAULT_PORT).
export function createMcpServer(ctx: ToolCtx, vault: TokenVault, bindPort: number = MCP_DEFAULT_PORT): McpServerHandle {
  let httpServer: HttpServer | null = null
  let transport: StreamableHTTPServerTransport | null = null
  let mcp: SdkMcpServer | null = null
  let boundPort = bindPort

  // 지금 연결이 아라 전용 토큰으로 열렸나(아라 채팅 v2). 이 연결의 도구 호출만 caller='ara' 다 —
  // 지금 보는 세션에 묻지 않고 칠 수 있는 것은 아라 채팅뿐이고, 외부 클라이언트(사용자 토큰)는 그대로 묻는다.
  let selfConn = false

  /** 어느 토큰과 맞았나. 'self' = 아라 전용, 'user' = 사용자가 외부 클라이언트에 넣은 것, null = 실패. */
  function authKind(req: IncomingMessage): 'user' | 'self' | null {
    // 받아 주는 토큰은 둘이다: 사용자 것과 아라 것(위 MCP_SELF_TOKEN_VAULT_KEY 참고).
    // 둘 다 없으면 아무도 못 들어온다 — 인증 없는 경로는 만들지 않는다.
    const header = req.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    const token = header.slice('Bearer '.length).trim()
    if (token.length === 0) return null
    const got = hashToken(token)
    // 비교는 각 해시마다 상수시간이다. 어느 쪽과 맞았는지만 갈리고 비밀은 새지 않는다.
    const match = (k: string): boolean => {
      const h = vault.has(k) ? vault.get(k) : null
      return typeof h === 'string' && h.length > 0 && safeEqualHex(got, h)
    }
    if (match(MCP_SELF_TOKEN_VAULT_KEY)) return 'self'
    if (match(MCP_TOKEN_VAULT_KEY)) return 'user'
    return null
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 인증 전에는 initialize 핸드셰이크조차 진행하지 않는다 — 툴 목록도 인증 전엔 새어나가지 않는다.
    const kind = authKind(req)
    if (!kind) return rpcError(res, 401, -32001, '인증되지 않았습니다.')
    // 아라 연결에는 아라 토큰으로만 말을 건다 — 사용자 토큰을 쥔 쪽이 그 연결에 끼어들어 'ara' 권한을 빌리지 못하게.
    if (transport && selfConn && kind !== 'self') return rpcError(res, 401, -32001, '인증되지 않았습니다.')

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await readBody(req)
      } catch (e) {
        res.writeHead(e instanceof BodyTooLargeError ? 413 : 400).end()
        return
      }
      const hasSession = typeof req.headers['mcp-session-id'] === 'string'
      if (!hasSession && isInitializeRequest(body)) {
        // 단일 연결만 허용(설계 §1.6) — 이미 연결이 있으면 새 초기화 시도 자체를 거부한다(기존
        // 연결에 손대지 않는다).
        if (transport) {
          rpcError(res, 409, -32000, '이미 다른 MCP 클라이언트가 연결되어 있습니다. 설정에서 연결을 끊은 뒤 다시 시도하세요.')
          return
        }
        const server = new SdkMcpServer({ name: 'ara-terminal', version: '1.0.0' })
        const isSelf = kind === 'self'
        registerMcpTools(server, ctx, () => (isSelf ? 'ara' : 'external'))
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
        t.onclose = () => {
          if (transport === t) transport = null
          if (mcp === server) mcp = null
        }
        transport = t
        selfConn = isSelf
        mcp = server
        await server.connect(t)
        await t.handleRequest(req, res, body)
        return
      }
      if (!transport) {
        rpcError(res, 400, -32000, '세션이 없습니다.')
        return
      }
      await transport.handleRequest(req, res, body)
      return
    }

    // GET(SSE 스트림)/DELETE(세션 종료) — 기존 연결로만 라우팅한다.
    if (!transport) {
      res.writeHead(400).end()
      return
    }
    await transport.handleRequest(req, res)
  }

  function listen(): Promise<number | null> {
    return new Promise((resolvePromise) => {
      const s = createServer((req, res) => {
        onRequest(req, res).catch((err) => {
          process.stderr.write(`[mcp] 요청 처리 실패: ${String(err)}\n`)
          if (!res.headersSent) res.writeHead(500).end()
          else res.end()
        })
      })
      const onError = (): void => {
        s.removeListener('listening', onListening)
        resolvePromise(null)
      }
      const onListening = (): void => {
        s.removeListener('error', onError)
        const a = s.address()
        resolvePromise(typeof a === 'object' && a !== null ? a.port : null)
      }
      s.once('error', onError)
      s.once('listening', onListening)
      s.listen(bindPort, BIND_HOST)
      httpServer = s
    })
  }

  async function stop(): Promise<void> {
    await transport?.close().catch(() => {})
    transport = null
    mcp = null
    const s = httpServer
    httpServer = null
    if (s) await new Promise<void>((resolvePromise) => s.close(() => resolvePromise()))
  }

  return {
    async setEnabled(on) {
      if (!on) {
        await stop()
        return { ok: true }
      }
      if (httpServer) return { ok: true, port: boundPort } // 이미 켜져 있음(멱등)
      const port = await listen()
      if (port === null) {
        httpServer = null
        return { ok: true } // 리슨 실패 — enabled 상태는 false 로 남는다(mcp:getState 가 진실)
      }
      boundPort = port
      return { ok: true, port }
    },
    isEnabled() {
      return httpServer !== null
    },
    port() {
      return boundPort
    },
    connectedCount() {
      return transport ? 1 : 0
    },
    disconnectClient() {
      void transport?.close()
    },
    stop
  }
}
