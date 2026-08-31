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

/**
 * 훅이 읽는 env 둘. **명령 문자열과 심는 쪽이 같은 상수를 본다** — 이름이 어긋나면 훅은
 * 조용히 아무 일도 안 하고(포트가 없으니), 그 조용함은 버그처럼 보이지 않는다.
 * 로컬은 main 의 process.env(포트)·PtyBackend(pane)가, 원격은 SSH 셸 요청이 넣는다(F1b).
 */
export const HOOK_PORT_ENV = 'ARA_HOOK_PORT'
export const HOOK_PANE_ENV = 'ARA_PANE'

/**
 * #162 원격 폴백 파일 — **env 를 안 받아 주는 sshd 를 위한 두 번째 길.**
 *
 * stock sshd 는 `AcceptEnv LANG LC_*` 만 받고 위 둘을 **조용히 버린다**(2026-08-31 실증).
 * sudo 가 되는 서버는 한 줄로 열 수 있지만 동료들은 대부분 안 되고, 그 서버에서는 이 기능이
 * 오류 없이 그냥 없다. 그래서 같은 두 값을 **파일로도** 놓는다: `~/.claude/ara-tty-<tty>`.
 *
 * 왜 tty 로 이름을 짓나: 훅이 **아무 도움 없이 읽을 수 있는 자기 식별자**가 그것뿐이다.
 * `SSH_TTY` 는 **sshd 자신이** 셸에 넣는 값이라(우리가 보내는 값이 아니라) AcceptEnv 와 무관하게
 * 언제나 있고, 훅은 셸의 자손이라 그대로 물려받는다. 세션마다 tty 가 달라 **같은 서버에 탭
 * 여럿이 붙어도 서로를 덮어쓰지 않는다** — 포트를 훅 명령에 박아 넣는 안이 깨지는 자리가 거기다
 * (먼저 닫히는 탭이 남은 탭의 포트를 죽인다).
 *
 * 신뢰 경계는 그대로다: 이 파일을 쓸 수 있는 사람은 `~/.claude/settings.json` 도 쓸 수 있다.
 */
export const HOOK_TTY_PREFIX = 'ara-tty-'

/**
 * tty 경로(`/dev/pts/3`) → 폴백 파일 이름(`ara-tty-3`). 훅 한 줄의 `SSH_TTY` 접미 확장(마지막
 * 슬래시 뒤만 남긴다)과 **같은 계산**이다 — 우리는 그 셸의 `/proc/<pid>/fd/0` 를 읽어 같은
 * 문자열에서 출발하므로 두 이름이 어긋날 수 없다.
 */
export function hookTtyFile(tty: string): string {
  const base = tty.slice(tty.lastIndexOf('/') + 1)
  return base ? `${HOOK_TTY_PREFIX}${base}` : ''
}

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
 *  · 포트를 **어느 길로도** 못 얻으면(우리 터미널 밖에서 띄운 claude) **아무 일도 하지 않는다.**
 *  · 무슨 일이 있어도 `exit 0`. 훅이 0이 아닌 값을 내면 사용자의 Claude Code 에 오류가 뜨고,
 *    PreToolUse 는 **도구 실행 자체를 막는다** — 우리 상태 표시가 남의 작업을 막으면 안 된다.
 *
 * 값을 얻는 길이 둘인 것이 #162 다. **env 가 먼저고 파일은 폴백이다** — 그래서 로컬은 파일을
 * 아예 쳐다보지 않는다(`$HOME/.claude/ara-tty-` 는 존재하지도 않는다). 서버가 env 를 버리는
 * 원격에서만 `read` 가 돈다(HOOK_TTY_PREFIX 주석).
 *
 * 본문(stdin)은 보내되 우리는 읽지 않는다: 이벤트 이름은 **URL 에 있고**(설치할 때 우리가 안다)
 * 페이로드는 PostToolUse 처럼 수백 KB 가 될 수 있다. 그래도 stdin 은 흘려보내야 한다 —
 * 안 읽으면 CLI 쪽 쓰기가 EPIPE 를 볼 수 있다.
 *
 * 실측(2026-08-31, sh·bash 각각): env 만 있을 때·파일만 있을 때·둘 다 없을 때·빈 파일·`set -e`
 * 다섯 경우 모두 `exit 0` 이고, env 가 있으면 파일은 읽히지 않는다(tests/agentHooks.test.ts).
 */
export function hookCommand(event: string, token: string): string {
  const url = `http://127.0.0.1:$ARA_P/hook/claude/${event}`
  return (
    `ARA_P="$${HOOK_PORT_ENV}"; ARA_N="$${HOOK_PANE_ENV}";` +
    ` ARA_F="$HOME/.claude/${HOOK_TTY_PREFIX}\${SSH_TTY##*/}";` +
    ` [ -z "$ARA_P" ] && [ -r "$ARA_F" ] && read -r ARA_P ARA_N < "$ARA_F";` +
    ` [ -n "$ARA_P" ] && curl -sS -m 2 -X POST` +
    ` -H "${HOOK_TOKEN_HEADER}: ${token}" -H "${HOOK_PANE_HEADER}: $ARA_N"` +
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
export const newToken = (): string => randomBytes(32).toString('base64url')

/**
 * 설정 파일 **내용 한 덩어리**에 대해 "무엇을 쓸 것인가"를 정한다. 파일을 안 읽고 안 쓴다.
 *
 * 이 함수가 문자열을 받는 이유: 같은 판단이 로컬(fs)과 원격(SFTP) 두 곳에서 필요한데, 그 둘은
 * **읽고 쓰는 방법만** 다르다(F1b). 판단이 두 벌이 되면 원격만 남의 설정을 지우는 날이 온다.
 *
 * · `null` 내용 = 파일 없음 = 첫 설치(정상)
 * · 깨진 JSON = **손대지 않는다.** 못 읽는 파일을 우리 것으로 덮으면 남의 설정이 사라진다
 * · `next === null` = 이미 같다 → 쓰지 않는다(설정 파일의 mtime 을 흔들 이유가 없다)
 */
export type HookPlan = { ok: false; message: string } | { ok: true; token: string; next: Settings | null }

export function planHooks(currentText: string | null): HookPlan {
  let current: unknown = null
  if (currentText !== null) {
    try {
      current = JSON.parse(currentText)
    } catch (e) {
      return { ok: false, message: String(e) }
    }
  }
  // 심어 둔 토큰이 있으면 그대로 쓴다 → 두 번째 기동부터는 파일이 완전히 같아 아무것도 안 쓴다.
  const token = tokenInSettings(current) ?? newToken()
  const next = mergeHooks(current, token)
  if (current !== null && JSON.stringify(current) === JSON.stringify(next)) return { ok: true, token, next: null }
  return { ok: true, token, next }
}

/**
 * 훅을 심고 **그때 쓰인 토큰**을 함께 돌려준다(로컬 `~/.claude/settings.json`).
 *
 * 읽기 실패와 파싱 실패를 가른다: 없는 파일은 첫 설치(정상)고, **깨진 파일은 손대지 않고**
 * 사용자에게 말한다.
 */
export function installClaudeHooks(home: string): { install: AgentHookInstall; token: string } {
  const token0 = newToken()
  if (!home) return { install: { ok: false, reason: 'noHome', message: '홈 디렉터리를 찾지 못했습니다.' }, token: token0 }
  const dir = join(home, '.claude')
  const path = join(dir, 'settings.json')

  let text: string | null = null
  if (existsSync(path)) {
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      return { install: { ok: false, reason: 'parse', message: `${path} 를 읽을 수 없습니다: ${String(e)}` }, token: token0 }
    }
  }

  const plan = planHooks(text)
  if (!plan.ok) {
    return { install: { ok: false, reason: 'parse', message: `${path} 를 읽을 수 없습니다: ${plan.message}` }, token: token0 }
  }
  if (plan.next === null) return { install: { ok: true, path }, token: plan.token }
  try {
    mkdirSync(dir, { recursive: true })
    // writeJsonAtomic 은 기존 파일을 `settings.json.bak` 으로 밀어낸 뒤 rename 한다 — 남의 파일을
    // 고치는 자리라 그 되돌릴 자리가 특히 값지다. 대신 원본의 들여쓰기·키 순서는 한 번 다시 쓰인다.
    writeJsonAtomic(path, plan.next)
  } catch (e) {
    return { install: { ok: false, reason: 'write', message: `${path} 에 쓸 수 없습니다: ${String(e)}` }, token: plan.token }
  }
  return { install: { ok: true, path }, token: plan.token }
}
