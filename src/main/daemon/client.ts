// M4 DM-01 — 데몬에 붙는 앱 쪽 연결 하나. hello(토큰) → 요청/답(rid) + 사건(data·exit). 끊기면 onClose(데몬이 죽었는지는 부른 쪽이 가른다).
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/daemon/{client,daemon-client-socket-connect,daemon-client-pending-requests}.ts — 핵심만.
import { connect, type Socket } from 'node:net'
import { DAEMON_PROTOCOL_VERSION, createFrameParser, encodeFrame, type DaemonEvent, type DaemonHelloReply, type DaemonReply, type DaemonRequest } from './protocol'

const CONNECT_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 15_000

type Body<T> = T extends unknown ? Omit<T, 'rid'> : never
export type DaemonRequestBody = Body<DaemonRequest>

export type DaemonConnection = {
  readonly hello: DaemonHelloReply
  request<R = unknown>(body: DaemonRequestBody): Promise<R>
  /** 답이 필요 없는 것(write·resize). */
  fire(body: DaemonRequestBody): void
  onEvent(cb: (e: DaemonEvent) => void): void
  /** 끊김 — 우리가 close() 한 것이 아니면 intentional=false. */
  onClose(cb: (intentional: boolean) => void): void
  close(): void
}

/** 붙고 hello 까지. 없으면(ENOENT·ECONNREFUSED) null — 데몬이 없다는 뜻. 토큰이 틀리면 던진다. */
export function connectDaemon(socketPath: string, token: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<DaemonConnection | null> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath)
    let settled = false
    const fail = (e: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (e) reject(e)
      else resolve(null)
    }
    const timer = setTimeout(() => fail(new Error('데몬 연결 시간 초과')), timeoutMs)
    socket.once('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? null : e))

    let hello: DaemonHelloReply | null = null
    let rid = 0
    let intentional = false
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>()
    const eventCbs: ((e: DaemonEvent) => void)[] = []
    const closeCbs: ((intentional: boolean) => void)[] = []

    const parse = createFrameParser(
      (m) => {
        const msg = m as DaemonHelloReply | DaemonReply | DaemonEvent
        if (!hello) {
          if (msg.type !== 'hello') return fail(new Error('데몬이 hello 로 답하지 않았다'))
          if (!msg.ok) return fail(new Error(`데몬이 거절했다: ${msg.error ?? '?'}`))
          hello = msg
          settled = true
          clearTimeout(timer)
          socket.on('error', () => {})
          resolve(conn)
          return
        }
        if (msg.type === 'reply') {
          const p = pending.get(msg.rid)
          if (!p) return
          pending.delete(msg.rid)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error ?? '데몬 요청 실패'))
          return
        }
        if (msg.type === 'data' || msg.type === 'exit' || msg.type === 'memoryOver') for (const cb of eventCbs) cb(msg)
      },
      () => socket.destroy()
    )

    const conn: DaemonConnection = {
      get hello() {
        return hello!
      },
      request(body) {
        return new Promise((res, rej) => {
          if (socket.destroyed) return rej(new Error('데몬 연결이 끊겼다'))
          const id = ++rid
          const t = setTimeout(() => {
            pending.delete(id)
            rej(new Error(`데몬 요청 시간 초과: ${body.type}`))
          }, REQUEST_TIMEOUT_MS)
          pending.set(id, { resolve: res as (v: unknown) => void, reject: rej, timer: t })
          socket.write(encodeFrame({ ...body, rid: id }))
        })
      },
      fire(body) {
        if (!socket.destroyed) socket.write(encodeFrame({ ...body, rid: 0 }))
      },
      onEvent: (cb) => void eventCbs.push(cb),
      onClose: (cb) => void closeCbs.push(cb),
      close() {
        intentional = true
        socket.end()
        socket.destroy()
      }
    }

    socket.on('data', parse)
    socket.on('close', () => {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('데몬 연결이 끊겼다'))
      }
      pending.clear()
      if (!hello) return fail(new Error('데몬이 hello 전에 끊었다'))
      for (const cb of closeCbs) cb(intentional)
    })
    socket.once('connect', () => socket.write(encodeFrame({ type: 'hello', protocol: DAEMON_PROTOCOL_VERSION, token })))
  })
}
