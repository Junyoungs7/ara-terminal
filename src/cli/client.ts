// M14 R2 `ara` CLI → 아라 — Orca src/cli/runtime/metadata.ts·transport.ts·status.ts·open-local-orca.ts(orcaRef ec112c6b01)의 아라판.
// 아라가 쓴 ara-runtime.json 에서 파이프와 토큰을 읽고, 한 줄 요청 → 한 줄 답(NDJSON). 아라가 꺼져 있으면(파일 없음·연결 실패) Orca 처럼
// "아라를 먼저 켜세요"로 끝낸다 — `ara open`·`ara`(인자 없음)만 아라를 띄운다.
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLI_RUNTIME_FILE, type CliError, type CliResponse, type CliRuntimeMetadata } from '@shared/araCli'

/** 실패 — code 는 Orca 이름(runtime_unavailable·runtime_timeout 등). */
export class CliClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextSteps: string[] = []
  ) {
    super(message)
  }
}

const START_FIRST = ['아라를 켠 뒤 다시 실행하세요(ara open 이 켜 줍니다).']

/** 아라 userData — main/index.ts 의 LEGACY_USER_DATA('A.R.A'). ARA_USER_DATA_PATH 로 덮는다(Orca ORCA_USER_DATA_PATH — 시험·여러 프로필). */
export function defaultUserDataPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['ARA_USER_DATA_PATH']) return env['ARA_USER_DATA_PATH']
  if (platform === 'win32') {
    if (!env['APPDATA']) throw new CliClientError('runtime_unavailable', 'APPDATA 가 없어 아라 설정 폴더를 못 찾습니다.')
    return join(env['APPDATA'], 'A.R.A')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'A.R.A')
  return join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'A.R.A')
}

export function tryReadMetadata(userData: string): CliRuntimeMetadata | null {
  try {
    const m = JSON.parse(readFileSync(join(userData, CLI_RUNTIME_FILE), 'utf8')) as CliRuntimeMetadata | null
    return m && typeof m.authToken === 'string' && Array.isArray(m.transports) && m.transports[0]?.endpoint ? m : null
  } catch {
    return null
  }
}

export async function sendRequest<T>(metadata: CliRuntimeMetadata, method: string, params: unknown, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection(metadata.transports[0].endpoint)
    const id = randomUUID()
    let buf = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new CliClientError('runtime_timeout', '아라가 제때 답하지 않았습니다.'))), timeoutMs)
    socket.setEncoding('utf8')
    // 연결 실패 = 꺼졌거나 남은 파일(Orca stale_bootstrap) — 같은 안내.
    socket.once('error', () => finish(() => reject(new CliClientError('runtime_unavailable', '아라에 연결하지 못했습니다(꺼져 있는 것 같습니다).', START_FIRST))))
    socket.once('close', () => finish(() => reject(new CliClientError('runtime_unavailable', '아라가 답하기 전에 연결을 닫았습니다.', START_FIRST))))
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      let res: CliResponse<T>
      try {
        res = JSON.parse(buf.slice(0, nl)) as CliResponse<T>
      } catch {
        return finish(() => reject(new CliClientError('invalid_runtime_response', '아라의 답을 못 알아봤습니다.')))
      }
      if (res.id !== id) return finish(() => reject(new CliClientError('invalid_runtime_response', '아라의 답 id 가 맞지 않습니다.')))
      if (res.ok) return finish(() => resolve(res.result))
      const e: CliError = res.error
      finish(() => reject(new CliClientError(e.code, e.message, e.nextSteps ?? [])))
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`))
  })
}

export type AppStatus = { app: { running: boolean; pid: number | null; version: string | null }; runtime: { state: 'running' | 'not_running' | 'stale_bootstrap' } }

/** Orca getCliStatus — 꺼져 있어도 실패가 아니라 "꺼짐"을 답한다. */
export async function getStatus(userData: string, timeoutMs = 1000): Promise<AppStatus> {
  const m = tryReadMetadata(userData)
  if (!m) return { app: { running: false, pid: null, version: null }, runtime: { state: 'not_running' } }
  try {
    const r = await sendRequest<{ app: { pid: number; version: string } }>(m, 'status.get', undefined, timeoutMs)
    return { app: { running: true, pid: r.app.pid, version: r.app.version }, runtime: { state: 'running' } }
  } catch (e) {
    if (e instanceof CliClientError && e.code === 'runtime_unavailable') return { app: { running: false, pid: null, version: null }, runtime: { state: 'stale_bootstrap' } }
    throw e
  }
}

export async function call<T>(userData: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
  const m = tryReadMetadata(userData)
  if (!m) throw new CliClientError('runtime_unavailable', `아라가 켜져 있지 않습니다(${join(userData, CLI_RUNTIME_FILE)} 없음).`, START_FIRST)
  return sendRequest<T>(m, method, params, timeoutMs)
}

/** Orca openLocalOrca — 켜져 있으면 그대로, 아니면 launch() 후 상태가 running 이 될 때까지. */
export async function openApp(userData: string, launch: () => void, timeoutMs: number, pollMs = 250): Promise<AppStatus> {
  const first = await getStatus(userData)
  if (first.app.running) return first
  launch()
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs))
    const s = await getStatus(userData)
    if (s.app.running) return s
  }
  throw new CliClientError('runtime_open_timeout', '아라 창이 제때 뜨지 않았습니다.')
}
