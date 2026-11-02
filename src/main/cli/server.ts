// M14 R2 `ara` CLI — 아라 쪽 받는 자리. Orca src/main/runtime(로컬 named pipe + 토큰 + orca-runtime.json, orcaRef ec112c6b01)의 아라판.
//
//  · 받는 곳 = Windows named pipe(`\\.\pipe\ara-cli-<runtimeId>`), 맥·리눅스는 임시 폴더의 유닉스 소켓. TCP 포트를 열지 않는다.
//  · 토큰 = 켤 때마다 새로 만든 256비트. userData 의 ara-runtime.json(사용자 폴더 — 같은 사용자만 읽는다)에 파이프 이름과 함께 쓴다.
//    파이프에 닿아도 토큰이 틀리면 아무것도 하지 않는다(MCP 토큰과 같은 상수시간 비교).
//  · 꺼질 때 그 파일을 지운다 — 우리가 쓴 것(runtimeId 가 같을 때)만. 죽어서 남은 파일은 CLI 가 연결 실패로 "꺼짐"을 안다(Orca stale_bootstrap).
// electron 을 import 하지 않는다 — 시험이 가짜 핸들러로 진짜 파이프를 연다(tests/araCli.test.ts).
import { createServer, type Server, type Socket } from 'node:net'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_MAX_LINE_BYTES, CLI_RUNTIME_FILE, type CliError, type CliRequest, type CliResponse, type CliRuntimeMetadata } from '@shared/araCli'
import { writeJsonAtomic } from '../util/atomicJson'

/** 핸들러가 던지면 그 code·message 가 CLI 로 간다. 나머지 예외는 'internal'. */
export class CliFail extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextSteps?: string[]
  ) {
    super(message)
  }
}

export type CliHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
export type CliServerHandle = { metadata: CliRuntimeMetadata; stop(): Promise<void> }

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
const sameToken = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b))

export function cliEndpoint(runtimeId: string, platform: NodeJS.Platform = process.platform): CliRuntimeMetadata['transports'][number] {
  return platform === 'win32'
    ? { kind: 'named-pipe', endpoint: `\\\\.\\pipe\\ara-cli-${runtimeId}` }
    : { kind: 'unix', endpoint: join(tmpdir(), `ara-cli-${runtimeId.slice(0, 8)}.sock`) }
}

export async function startCliServer(opts: {
  userData: string
  appVersion: string
  handlers: Record<string, CliHandler>
  log?: (where: string, e: unknown) => void
}): Promise<CliServerHandle> {
  const runtimeId = randomUUID()
  const transport = cliEndpoint(runtimeId)
  const metadata: CliRuntimeMetadata = {
    runtimeId,
    pid: process.pid,
    transports: [transport],
    authToken: randomBytes(32).toString('base64url'),
    startedAt: Date.now(),
    appVersion: opts.appVersion
  }
  const file = join(opts.userData, CLI_RUNTIME_FILE)

  const answer = async (raw: string): Promise<CliResponse> => {
    let req: Partial<CliRequest>
    try {
      req = JSON.parse(raw) as Partial<CliRequest>
    } catch {
      return { id: '', ok: false, error: { code: 'invalid_request', message: '요청이 JSON 이 아닙니다.' } }
    }
    const id = typeof req.id === 'string' ? req.id : ''
    if (typeof req.authToken !== 'string' || !sameToken(req.authToken, metadata.authToken)) {
      return { id, ok: false, error: { code: 'unauthorized', message: '토큰이 맞지 않습니다. 아라를 다시 켰다면 명령을 다시 실행하세요.' } }
    }
    const fn = typeof req.method === 'string' && Object.hasOwn(opts.handlers, req.method) ? opts.handlers[req.method] : undefined
    if (!fn) return { id, ok: false, error: { code: 'unknown_method', message: `모르는 요청: ${String(req.method)}` } }
    try {
      const params = req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {}
      return { id, ok: true, result: (await fn(params)) ?? null }
    } catch (e) {
      if (e instanceof CliFail) {
        const error: CliError = { code: e.code, message: e.message, ...(e.nextSteps ? { nextSteps: e.nextSteps } : {}) }
        return { id, ok: false, error }
      }
      opts.log?.(`cli ${String(req.method)}`, e)
      return { id, ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } }
    }
  }

  const onSocket = (socket: Socket): void => {
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > CLI_MAX_LINE_BYTES) {
        socket.end(`${JSON.stringify({ id: '', ok: false, error: { code: 'too_large', message: '요청이 너무 큽니다.' } })}\n`)
        buf = ''
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        void answer(line).then((res) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`)
        })
      }
    })
  }

  const server: Server = createServer(onSocket)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(transport.endpoint, () => {
      server.off('error', reject)
      resolve()
    })
  })
  writeJsonAtomic(file, metadata)

  return {
    metadata,
    stop: () =>
      new Promise<void>((resolve) => {
        // 우리가 쓴 파일만 지운다 — 그사이 다른 아라(다른 runtimeId)가 썼으면 둔다.
        try {
          const cur = JSON.parse(readFileSync(file, 'utf8')) as Partial<CliRuntimeMetadata>
          if (cur.runtimeId === runtimeId) {
            rmSync(file, { force: true })
            rmSync(`${file}.bak`, { force: true })
          }
        } catch {
          /* 이미 없음 */
        }
        server.close(() => resolve())
      })
  }
}
