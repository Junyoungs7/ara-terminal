// F1a 훅 수신 서버 — CLI 가 자기 상태를 알려 오는 자리(docs/orca-analysis.md §3).
//
// McpServer.ts 의 규율을 그대로 따른다: **127.0.0.1 고정 바인드 · 토큰 상수시간 비교 · 렌더러로는
// pushSend 경유.** 새 방식을 만들지 않는다. 다른 점은 포트뿐이다 — MCP 는 외부 클라이언트가 설정에
// 적어 두는 고정 포트지만, 훅 포트는 **우리가 env 로 알려 주므로** 고정할 이유가 없다.
// 그래서 0 으로 열어 OS 가 주는 것을 쓴다(39217 이 이미 고정 포트 충돌을 겪었다).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { applyHook, isHookCli, isUserExit, type AgentStatus, type HookCli, type RemoteHookReport } from '@shared/agentStatus'
import { BIND_HOST, hashToken, safeEqualHex } from '../mcp/McpServer'
import { HOOK_PANE_HEADER, HOOK_TOKEN_HEADER } from './claudeHooks'

/**
 * 원격(F1b)이 쓰는 좁은 모양 — 포트를 묻고 그 서버의 토큰을 등록한다.
 * 세션 매니저가 이것만 들고 있으면 SSH 접속 경로가 훅 서버 전체를 알 필요가 없다.
 */
export type HookSink = {
  port(): number
  /**
   * 소유자별 토큰 등록. **서버마다 토큰이 다르다**(원격 `~/.claude/settings.json` 은 호스트마다
   * 따로 있고, 그 파일에서 되찾은 값이 곧 그 호스트의 토큰이다). 소유자는 세션 id 라 세션이
   * 끝나면 `forget` 이 같이 지운다 — 죽은 서버의 토큰이 계속 통하면 그게 곧 남은 열쇠다.
   */
  setToken(owner: string, token: string): void
  /**
   * #162 그 서버의 설치 결과를 화면 쪽으로 올린다. **세션이 아니라 서버 단위**라 `forget` 이
   * 안 지운다 — 탭을 닫은 뒤에도 "그 서버는 왜 안 됐나"는 남아 있어야 답이 된다.
   * 두 번에 나눠 온다(설치 → tty 폴백): 아는 것부터 화면에 올리려고.
   */
  report(server: string, patch: Partial<RemoteHookReport>): void
}

export type AgentHookServerHandle = HookSink & {
  /** 리슨을 시작하고 잡은 포트를 돌려준다. 실패하면 0 — 앱은 그대로 뜨고 상태가 `unverifiable` 로 남는다. */
  start(): Promise<number>
  statuses(): AgentStatus[]
  /** #162 이번 실행에서 붙어 본 원격 서버들의 설치 결과. 설정 [AI] 가 그대로 읽는다. */
  remotes(): RemoteHookReport[]
  /** 세션이 끝나면 그 상태도, 그 세션이 등록한 토큰도 지운다 — 죽은 세션의 것이 남으면 그게 곧 유령이다. */
  forget(sessionId: string): void
  stop(): Promise<void>
}

/** 로컬 훅 토큰의 소유자 이름. 세션 id 는 uuid 라 이 이름과 부딪히지 않는다. */
const LOCAL_OWNER = 'local'

// `/hook/<cli>/<event>` — cli 가 경로에 있는 것이 다른 CLI 를 갈아 끼울 자리다(어댑터 seam).
const HOOK_PATH = /^\/hook\/([a-z]+)\/([A-Za-z]+)$/

/**
 * `SessionEnd` 본문에서 읽어 볼 앞머리(바이트). 이 이벤트의 페이로드는 짧다 —
 * `session_id`·`transcript_path`·`cwd`·`hook_event_name`·`reason` 뿐이라 4KB 면 남는다.
 * **다른 이벤트는 한 바이트도 담지 않는다**(PostToolUse 는 파일 내용을 통째로 싣고 온다).
 */
const BODY_PEEK = 4096

/** 본문에서 `reason` 하나만 꺼낸다. 못 읽으면 `null` — 모르면 모르는 대로 `unverifiable` 이 된다. */
function reasonOf(body: Buffer): string | null {
  try {
    const r = (JSON.parse(body.toString('utf8')) as { reason?: unknown }).reason
    return typeof r === 'string' ? r : null
  } catch {
    return null
  }
}

export function createAgentHookServer(opts: {
  /** 로컬 `~/.claude/settings.json` 에 심어 둔 토큰. 원격 것은 `setToken` 으로 뒤에 붙는다. */
  token: string
  onStatus: (s: AgentStatus) => void
  /**
   * 사용자가 자기 손으로 끝낸 세션 — **줄을 지우라는 신호**(`isUserExit`).
   *
   * `onStatus` 와 갈라 둔 이유가 이 라운드의 절반이다: `AgentStatus` 에는 "없음"을 담을 값이
   * 없어서, 상태 채널 하나로는 main 이 원장에서 지워도 그 사실이 렌더러에 도착하지 못했다
   * (그래서 #160 은 지우기를 아예 쓰지 못하고 `unverifiable` 로 표 한 줄을 놨다).
   */
  onExit: (sessionId: string) => void
  /** 테스트 seam. 프로덕션은 0(OS 가 고른다). */
  bindPort?: number
}): AgentHookServerHandle {
  const statuses = new Map<string, AgentStatus>()
  let httpServer: HttpServer | null = null
  let boundPort = 0
  // 소유자 → 토큰 해시. **집합인 것이 요점이다**: 서버가 하나뿐이던 시절엔 토큰도 하나였는데,
  // 그대로 원격을 붙이면 서버 N 개가 같은 열쇠를 쓰게 되고 그러면 어느 서버의 훅이든 다른 서버의
  // 훅인 척할 수 있다. McpServer.authOk 의 `expected` 배열과 같은 모양이다.
  const tokens = new Map<string, string>([[LOCAL_OWNER, hashToken(opts.token)]])
  // #162 서버 → 설치 결과. 서버 대수만큼만 자라고(세션 수가 아니다) 화면이 그대로 읽는다.
  const reports = new Map<string, RemoteHookReport>()

  function authOk(req: IncomingMessage): boolean {
    const got = req.headers[HOOK_TOKEN_HEADER]
    if (typeof got !== 'string' || got.length === 0) return false
    const hash = hashToken(got)
    // 비교는 해시마다 상수시간이다. 어느 것과 맞았는지만 갈리고 비밀은 새지 않는다(MCP 와 같은 규율).
    for (const expected of tokens.values()) {
      if (safeEqualHex(hash, expected)) return true
    }
    return false
  }

  /** 훅 하나를 원장에 반영하고 화면으로 민다. */
  function apply(cli: HookCli, pane: string, event: string): void {
    const next = applyHook(statuses.get(pane) ?? null, { cli, sessionId: pane, event }, Date.now())
    if (!next) return
    statuses.set(pane, next)
    opts.onStatus(next)
  }

  /**
   * 사용자가 끝낸 세션의 상태를 버린다. **`forget` 이 아니다 — 토큰은 남긴다**(그 함정은
   * `isUserExit` 주석과 tests/agentHooks.test.ts 의 #160 검사에 적혀 있다).
   *
   * 원장에 그 세션이 없었어도 신호는 민다: 렌더러에는 **실행 기록**(`aiRuns`)이 따로 남아 있고,
   * 그 줄을 걷어내는 것도 이 신호의 몫이다(목록의 근거가 `runs ∪ statuses` 라서 상태만 지우면
   * 줄은 `확인 불가` 로 그대로 서 있다 — 준영님이 보신 것이 정확히 그 화면이다).
   */
  function dropStatus(pane: string): void {
    statuses.delete(pane)
    opts.onExit(pane)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    // 본문은 **끝까지 흘려보낸 뒤** 답한다 — 안 읽으면 훅 쪽 쓰기가 EPIPE 를 본다.
    const after = (fn: () => void): void => {
      if (req.readableEnded) fn()
      else req.on('end', fn)
      req.resume()
    }
    const done = (code: number): void => after(() => void res.writeHead(code).end())
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

    // 이벤트 이름은 URL 에 있어(설치할 때 우리가 넣었다) 본문을 볼 이유가 없었다. `SessionEnd`
    // 하나만 예외다 — **누가 끝냈나**를 가르는 `reason` 이 본문에만 있다. 나머지는 그대로 흘려보낸다.
    if (event !== 'SessionEnd') {
      apply(cli, pane, event)
      return done(204)
    }
    const head: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      if (size >= BODY_PEEK) return
      head.push(c.subarray(0, BODY_PEEK - size))
      size += c.length
    })
    after(() => {
      if (isUserExit(event, reasonOf(Buffer.concat(head)))) dropStatus(pane)
      else apply(cli, pane, event)
      res.writeHead(204).end()
    })
  }

  return {
    start() {
      return new Promise<number>((resolvePromise) => {
        const s = createServer((req, res) => {
          try {
            onRequest(req, res)
          } catch {
            // 훅 하나가 실패해도 서버는 산다 — 상태 표시가 앱을 흔들면 안 된다.
            // 본문은 여기서도 흘려보낸다: 던진 자리가 `after` 앞이면 아무도 안 읽어 훅이
            // 자기 타임아웃(-m 2)까지 매달린다.
            req.resume()
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
    remotes: () => [...reports.values()],
    setToken(owner, token) {
      if (owner === LOCAL_OWNER || !owner || !token) return
      tokens.set(owner, hashToken(token))
    },
    report(server, patch) {
      const prev = reports.get(server)
      const install = patch.install ?? prev?.install
      // 설치 결과 없이 폴백만 오는 일은 없다(순서가 그렇다). 와도 반쪽짜리 줄은 안 만든다.
      if (!server || !install) return
      reports.set(server, { server, install, fallback: patch.fallback ?? prev?.fallback ?? 'pending' })
    },
    forget(sessionId) {
      statuses.delete(sessionId)
      tokens.delete(sessionId)
    },
    async stop() {
      const s = httpServer
      httpServer = null
      boundPort = 0
      if (s) await new Promise<void>((resolvePromise) => s.close(() => resolvePromise()))
    }
  }
}
