// F1a 훅 수신 서버 — CLI 가 자기 상태를 알려 오는 자리(docs/orca-analysis.md §3).
//
// McpServer.ts 의 규율을 그대로 따른다: **127.0.0.1 고정 바인드 · 토큰 상수시간 비교 · 렌더러로는
// pushSend 경유.** 새 방식을 만들지 않는다. 다른 점은 포트뿐이다 — MCP 는 외부 클라이언트가 설정에
// 적어 두는 고정 포트지만, 훅 포트는 **우리가 env 로 알려 주므로** 고정할 이유가 없다.
// 그래서 0 으로 열어 OS 가 주는 것을 쓴다(39217 이 이미 고정 포트 충돌을 겪었다).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { applyHook, isHookCli, type AgentStatus } from '@shared/agentStatus'
import { BIND_HOST, hashToken, safeEqualHex } from '../mcp/McpServer'
import { HOOK_PANE_HEADER, HOOK_TOKEN_HEADER } from './claudeHooks'

export type AgentHookServerHandle = {
  /** 리슨을 시작하고 잡은 포트를 돌려준다. 실패하면 0 — 앱은 그대로 뜨고 상태가 `unverifiable` 로 남는다. */
  start(): Promise<number>
  port(): number
  statuses(): AgentStatus[]
  /** 세션이 끝나면 그 상태도 지운다 — 죽은 세션의 상태가 원장에 남으면 그게 곧 유령이다. */
  forget(sessionId: string): void
  stop(): Promise<void>
}

// `/hook/<cli>/<event>` — cli 가 경로에 있는 것이 다른 CLI 를 갈아 끼울 자리다(어댑터 seam).
const HOOK_PATH = /^\/hook\/([a-z]+)\/([A-Za-z]+)$/

export function createAgentHookServer(opts: {
  /** 훅 설정에 심어 둔 토큰. 이 값과 맞는 요청만 상태를 바꾼다. */
  token: string
  onStatus: (s: AgentStatus) => void
  /** 테스트 seam. 프로덕션은 0(OS 가 고른다). */
  bindPort?: number
}): AgentHookServerHandle {
  const statuses = new Map<string, AgentStatus>()
  let httpServer: HttpServer | null = null
  let boundPort = 0
  const expected = hashToken(opts.token)

  function authOk(req: IncomingMessage): boolean {
    const got = req.headers[HOOK_TOKEN_HEADER]
    if (typeof got !== 'string' || got.length === 0) return false
    return safeEqualHex(hashToken(got), expected)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    // 본문은 **읽되 담지 않는다**: 이벤트 이름은 URL 에 있고(설치할 때 우리가 넣었다) 페이로드는
    // PostToolUse 처럼 수백 KB 가 될 수 있다. 그래도 흘려보내야 훅 쪽 쓰기가 EPIPE 를 안 본다.
    req.resume()
    const done = (code: number): void => {
      if (req.readableEnded) res.writeHead(code).end()
      else req.on('end', () => res.writeHead(code).end())
    }
    if (!authOk(req)) return done(401)
    if (req.method !== 'POST') return done(405)
    const m = HOOK_PATH.exec(req.url ?? '')
    if (!m || !isHookCli(m[1] ?? '')) return done(404)
    const cli = m[1] as 'claude'
    const event = m[2] ?? ''
    // 어느 탭인지는 훅이 env 로 되돌려 준다. 없으면 **우리 터미널에서 뜬 것이 아니다**
    // (예: 아라 대화가 띄운 헤드리스 claude). 붙일 자리가 없으니 아무 주장도 하지 않는다.
    const pane = req.headers[HOOK_PANE_HEADER]
    if (typeof pane !== 'string' || pane.length === 0) return done(204)

    const next = applyHook(statuses.get(pane) ?? null, { cli, sessionId: pane, event }, Date.now())
    if (next) {
      statuses.set(pane, next)
      opts.onStatus(next)
    }
    done(204)
  }

  return {
    start() {
      return new Promise<number>((resolvePromise) => {
        const s = createServer((req, res) => {
          try {
            onRequest(req, res)
          } catch {
            // 훅 하나가 실패해도 서버는 산다 — 상태 표시가 앱을 흔들면 안 된다.
            if (!res.headersSent) res.writeHead(500).end()
          }
        })
        const onError = (): void => {
          s.removeListener('listening', onListening)
          httpServer = null
          resolvePromise(0)
        }
        const onListening = (): void => {
          s.removeListener('error', onError)
          const a = s.address()
          boundPort = typeof a === 'object' && a !== null ? a.port : 0
          resolvePromise(boundPort)
        }
        s.once('error', onError)
        s.once('listening', onListening)
        s.listen(opts.bindPort ?? 0, BIND_HOST)
        httpServer = s
      })
    },
    port: () => boundPort,
    statuses: () => [...statuses.values()],
    forget(sessionId) {
      statuses.delete(sessionId)
    },
    async stop() {
      const s = httpServer
      httpServer = null
      boundPort = 0
      if (s) await new Promise<void>((resolvePromise) => s.close(() => resolvePromise()))
    }
  }
}
