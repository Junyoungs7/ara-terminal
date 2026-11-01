// M3 라운드 2 AI-04 — 에이전트 상태 훅의 main 쪽: 받는 서버(127.0.0.1)·훅 심기·옛 아라 훅 정리(S2 A1).
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/agent-hooks/server.ts(받기)·src/main/claude/hook-service.ts·src/main/gemini/hook-service.ts(심기) — 핵심만.
// 뺀 것: 원격 훅 릴레이·스풀·엔드포인트 파일(재시작 뒤 살아남은 PTY — 데몬 M4)·버전별 이벤트 게이트·Windows 네이티브 훅 exe·텔레메트리.
//
// 성능 원칙: 서버는 **첫 에이전트 실행 때** 연다(AI 작업 공간을 안 쓰면 포트도 안 연다). 훅은 그 에이전트를 처음 띄울 때 심는다.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_PANE_HEADER, HOOK_TARGETS, HOOK_TOKEN_HEADER, hookCommand, hookScript, hookScriptName, isHookSource, LEGACY_HOOK_MARK, mergeHooks, mergeStatusLine, removeLegacyHooks, STATUSLINE_MARKER, STATUSLINE_PATH, statusLineScript, statusLineScriptName, type HookSource } from '@shared/agentHooks'
import { BIND_HOST, hashToken, safeEqualHex } from '../mcp/McpServer'
import { writeJsonAtomic } from '../util/atomicJson'

/** 훅 본문 상한. PostToolUse 는 파일 내용을 통째로 싣고 올 수 있다 — 넘으면 그 이벤트는 버린다(다음 이벤트가 상태를 잇는다). */
const BODY_MAX = 2 * 1024 * 1024
const HOOK_PATH = /^\/hook\/([a-z]+)$/

export type HookEvent = { source: HookSource; paneKey: string; payload: Record<string, unknown> }

export type HookServer = {
  /** 처음 부를 때 연다. 실패하면 port 0(그 탭은 훅 없이 화면 판정만). */
  ensure(): Promise<{ port: number; token: string }>
  stop(): Promise<void>
}

/**
 * @param saved 지난번 포트·토큰(M4 DM-01). 데몬에 산 에이전트는 **띄울 때의** 포트·토큰을 env 로 쥐고 있다 — 앱을 다시 켜도 같은 자리에서
 *   받아야 그 에이전트의 훅이 닿는다. 그 포트가 이미 쓰이면 새 포트로 연다(그 에이전트들은 화면 판정만).
 * @param onStatusLine M9 AI-10 — Claude statusLine 입력 JSON(`/statusline/claude`). 사용량만 읽는다.
 */
export function createHookServer(
  onEvent: (e: HookEvent) => void,
  saved?: { port: number; token: string } | null,
  onStatusLine?: (payload: Record<string, unknown>) => void
): HookServer {
  const token = saved?.token || randomBytes(32).toString('base64url')
  const expected = hashToken(token)
  let server: Server | null = null
  let starting: Promise<number> | null = null

  const handle = (req: IncomingMessage, end: (code: number) => void): void => {
    const got = req.headers[HOOK_TOKEN_HEADER]
    const m = HOOK_PATH.exec(req.url ?? '')
    const statusLine = req.url === STATUSLINE_PATH
    const pane = req.headers[HOOK_PANE_HEADER]
    const bad = req.method !== 'POST' ? 405 : typeof got !== 'string' || !safeEqualHex(hashToken(got), expected) ? 401 : !statusLine && (!m || !isHookSource(m[1])) ? 404 : typeof pane !== 'string' || !pane ? 204 : 0
    const chunks: Buffer[] = []
    let size = 0
    // 본문은 늘 끝까지 흘려보낸다 — 안 읽으면 훅 쪽 curl 이 EPIPE·시간 초과를 본다.
    req.on('data', (c: Buffer) => {
      size += c.length
      if (!bad && size <= BODY_MAX) chunks.push(c)
    })
    req.on('end', () => {
      if (bad) return end(bad)
      if (size <= BODY_MAX) {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          if (payload && typeof payload === 'object') {
            if (statusLine) onStatusLine?.(payload as Record<string, unknown>)
            else onEvent({ source: m![1] as HookSource, paneKey: pane as string, payload: payload as Record<string, unknown> })
          }
        } catch {
          // 깨진 본문은 아무 주장도 안 한다.
        }
      }
      end(204)
    })
  }

  return {
    async ensure() {
      starting ??= new Promise<number>((resolve) => {
        const s = createServer((req, res) => {
          try {
            handle(req, (code) => void res.writeHead(code).end())
          } catch {
            req.resume()
            if (!res.headersSent) res.writeHead(500).end()
          }
        })
        let listening = false
        const listen = (port: number): void => {
          s.once('error', () => {
            if (!listening) port ? listen(0) : resolve(0)
          })
          s.listen(port, BIND_HOST, () => {
            listening = true
            const a = s.address()
            resolve(typeof a === 'object' && a ? a.port : 0)
          })
        }
        listen(saved?.port && saved.port > 0 && saved.port < 65536 ? saved.port : 0)
        server = s
      })
      return { port: await starting, token }
    },
    async stop() {
      const s = server
      server = null
      starting = null
      if (s) await new Promise<void>((r) => s.close(() => r()))
    }
  }
}

export type HookInstall = { ok: true; path: string } | { ok: false; message: string }

/**
 * 그 CLI 의 훅을 심는다: `<home>/.ara/agent-hooks/<cli>-hook.(cmd|sh)` 를 쓰고(내용이 같으면 안 씀),
 * `<home>/<.claude|.gemini>/settings.json` 에 그 스크립트를 부르는 줄을 병합한다(남의 줄은 그대로, 깨진 JSON 은 손대지 않음, 같으면 안 씀).
 */
export function installHooks(home: string, source: HookSource, win = process.platform === 'win32'): HookInstall {
  if (!home) return { ok: false, message: '홈 디렉터리를 찾지 못했습니다.' }
  const dir = join(home, '.ara', 'agent-hooks')
  const script = join(dir, hookScriptName(source, win))
  const cfgDir = join(home, HOOK_TARGETS[source].configDir)
  const cfg = join(cfgDir, 'settings.json')
  try {
    mkdirSync(dir, { recursive: true })
    const body = hookScript(source, win)
    if (!existsSync(script) || readFileSync(script, 'utf8') !== body) writeFileSync(script, body, 'utf8')
    if (!win) chmodSync(script, 0o755)
    let current: unknown = {}
    if (existsSync(cfg)) {
      try {
        current = JSON.parse(readFileSync(cfg, 'utf8'))
      } catch (e) {
        return { ok: false, message: `${cfg} 를 읽을 수 없어 훅을 심지 않았습니다: ${String(e)}` }
      }
    }
    let next = mergeHooks(current, source, hookCommand(script, win))
    if (source === 'claude') {
      // M9 AI-10 statusLine(사용량 실시간) — 사용자 statusLine 이 있거나 사용자가 지웠으면(표식) 안 심는다.
      const sl = join(dir, statusLineScriptName(win))
      const slBody = statusLineScript(win)
      const marker = join(dir, STATUSLINE_MARKER)
      const merged = mergeStatusLine(next ?? current, hookCommand(sl, win), existsSync(marker))
      if (merged) {
        if (!existsSync(sl) || readFileSync(sl, 'utf8') !== slBody) writeFileSync(sl, slBody, 'utf8')
        if (!win) chmodSync(sl, 0o755)
        writeFileSync(marker, '')
        next = merged
      } else if (existsSync(sl) && readFileSync(sl, 'utf8') !== slBody) writeFileSync(sl, slBody, 'utf8')
    }
    if (next) {
      mkdirSync(cfgDir, { recursive: true })
      // writeJsonAtomic 은 기존 파일을 settings.json.bak 으로 밀어낸 뒤 바꾼다 — 남의 설정 파일이라 되돌릴 자리를 남긴다.
      writeJsonAtomic(cfg, next)
    }
    return { ok: true, path: cfg }
  } catch (e) {
    return { ok: false, message: `${cfg} 에 훅을 심지 못했습니다: ${String(e)}` }
  }
}

/**
 * S2(제거 A1) — 옛 아라 훅(`# ara-agent-hook` 표식, 부팅마다 `~/.claude/settings.json` 에 심던 것)을 지운다. 남의 훅·새 훅은 그대로.
 * 표식이 없으면 읽기만 하고 끝(쓰지 않음) — 그래서 부팅마다 불러도 정리는 사실상 한 번이다.
 * @returns 지운 줄이 있었나
 */
export function cleanupLegacyHooks(home: string): boolean {
  const cfg = join(home, '.claude', 'settings.json')
  let text: string
  try {
    text = readFileSync(cfg, 'utf8')
  } catch {
    return false
  }
  if (!text.includes(LEGACY_HOOK_MARK)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false // 깨진 파일은 손대지 않는다
  }
  const next = removeLegacyHooks(parsed)
  if (!next) return false
  writeJsonAtomic(cfg, next)
  return true
}
