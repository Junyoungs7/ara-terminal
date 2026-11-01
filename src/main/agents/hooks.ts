// M3 라운드 2 AI-04 — 에이전트 상태 훅의 main 쪽: 받는 서버(127.0.0.1)·훅 심기·옛 아라 훅 정리(S2 A1).
// 출처: stablyai/orca @7a7f46f8a3 (MIT) src/main/agent-hooks/server.ts(받기)·src/main/claude/hook-service.ts·src/main/gemini/hook-service.ts(심기) — 핵심만.
// 뺀 것: 원격 훅 릴레이·스풀·엔드포인트 파일(재시작 뒤 살아남은 PTY — 데몬 M4)·버전별 이벤트 게이트·Windows 네이티브 훅 exe·텔레메트리.
//
// 성능 원칙: 서버는 **첫 에이전트 실행 때** 연다(AI 작업 공간을 안 쓰면 포트도 안 연다). 훅 스크립트는 그 에이전트를 처음 띄울 때 쓴다.
// M9 R3: 훅 줄은 사용자 설정 파일에 심지 않고 아라가 띄우는 실행에만 준다(Claude --settings · Gemini 시스템 기본값 파일). PC 침범 금지.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeLaunchSettings, HOOK_PANE_HEADER, HOOK_SOURCES, HOOK_TARGETS, HOOK_TOKEN_HEADER, hookCommand, hookScript, hookScriptName, isHookSource, launchHooks, LEGACY_HOOK_MARK, removeLegacyHooks, removeOurHooks, removeOurStatusLine, STATUSLINE_MARKER, STATUSLINE_PATH, statusLineScript, statusLineScriptName, userStatusLine, type HookSource } from '@shared/agentHooks'
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
 * @param onStatusLine M9 AI-10 — Claude statusLine 입력 JSON(`/statusline/claude`)과 탭(pane). 사용량·컨텍스트(M13)만 읽는다.
 */
export function createHookServer(
  onEvent: (e: HookEvent) => void,
  saved?: { port: number; token: string } | null,
  onStatusLine?: (payload: Record<string, unknown>, pane: string) => void
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
            if (statusLine) onStatusLine?.(payload as Record<string, unknown>, pane as string)
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
 * 그 CLI 의 훅 스크립트를 쓴다: `<home>/.ara/agent-hooks/<cli>-hook.(cmd|sh)`(내용이 같으면 안 씀). Claude 는 statusLine 스크립트도.
 * M9 R3: 사용자 설정 파일(`~/.claude`·`~/.gemini` settings.json)에는 **쓰지 않는다** — 줄은 실행 때 claudeLaunchArgs·geminiLaunchDefaults 가 준다.
 */
export function installHooks(home: string, source: HookSource, win = process.platform === 'win32'): HookInstall {
  if (!home) return { ok: false, message: '홈 디렉터리를 찾지 못했습니다.' }
  const dir = join(home, '.ara', 'agent-hooks')
  const script = join(dir, hookScriptName(source, win))
  try {
    mkdirSync(dir, { recursive: true })
    const body = hookScript(source, win)
    if (!existsSync(script) || readFileSync(script, 'utf8') !== body) writeFileSync(script, body, 'utf8')
    if (!win) chmodSync(script, 0o755)
    if (source === 'claude') {
      // M9 AI-10 statusLine 스크립트 — 전역 설정에는 안 적는다(R2). 실행 때 claudeLaunchArgs 가 --settings 로 준다.
      const sl = join(dir, statusLineScriptName(win))
      const slBody = statusLineScript(win)
      if (!existsSync(sl) || readFileSync(sl, 'utf8') !== slBody) writeFileSync(sl, slBody, 'utf8')
      if (!win) chmodSync(sl, 0o755)
    }
    return { ok: true, path: script }
  } catch (e) {
    return { ok: false, message: `${script} 를 쓰지 못했습니다: ${String(e)}` }
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

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 실행 한 번에 넘길 파일(`<home>/.ara/agent-launch/<이름>-<내용 해시>.<확장자>`). 내용이 같으면 같은 파일 — 실행마다 쌓이지 않는다.
 * 사용자 설정 폴더(~/.claude·~/.codex·~/.gemini)가 아니라 아라 폴더다.
 */
export function writeLaunchFile(home: string, name: string, ext: string, body: string): string {
  const dir = join(home, '.ara', 'agent-launch')
  const file = join(dir, `${name}-${createHash('sha256').update(body).digest('hex').slice(0, 12)}.${ext}`)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, body, 'utf8')
  }
  return file
}

/**
 * 아라 에이전트 탭의 claude 에만 상태 훅(M9 R3)·statusLine(R2)을 준다: `--settings <파일>`(전역 settings.json 은 안 건드린다).
 * hooks 는 사용자 층과 이어 붙고(원래 훅 그대로), statusLine 은 덮으므로 사용자의 원래 statusLine(프로젝트 local·프로젝트·사용자 순)이 있으면
 * 같은 입력을 넘겨 그 출력을 그대로 보인다.
 * @param configDir 사용자 claude 설정 폴더(CLAUDE_CONFIG_DIR 또는 ~/.claude) — **읽기만**.
 */
export function claudeLaunchArgs(home: string, cwd: string, configDir: string, win = process.platform === 'win32'): string[] {
  const dir = join(home, '.ara', 'agent-hooks')
  const script = join(dir, statusLineScriptName(win))
  const hook = join(dir, hookScriptName('claude', win))
  if (!existsSync(script) || !existsSync(hook)) return []
  const user = userStatusLine([join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(configDir, 'settings.json')].map(readJson))
  return ['--settings', writeLaunchFile(home, 'claude-settings', 'json', JSON.stringify(claudeLaunchSettings(hookCommand(script, win), user, hookCommand(hook, win)), null, 2))]
}

/** M9 R3 — Gemini 시스템 기본값 파일(GEMINI_CLI_SYSTEM_DEFAULTS_PATH)에 담을 훅. 스크립트가 없으면 빈 객체. Oriel mcpServers 와 한 파일로 합친다(feature.ts). */
export function geminiLaunchDefaults(home: string, win = process.platform === 'win32'): Record<string, unknown> {
  const hook = join(home, '.ara', 'agent-hooks', hookScriptName('gemini', win))
  return existsSync(hook) ? launchHooks('gemini', hookCommand(hook, win)) : {}
}

/**
 * M9 R3 — M3 이 전역 `~/.claude/settings.json`·`~/.gemini/settings.json` 에 심은 우리 훅 줄을 지운다. **우리 표식(.ara/agent-hooks/<cli>-hook.)이 있는 줄만** —
 * 남의 훅은 읽기만. 표식 글자가 없으면 파싱도 안 한다(부팅마다 불러도 쓰는 것은 처음 한 번). 깨진 JSON 은 손대지 않는다.
 * @returns 지운 파일 수
 */
export function cleanupOurGlobalHooks(home: string): number {
  let n = 0
  for (const source of HOOK_SOURCES) {
    const cfg = join(home, HOOK_TARGETS[source].configDir, 'settings.json')
    let text: string
    try {
      text = readFileSync(cfg, 'utf8')
    } catch {
      continue
    }
    if (!text.includes(`${source}-hook.`)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const next = removeOurHooks(parsed, source)
    if (!next) continue
    writeJsonAtomic(cfg, next) // 기존 파일은 settings.json.bak 으로 남는다
    n++
  }
  return n
}

/**
 * M9 R2 — R1 이 `~/.claude/settings.json` 에 심은 우리 statusLine 을 지운다. **우리 표식(.ara/agent-hooks/claude-statusline.)이 있는 줄만** —
 * 남의 statusLine 은 읽기만 하고 끝. 표식 파일도 지운다. 부팅마다 불러도 쓰는 것은 처음 한 번.
 * @returns 지운 줄이 있었나
 */
export function cleanupOurStatusLine(home: string, configDir = join(home, '.claude')): boolean {
  const marker = join(home, '.ara', 'agent-hooks', STATUSLINE_MARKER)
  if (existsSync(marker)) rmSync(marker, { force: true })
  const cfg = join(configDir, 'settings.json')
  const next = removeOurStatusLine(readJson(cfg))
  if (!next) return false
  writeJsonAtomic(cfg, next)
  return true
}
