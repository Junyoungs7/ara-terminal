// M4 DM-01 로컬 터미널 데몬 — 앱과 따로 사는 프로세스. AI 작업 공간 에이전트 PTY 를 쥐고, 앱이 꺼져도(재시작·업데이트) 산다.
// 앱이 Electron 실행 파일을 ELECTRON_RUN_AS_NODE=1 로 띄운다(Orca daemon-launched-child-spawn.ts — 창·GPU 초기화 없이 node 로).
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/daemon/{daemon-entry,daemon-server,session}.ts — 핵심만 다시 씀.
// 뺀 것: 컨트롤/스트림 두 소켓(한 소켓), 바이너리 프레이밍, 헤드리스 에뮬레이터 직렬화(원래 출력 링), 디스크 기록(콜드 복원),
// 엔드포인트 소유 프로토콜(link·rename), cgroup/launchd, 셸 준비 표식, 출력 백프레셔, 자원 상한(M4 다음 라운드).
//
// 생애: 요청이 없으면 아무것도 안 돈다(타이머 0 — 성능 원칙). 세션도 붙은 앱도 없으면 스스로 내려간다(사용자 PC 에 남지 않게).
// ⚠️ electron 을 import 하지 않는다(node 로 돈다).
import { appendFileSync, existsSync, readFileSync, statSync, truncateSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { PtyBackend } from '../sessions/PtyBackend'
import type { SessionSpec } from '../sessions/ISessionManager'
import {
  DAEMON_PROTOCOL_VERSION,
  ReplayBuffer,
  createFrameParser,
  encodeFrame,
  tokenMatches,
  type DaemonCreateSpec,
  type DaemonEvent,
  type DaemonRequest,
  type DaemonSessionInfo
} from './protocol'

/** 띄웠는데 아무도 안 붙으면(앱이 띄우다 죽음) 이만큼 뒤 내려간다. */
const NO_CLIENT_GRACE_MS = 30_000
/** hello 를 이 안에 못 받으면 그 연결을 끊는다. */
const HELLO_TIMEOUT_MS = 5_000
/** shutdown 때 PTY exit 을 기다리는 상한. */
const SHUTDOWN_CAP_MS = 5_000
/** 로그 상한(Orca daemon-file-log DEFAULT_MAX_BYTES) — 시작할 때 넘었으면 비운다. */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/** exitWithClients: 붙은 앱이 모두 떠나면 세션까지 끝내고 내려간다 — e2e 가 시험 뒤 데몬·가짜 에이전트를 남기지 않게(제품은 안 씀). */
export type DaemonArgs = { socketPath: string; tokenPath: string; logFile?: string; appVersion?: string; exitWithClients?: boolean }

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const socketPath = get('--socket')
  const tokenPath = get('--token')
  if (!socketPath || !tokenPath) throw new Error('usage: daemonEntry --socket <path> --token <path> [--log <file>] [--app-version <v>]')
  return { socketPath, tokenPath, logFile: get('--log'), appVersion: get('--app-version'), exitWithClients: argv.includes('--exit-with-clients') }
}

type Session = { backend: PtyBackend; info: DaemonSessionInfo; replay: ReplayBuffer }
type Client = { socket: Socket; authed: boolean; attached: Set<string> }

export function startDaemon(a: DaemonArgs): void {
  const log = (msg: string): void => {
    if (!a.logFile) return
    try {
      appendFileSync(a.logFile, `${new Date().toISOString()} [daemon ${process.pid}] ${msg}\n`)
    } catch {
      // 로그를 못 남겨도 데몬은 돈다.
    }
  }
  try {
    if (a.logFile && existsSync(a.logFile) && statSync(a.logFile).size > LOG_MAX_BYTES) truncateSync(a.logFile, 0)
  } catch {
    /* 무시 */
  }
  const token = readFileSync(a.tokenPath, 'utf8').trim()
  // 셸·에이전트에 새지 않게 — 이 값은 데몬을 node 로 띄우는 데만 필요했다.
  delete process.env['ELECTRON_RUN_AS_NODE']
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  process.on('uncaughtException', (e) => log(`uncaughtException ${e?.stack ?? String(e)}`))
  process.on('unhandledRejection', (e) => log(`unhandledRejection ${String(e)}`))

  const sessions = new Map<string, Session>()
  const clients = new Set<Client>()
  let shuttingDown = false

  const send = (c: Client, msg: unknown): void => {
    if (!c.socket.destroyed) c.socket.write(encodeFrame(msg))
  }
  const broadcast = (id: string, ev: DaemonEvent, onlyAttached: boolean): void => {
    for (const c of clients) if (c.authed && (!onlyAttached || c.attached.has(id))) send(c, ev)
  }

  const exitNow = (why: string): void => {
    log(`exit: ${why}`)
    server.close()
    process.exit(0)
  }
  const maybeExit = (): void => {
    if (sessions.size === 0 && (shuttingDown || clients.size === 0)) exitNow(shuttingDown ? 'shutdown' : 'idle (no sessions, no clients)')
  }

  const create = (spec: DaemonCreateSpec): DaemonSessionInfo => {
    if (sessions.has(spec.id)) throw new Error('같은 id 의 세션이 있다')
    const ptySpec = { type: 'local', cwd: spec.cwd, cols: spec.cols, rows: spec.rows, space: 'ai', env: spec.env } as SessionSpec
    const backend = new PtyBackend(ptySpec, spec.id)
    const info: DaemonSessionInfo = { id: spec.id, pid: backend.pid, cwd: spec.cwd, cols: spec.cols ?? 80, rows: spec.rows ?? 24, meta: spec.meta ?? {} }
    const s: Session = { backend, info, replay: new ReplayBuffer() }
    sessions.set(spec.id, s)
    backend.onData((data) => {
      s.replay.push(data)
      broadcast(spec.id, { type: 'data', id: spec.id, data }, true)
    })
    backend.onExit((code, signal) => {
      sessions.delete(spec.id)
      log(`session exit ${spec.id} pid=${info.pid} code=${code}`)
      // 끝난 것은 붙은 앱 모두에게 — 목록이 어긋나지 않게.
      broadcast(spec.id, { type: 'exit', id: spec.id, code, ...(signal ? { signal } : {}) }, false)
      maybeExit()
    })
    log(`session create ${spec.id} pid=${info.pid} cwd=${spec.cwd}`)
    return info
  }

  const handle = (c: Client, r: DaemonRequest): unknown => {
    switch (r.type) {
      case 'create':
        return create(r.spec)
      case 'list':
        return [...sessions.values()].map((s) => s.info)
      case 'attach': {
        const s = sessions.get(r.id)
        if (!s) throw new Error('없는 세션')
        // 답 → replay 조각들 → 실시간. 한 소켓·한 틱이라 순서가 섞이지 않는다.
        queueMicrotask(() => {
          for (const data of s.replay.snapshot()) send(c, { type: 'data', id: r.id, data })
          c.attached.add(r.id)
        })
        return s.info
      }
      case 'write':
        sessions.get(r.id)?.backend.write(r.data)
        return null
      case 'resize': {
        const s = sessions.get(r.id)
        if (s && r.cols > 0 && r.rows > 0) {
          s.backend.resize(r.cols, r.rows)
          s.info.cols = r.cols
          s.info.rows = r.rows
        }
        return null
      }
      case 'kill':
        sessions.get(r.id)?.backend.kill()
        return null
      case 'killAll':
        for (const s of sessions.values()) s.backend.kill()
        return sessions.size
      case 'shutdown':
        shuttingDown = true
        for (const s of sessions.values()) s.backend.kill()
        setTimeout(() => exitNow('shutdown cap'), SHUTDOWN_CAP_MS).unref()
        queueMicrotask(maybeExit)
        return null
      default:
        throw new Error('모르는 요청')
    }
  }

  const server = createServer((socket) => {
    const c: Client = { socket, authed: false, attached: new Set() }
    clients.add(c)
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    const parse = createFrameParser(
      (m) => {
        const msg = m as { type?: string; token?: unknown; rid?: number }
        if (!c.authed) {
          clearTimeout(helloTimer)
          const ok = msg.type === 'hello' && tokenMatches(token, msg.token)
          send(c, { type: 'hello', ok, protocol: DAEMON_PROTOCOL_VERSION, pid: process.pid, appVersion: a.appVersion, ...(ok ? {} : { error: 'token' }) })
          if (!ok) {
            log('hello rejected')
            socket.end()
            return
          }
          c.authed = true
          return
        }
        const r = msg as DaemonRequest
        try {
          const result = handle(c, r)
          if (r.rid) send(c, { type: 'reply', rid: r.rid, ok: true, result })
        } catch (e) {
          if (r.rid) send(c, { type: 'reply', rid: r.rid, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      },
      () => socket.destroy()
    )
    socket.on('data', parse)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(helloTimer)
      clients.delete(c)
      // 토큰이 틀린 연결이 끊긴 것으로는 내려가지 않는다(남이 두드려서 우리 데몬이 꺼지면 안 된다).
      if (!c.authed) return
      if (a.exitWithClients && ![...clients].some((x) => x.authed) && !shuttingDown) {
        shuttingDown = true
        for (const s of sessions.values()) s.backend.kill()
        setTimeout(() => exitNow('exit-with-clients cap'), SHUTDOWN_CAP_MS).unref()
      }
      maybeExit()
    })
  })

  const listen = (): void => {
    server.listen(a.socketPath, () => {
      log(`listening ${a.socketPath} protocol=${DAEMON_PROTOCOL_VERSION} app=${a.appVersion ?? '?'}`)
      process.stdout.write('ready\n')
      setTimeout(() => {
        if (clients.size === 0) maybeExit()
      }, NO_CLIENT_GRACE_MS).unref()
    })
  }
  server.on('error', (e: NodeJS.ErrnoException) => {
    // 이미 누가 그 자리에 있다 — 같은 판 데몬이 산 것(두 앱이 동시에 띄움). 우리는 물러난다(Orca: 살아 있는 쪽을 절대 지우지 않는다).
    log(`listen error ${e.code ?? e.message}`)
    process.stderr.write(`listen ${e.code ?? e.message}\n`)
    process.exit(3)
  })

  // unix socket: 남은 파일이 죽은 데몬 것인지 확인한 뒤에만 지운다(살아 있으면 물러남). Windows 파이프는 OS 가 치운다.
  if (process.platform !== 'win32' && existsSync(a.socketPath)) {
    const probe = connect(a.socketPath)
    probe.once('connect', () => {
      probe.destroy()
      log('another daemon is serving — leaving')
      process.exit(3)
    })
    probe.once('error', () => {
      try {
        unlinkSync(a.socketPath)
      } catch {
        /* 무시 */
      }
      listen()
    })
  } else listen()
}

// node 로 직접 실행될 때만 시작한다(시험이 import 할 때는 안 돈다).
if (process.argv.includes('--socket') && process.argv.includes('--token')) startDaemon(parseDaemonArgs(process.argv.slice(2)))
