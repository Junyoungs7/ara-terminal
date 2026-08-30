// F1a 훅 설치 — 로컬 `~/.claude/settings.json` 에 우리 훅을 심는다.
//
// ⚠️ **병합이지 덮어쓰기가 아니다.** 사용자는 이미 훅을 갖고 있다(준영님 PC 는 플러그인 훅이
// 여럿이다). 남의 훅을 지우는 것은 이 라운드에서 낼 수 있는 가장 나쁜 사고라, 우리 것은
// 명령 문자열 끝의 표식(HOOK_MARK)으로만 골라내고 나머지는 손대지 않는다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { CLAUDE_HOOK_EVENTS, type AgentHookInstall } from '@shared/agentStatus'
import { writeJsonAtomic } from '../util/atomicJson'

/** 우리가 쓴 줄임을 알아보는 표식. 이게 없으면 나중에 우리 것만 지울 수 없다. */
export const HOOK_MARK = 'ara-agent-hook'

/** 훅 명령이 쓰는 헤더 둘. 포트는 env(비밀 아님), 토큰은 설정 파일에만 산다. */
export const HOOK_TOKEN_HEADER = 'x-ara-token'
export const HOOK_PANE_HEADER = 'x-ara-pane'

/** 훅 실행 상한(초). curl 의 -m 2 가 먼저 끊지만, 그게 안 먹는 상황을 위한 바깥 울타리다. */
const HOOK_TIMEOUT_SEC = 5

type CommandHook = { type: 'command'; command: string; timeout?: number }
type HookEntry = { matcher?: string; hooks: CommandHook[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> }

/**
 * 훅 한 줄. **실측(2026-08-30)으로 확인한 것들:**
 *  · Windows 에서도 훅은 **Git Bash** 로 돈다(`SHELL=C:\Program Files\Git\bin\bash.exe`) — `$VAR` 는
 *    확장되고 `%VAR%` 는 글자 그대로 남는다. 그래서 명령 하나로 세 OS 를 덮는다.
 *  · 훅은 `claude` 프로세스의 env 를 물려받는다 — 우리가 셸에 넣은 `ARA_HOOK_PORT`·`ARA_PANE` 이
 *    **사용자가 직접 친 `claude` 에서도** 그대로 보인다(셸의 자식이므로).
 *
 * 규율 둘:
 *  · `ARA_HOOK_PORT` 가 없으면(우리 터미널 밖에서 띄운 claude) **아무 일도 하지 않는다.**
 *  · 무슨 일이 있어도 `exit 0`. 훅이 0이 아닌 값을 내면 사용자의 Claude Code 에 오류가 뜨고,
 *    PreToolUse 는 **도구 실행 자체를 막는다** — 우리 상태 표시가 남의 작업을 막으면 안 된다.
 *
 * 본문(stdin)은 보내되 우리는 읽지 않는다: 이벤트 이름은 **URL 에 있고**(설치할 때 우리가 안다)
 * 페이로드는 PostToolUse 처럼 수백 KB 가 될 수 있다. 그래도 stdin 은 흘려보내야 한다 —
 * 안 읽으면 CLI 쪽 쓰기가 EPIPE 를 볼 수 있다.
 */
export function hookCommand(event: string, token: string): string {
  const url = `http://127.0.0.1:$ARA_HOOK_PORT/hook/claude/${event}`
  return (
    `[ -n "$ARA_HOOK_PORT" ] && curl -sS -m 2 -X POST` +
    ` -H "${HOOK_TOKEN_HEADER}: ${token}" -H "${HOOK_PANE_HEADER}: $ARA_PANE"` +
    ` --data-binary @- "${url}" >/dev/null 2>&1; exit 0 # ${HOOK_MARK}`
  )
}

const isOurs = (h: CommandHook): boolean => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)

/**
 * 우리 훅을 심은 설정 객체를 돌려준다(순수 함수 — 파일을 안 만진다).
 *
 * 남의 훅을 지키는 방식: 이벤트 배열에서 **우리 명령만** 골라 빼고, 그 결과 빈 껍데기가 된 항목만
 * 없앤다. 사용자가 우리 훅과 자기 훅을 같은 항목에 섞어 뒀어도 자기 것은 그대로 남는다.
 */
export function mergeHooks(settings: unknown, token: string): Settings {
  const base: Settings = settings && typeof settings === 'object' ? { ...(settings as Settings) } : {}
  const hooks: Record<string, HookEntry[]> = { ...(base.hooks ?? {}) }
  for (const event of CLAUDE_HOOK_EVENTS) {
    // 모양이 어긋난 값(배열이 아닌 것)은 Claude Code 도 못 쓰는 것이라 빈 것으로 친다 — 여기서
    // 던지면 훅 설치가 통째로 실패하고, 그때 잃는 것이 우리 기능 하나가 아니라 부팅 경로다.
    const cur = Array.isArray(hooks[event]) ? hooks[event]! : []
    const kept = cur
      .map((e) => ({ ...e, hooks: (Array.isArray(e?.hooks) ? e.hooks : []).filter((h) => !isOurs(h)) }))
      .filter((e) => e.hooks.length > 0)
    hooks[event] = [
      ...kept,
      // matcher 를 안 쓴다: PreToolUse/PostToolUse 는 **모든 도구**를 봐야 하고, 나머지 이벤트는
      // matcher 자체가 뜻이 없다. 빈 matcher 가 곧 전체다.
      { hooks: [{ type: 'command', command: hookCommand(event, token), timeout: HOOK_TIMEOUT_SEC }] }
    ]
  }
  return { ...base, hooks }
}

/** 이미 심어 둔 토큰을 되찾는다. 있으면 그대로 쓴다 — 매 기동마다 사용자 설정 파일을 고쳐 쓰지 않으려고. */
export function tokenInSettings(settings: unknown): string | null {
  const hooks = (settings as Settings | null)?.hooks
  if (!hooks || typeof hooks !== 'object') return null
  for (const entries of Object.values(hooks)) {
    for (const e of entries ?? []) {
      for (const h of e?.hooks ?? []) {
        if (!isOurs(h)) continue
        const m = new RegExp(`${HOOK_TOKEN_HEADER}: ([A-Za-z0-9_-]+)`).exec(h.command)
        if (m?.[1]) return m[1]
      }
    }
  }
  return null
}

/** 256비트 랜덤(McpServer.issueRawToken 과 같은 규격 — base64url 이라 셸·헤더에 그대로 실린다). */
const newToken = (): string => randomBytes(32).toString('base64url')

/**
 * 훅을 심고 **그때 쓰인 토큰**을 함께 돌려준다.
 *
 * 읽기 실패와 파싱 실패를 가른다: 없는 파일은 첫 설치(정상)고, **깨진 파일은 손대지 않고**
 * 사용자에게 말한다 — 못 읽는 파일을 우리 것으로 덮으면 남의 설정이 사라진다.
 */
export function installClaudeHooks(home: string): { install: AgentHookInstall; token: string } {
  const token0 = newToken()
  if (!home) return { install: { ok: false, reason: 'noHome', message: '홈 디렉터리를 찾지 못했습니다.' }, token: token0 }
  const dir = join(home, '.claude')
  const path = join(dir, 'settings.json')

  let current: unknown = null
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      return { install: { ok: false, reason: 'parse', message: `${path} 를 읽을 수 없습니다: ${String(e)}` }, token: token0 }
    }
  }

  const token = tokenInSettings(current) ?? token0
  try {
    const next = mergeHooks(current, token)
    // 이미 같으면 쓰지 않는다 — 매 기동마다 사용자 설정 파일의 mtime 을 흔들 이유가 없다.
    if (current !== null && JSON.stringify(current) === JSON.stringify(next)) return { install: { ok: true, path }, token }
    mkdirSync(dir, { recursive: true })
    // writeJsonAtomic 은 기존 파일을 `settings.json.bak` 으로 밀어낸 뒤 rename 한다 — 남의 파일을
    // 고치는 자리라 그 되돌릴 자리가 특히 값지다. 대신 원본의 들여쓰기·키 순서는 한 번 다시 쓰인다.
    writeJsonAtomic(path, next)
  } catch (e) {
    return { install: { ok: false, reason: 'write', message: `${path} 에 쓸 수 없습니다: ${String(e)}` }, token }
  }
  return { install: { ok: true, path }, token }
}
