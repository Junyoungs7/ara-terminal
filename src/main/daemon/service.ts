// M4 DM-01 — 앱(main) 쪽 데몬 관리: 켤 때 살아 있는 데몬에 다시 붙어 세션을 되살리고(replay), 에이전트 PTY 를 데몬에 만들고,
// 데몬이 죽으면 알아채(세션은 '잃음'으로 끝냄) 다시 띄운다. 데몬 세션은 MainSessionManager.adopt 로 아라의 같은 세션 파이프라인
// (배칭·재생 버퍼·탭·상태 판정 tap)에 태운다 — 화면·IPC 는 로컬 PTY 와 구별하지 않는다.
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/daemon/{daemon-pty-adapter,daemon-pty-daemon-recovery,daemon-respawn-throttle}.ts — 핵심만.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_SESSION_LOST_EXIT } from '@shared/agentHooks'
import type { AgentLimits } from '@shared/resources'
import type { SessionBackend } from '../sessions/SessionBackend'
import { RecoveryCircuitBreaker } from '../stability/recoveryBreaker'
import { connectDaemon, type DaemonConnection } from './client'
import { DAEMON_PROTOCOL_VERSION, PREVIOUS_DAEMON_PROTOCOL_VERSIONS, daemonPaths, judgeDaemon, type DaemonCreateSpec, type DaemonSessionInfo } from './protocol'
import { spawnDaemon, type DaemonRuntime } from './launcher'

/** 완전 종료 때 데몬이 내려가기를 기다리는 상한(데몬 쪽 상한 5초 + 여유). */
const SHUTDOWN_WAIT_MS = 6_000

/** 데몬 세션 하나를 아라 세션 파이프라인에 태우는 어댑터. */
class DaemonBackend implements SessionBackend {
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((code: number, signal?: number) => void) | null = null
  private ended = false
  constructor(
    readonly id: string,
    readonly pid: number,
    readonly conn: DaemonConnection
  ) {}
  write(data: string): void {
    this.conn.fire({ type: 'write', id: this.id, data })
  }
  resize(cols: number, rows: number): void {
    this.conn.fire({ type: 'resize', id: this.id, cols, rows })
  }
  // ponytail: 백프레셔(렌더러 xterm 백로그 → pty 멈춤)는 데몬까지 안 넘긴다 — 출력은 데몬·소켓 버퍼에 쌓인다. 대량 출력 에이전트가 문제면 데몬에 pause 요청을.
  pause(): void {}
  resume(): void {}
  kill(): void {
    void this.conn.request({ type: 'kill', id: this.id }).catch(() => {})
  }
  /** 앱 종료(destroyAll) 때 — 죽이지 않고 놓는다. 세션은 데몬에서 산다. */
  detach(): void {}
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (code: number, signal?: number) => void): void {
    this.exitCb = cb
  }
  emitData(d: string): void {
    this.dataCb?.(d)
  }
  emitExit(code: number, signal?: number): void {
    if (this.ended) return
    this.ended = true
    this.exitCb?.(code, signal)
  }
}

export type DaemonSessionMeta = Record<string, unknown>

export type AgentDaemon = {
  /** 켤 때 한 번: 살아 있는 데몬(같은 판·아는 옛 판)에 붙어 세션을 되살린다. 데몬을 새로 띄우지는 않는다. */
  ready: Promise<void>
  /** 데몬에 세션을 만든다(없으면 띄움). 실패하면 던진다 — 부른 쪽이 로컬 PTY 로 넘어간다. */
  create(spec: Omit<DaemonCreateSpec, 'id'> & { id: string }): Promise<DaemonSessionInfo>
  /** 데몬 세션 모두 끄기(백그라운드 에이전트 모두 종료). 끈 수. */
  killAll(): Promise<number>
  /** 완전 종료: 세션까지 끝내고 데몬을 내린다. */
  shutdownAll(): Promise<void>
  /** 앱 종료 — 연결만 끊는다(세션·데몬은 산다). */
  disconnect(): void
  /** 이 세션은 데몬에 산다(앱이 꺼져도 남는다). */
  owns(id: string): boolean
  /** M4 R3 자원 상한이 바뀌었다(설정 › 에이전트) — 붙어 있는 데몬 모두에게. 붙을 때는 deps.limits() 를 알아서 보낸다. */
  setLimits(limits: AgentLimits): void
}

export function createAgentDaemon(deps: {
  runtimeDir: string
  logFile: () => string
  appVersion: string
  /** e2e: 앱이 떠나면 데몬도 세션째 내려간다(시험 뒤 프로세스를 남기지 않게). */
  exitWithClients?: boolean
  /** 띄울 런타임(설치 폴더 밖으로 옮긴 것 또는 설치 것). */
  runtime: () => Promise<DaemonRuntime>
  /** 데몬 세션을 아라 세션 파이프라인에 넣는다(MainSessionManager.adopt). */
  adopt: (backend: SessionBackend, info: DaemonSessionInfo) => void
  /** 켤 때 되살린 세션(탭 복원·상태 판정). adopt 뒤에 불린다. */
  restored: (info: DaemonSessionInfo) => void
  log: (msg: string) => void
  /** M4 R3: 지금 자원 상한(붙을 때마다 데몬에 보낸다). 안 주면 보내지 않는다. */
  limits?: () => AgentLimits
  /** 데몬이 알린 메모리 상한 넘음(세션마다 넘어설 때 한 번). */
  memoryOver?: (e: { id: string; memory: number; limit: number }) => void
  /** 판 규칙(Orca) — 시험이 판 올림을 흉내 낼 때만 준다. */
  protocol?: { current: number; previous: readonly number[] }
}): AgentDaemon {
  const CURRENT = deps.protocol?.current ?? DAEMON_PROTOCOL_VERSION
  const PREVIOUS = deps.protocol?.previous ?? PREVIOUS_DAEMON_PROTOCOL_VERSIONS
  const backends = new Map<string, DaemonBackend>()
  let current: DaemonConnection | null = null
  let connecting: Promise<DaemonConnection> | null = null
  const drains = new Set<DaemonConnection>()
  // 다시 띄우기는 60초 안 3번까지(FD-04·utilityHost 와 같은 차단기 — 무한 재시작 금지).
  const breaker = new RecoveryCircuitBreaker({ windowMs: 60_000, maxRecoveries: 3 })
  let quitting = false

  const readToken = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8').trim() || null
    } catch {
      return null
    }
  }

  const wire = (conn: DaemonConnection, kind: 'current' | 'drain'): void => {
    conn.onEvent((e) => {
      if (e.type === 'memoryOver') return deps.memoryOver?.(e)
      const b = backends.get(e.id)
      if (!b) return
      if (e.type === 'data') return b.emitData(e.data)
      backends.delete(e.id)
      b.emitExit(e.code, e.signal)
      // 옛 판 데몬: 그 세션이 다 끝나면 놓는다 → 붙은 앱도 세션도 없으니 데몬이 스스로 내려간다(교체 완료).
      if (kind === 'drain' && ![...backends.values()].some((x) => x.conn === conn)) {
        drains.delete(conn)
        conn.close()
      }
    })
    conn.onClose((intentional) => {
      if (kind === 'current' && current === conn) current = null
      drains.delete(conn)
      if (intentional || quitting) return
      // 데몬이 죽었다 — 그 세션들은 잃었다고 끝낸다.
      const lost = [...backends.values()].filter((b) => b.conn === conn)
      deps.log(`agent daemon connection lost (${kind}) — ${lost.length} session(s) lost`)
      for (const b of lost) {
        backends.delete(b.id)
        b.emitExit(AGENT_SESSION_LOST_EXIT)
      }
      if (kind !== 'current') return
      if (!breaker.registerRecoveryAttempt(Date.now()).allowed) return deps.log('agent daemon respawn gave up (3 in 60s)')
      void ensureCurrent().catch((e) => deps.log(`agent daemon respawn failed: ${String(e)}`))
    })
  }

  const attach = async (conn: DaemonConnection, info: DaemonSessionInfo, restored: boolean): Promise<void> => {
    const b = new DaemonBackend(info.id, info.pid, conn)
    backends.set(info.id, b)
    deps.adopt(b, info)
    if (restored) deps.restored(info)
    try {
      await conn.request({ type: 'attach', id: info.id })
    } catch {
      // 그 사이 끝났다 — exit 사건이 이미 왔거나 곧 온다. 안 오면 여기서 끝낸다.
      backends.delete(info.id)
      b.emitExit(0)
    }
  }

  const paths = (v: number) => daemonPaths(deps.runtimeDir, v)
  // 옛 데몬(이 요청을 모름)은 오류로 답한다 — 상한 없이 계속 쓴다.
  const sendLimits = async (conn: DaemonConnection): Promise<void> => {
    if (deps.limits) await conn.request({ type: 'limits', limits: deps.limits() }).catch(() => {})
  }

  const ensureCurrent = (): Promise<DaemonConnection> => {
    if (current) return Promise.resolve(current)
    connecting ??= (async () => {
      const { socketPath, tokenPath } = paths(CURRENT)
      const token = readToken(tokenPath)
      let conn = token ? await connectDaemon(socketPath, token).catch(() => null) : null
      if (!conn) {
        const fresh = await spawnDaemon({ runtime: await deps.runtime(), runtimeDir: deps.runtimeDir, socketPath, tokenPath, logFile: deps.logFile(), appVersion: deps.appVersion, exitWithClients: deps.exitWithClients })
        conn = await connectDaemon(socketPath, fresh)
        if (!conn) throw new Error('띄운 데몬에 붙지 못함')
        deps.log(`agent daemon started pid=${conn.hello.pid} protocol=${conn.hello.protocol}`)
      }
      current = conn
      wire(conn, 'current')
      await sendLimits(conn) // 우선순위는 만들 때 걸리므로 create 보다 먼저
      return conn
    })().finally(() => {
      connecting = null
    })
    return connecting
  }

  // 켤 때: 있는 데몬에만 붙는다(토큰 파일이 없으면 띄운 적이 없다 — 아무것도 안 함).
  const ready = (async () => {
    for (const v of [CURRENT, ...PREVIOUS]) {
      const { socketPath, tokenPath } = paths(v)
      const token = readToken(tokenPath)
      if (!token) continue
      let conn: DaemonConnection | null = null
      try {
        conn = await connectDaemon(socketPath, token)
      } catch (e) {
        deps.log(`agent daemon v${v} connect failed: ${String(e)}`)
      }
      if (!conn) continue
      const verdict = judgeDaemon(conn.hello.protocol, CURRENT, PREVIOUS)
      if (verdict === 'ignore') {
        conn.close()
        continue
      }
      const list = await conn.request<DaemonSessionInfo[]>({ type: 'list' }).catch(() => [] as DaemonSessionInfo[])
      deps.log(`agent daemon v${conn.hello.protocol} (${verdict}) pid=${conn.hello.pid} app=${conn.hello.appVersion ?? '?'} sessions=${list.length}`)
      if (verdict === 'adopt') {
        current = conn
        wire(conn, 'current')
        await sendLimits(conn)
      } else if (list.length) {
        drains.add(conn)
        wire(conn, 'drain')
        await sendLimits(conn)
      } else {
        conn.close() // 세션 없는 옛 판 — 놓으면 스스로 내려간다
        continue
      }
      for (const info of list) await attach(conn, info, true)
    }
  })().catch((e) => deps.log(`agent daemon restore failed: ${String(e)}`))

  const all = (): DaemonConnection[] => [...(current ? [current] : []), ...drains]

  return {
    ready,
    async create(spec) {
      await ready
      const conn = await ensureCurrent()
      const info = await conn.request<DaemonSessionInfo>({ type: 'create', spec })
      await attach(conn, info, false)
      return info
    },
    async killAll() {
      await ready
      let n = 0
      for (const c of all()) n += await c.request<number>({ type: 'killAll' }).catch(() => 0)
      return n
    },
    async shutdownAll() {
      // 답을 기다리지 않는다 — 데몬은 세션을 끝내고 내려가며 연결을 끊는다(그 끊김이 곧 끝). 상한을 넘으면 그냥 간다(앱 종료가 막히지 않게).
      // ready 도 상한 안이다: 켤 때 되살리기가 무응답 데몬에 걸려 있으면(list·attach 요청마다 15초) 완전 종료가 그만큼 밀렸다.
      const closing = (async () => {
        await ready
        quitting = true
        await Promise.all(all().map((c) => new Promise<void>((r) => (c.onClose(() => r()), void c.request({ type: 'shutdown' }).catch(() => r())))))
      })()
      await Promise.race([closing, new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS))])
      quitting = true
    },
    disconnect() {
      quitting = true
      for (const c of all()) c.close()
    },
    owns: (id) => backends.has(id),
    setLimits(limits) {
      for (const c of all()) void c.request({ type: 'limits', limits }).catch(() => {})
    }
  }
}

export const daemonRuntimeDir = (userData: string): string => join(userData, 'daemon')
