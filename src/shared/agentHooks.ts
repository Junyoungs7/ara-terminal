// M3 라운드 2 — 에이전트 상태 훅(AI-04)·서브에이전트 자식 줄(AI-06)·훅과 화면 판정 합치기(AI-05)의 순수 규칙.
// 출처: stablyai/orca @7a7f46f8a3 (MIT) 에서 기능 단위로 옮겼다:
//  · 이벤트 → 상태 = src/shared/agent-hook-listener/providers/claude-events.ts(reportedStateName)·provider-event-routing.ts(gemini)
//  · 자식 줄 = src/shared/claude-subagent-roster.ts(upsertWorkingClaudeSubagent·stopClaudeSubagent)
//  · 훅 스크립트·설정 병합 = src/main/claude/hook-script.ts·hook-settings.ts, src/main/gemini/hook-service.ts, agent-hooks/installer-utils.ts
//  · 훅 우선·화면은 빈자리 = src/main/agent-hooks/README.md "Precedence"(2분 침묵 규칙 포함)
// 화면이 훅을 덮는 한 가지(살아 있는 막힘 표시)는 herdr detect/mod.rs AgentDetection.visible_blocker 주석에서 왔다.
import type { ScreenDetection } from './agentScreen'
import { deriveInteractivePrompt } from './agentAsk'

/** 훅을 심는 CLI. Codex 는 훅이 신뢰 해시(config.toml)를 요구해 이번 판에 안 심는다 — 화면 판정('추정')으로만 본다. */
export const HOOK_SOURCES = ['claude', 'gemini'] as const
export type HookSource = (typeof HOOK_SOURCES)[number]
export const isHookSource = (v: string): v is HookSource => (HOOK_SOURCES as readonly string[]).includes(v)

export type RunState = 'working' | 'blocked' | 'idle'
/** 막힘의 종류 — 질문(AskUserQuestion)이면 물음표 아이콘. */
export type BlockKind = 'permission' | 'question'

export type AgentChild = {
  /** CLI 가 준 자식 id(Claude agent_id). */
  id: string
  /** 서브에이전트 종류(Explore·general-purpose …). */
  agentType?: string
  /** 지금 도는 도구 이름. */
  tool?: string
  state: 'working' | 'blocked'
  startedAt: number
  /** 이 자식의 마지막 이벤트 시각 — 오래 조용하면 렌더러가 "응답 없음"으로 흐리게 그린다(CHILD_STALE_MS). */
  at: number
}

/** 훅으로 들은 한 칸(pane = 에이전트 탭 세션)의 상태. */
export type HookPane = {
  state: RunState
  kind?: BlockKind
  tool?: string
  children: AgentChild[]
  at: number
  /** M11 질문/승인 카드 글(Orca interactivePrompt — AskUserQuestion 입력 또는 {approval}). 막힘일 때만. */
  ask?: string
  /** 2.2.21 끝난(SubagentStop·목록에서 지움) 자식 id → 그 시각. ENDED_MS 안에 늦게 온 같은 id 의 도구 이벤트로 줄을 되살리지 않는다. */
  ended?: Record<string, number>
}

/** 화면에 내보내는 상태(main → 렌더러 `agents:status`). 봄/안 봄(done·idle)은 렌더러가 가른다. */
export type AgentStatusView = {
  sessionId: string
  /** null = 아직 모른다(셸만 떠 있거나 판정 전). */
  state: RunState | null
  kind?: BlockKind
  tool?: string
  /** 화면 판정에서 온 상태(훅이 말하지 않았다) — '추정'으로 따로 그린다. */
  estimated: boolean
  children: AgentChild[]
  /** 근거(툴팁): 'hook:<이벤트>' 또는 'screen:<규칙 id>'. */
  source: string
  /** 첫 지시를 준비된 뒤 넣으려다 못 넣었다(제한 시간). */
  promptFailed?: boolean
  /** M11 질문/승인 카드 글(훅이 막힘을 알릴 때만 — 화면 판정 막힘은 카드 없음). shared/agentAsk parseInteractivePrompt 로 읽는다. */
  ask?: string
  /** M11 에이전트가 OSC 로 정한 작업 요약 제목(agentLiveTitle — 입력 상자를 본 뒤의 것만). */
  title?: string
  /** M11 에이전트가 끝나고 셸만 남았다(main/agents/status.ts shellPromptVisible) — 재시작 칩. */
  agentExited?: true
}

const CHILD_ID_MAX = 64
/**
 * 끝난 자식의 늦은 이벤트를 버리는 시간. 훅은 이벤트마다 따로 뜬 프로세스(curl)라 도착 순서가 보장되지 않는다
 * (2.2.21 실측: 같은 순간의 PostToolUse·SubagentStart 가 뒤바뀌어 도착) — 그 사이에 온 자식 도구 이벤트가 줄을 되살렸다.
 * 이보다 늦은 이벤트는 진짜 활동으로 본다. 같은 id 의 SubagentStart(SendMessage 재개 — 실측으로 다시 온다)는 언제든 되살린다.
 */
export const ENDED_MS = 60_000
/** 이만큼 이벤트가 없는 자식은 "응답 없음"(흐리게 + [×]). 막힘은 사람을 기다리는 중이라 제외. 자동으로 지우지는 않는다. */
export const CHILD_STALE_MS = 30 * 60_000
export const childStale = (c: AgentChild, now: number): boolean => c.state !== 'blocked' && now - c.at > CHILD_STALE_MS
const str = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
const isQuestionTool = (tool: string | undefined): boolean => tool === 'AskUserQuestion'

function withChild(children: AgentChild[], id: string, patch: Partial<AgentChild>, now: number): AgentChild[] {
  if (id.length > CHILD_ID_MAX) return children
  const cur = children.find((c) => c.id === id)
  if (cur) return children.map((c) => (c.id === id ? { ...c, ...patch, agentType: patch.agentType ?? c.agentType, at: now } : c))
  return [...children, { id, state: 'working', startedAt: now, at: now, ...patch }]
}

/** 끝난 자식 기록(ENDED_MS 지난 것은 버린다 — 오래 켜 둔 세션에서 쌓이지 않게). */
function withEnded(ended: Record<string, number> | undefined, id: string | null, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, t] of Object.entries(ended ?? {})) if (now - t <= ENDED_MS) out[k] = t
  if (id) out[id] = now
  return out
}

/** 자식 줄 하나를 목록에서 뺀다(2.2.21 [목록에서 지우기] — 표시만, 프로세스는 그대로). 끝난 것으로 기록해 늦은 이벤트가 되살리지 않는다. */
export function forgetChild(prev: HookPane, id: string, now: number): HookPane {
  return { ...prev, children: prev.children.filter((c) => c.id !== id), ended: withEnded(prev.ended, id, now) }
}

/**
 * 훅 하나를 칸 상태에 반영한다. 모르는 이벤트는 `null`(바꾸지 않음 — 침묵·모르는 것이 상태를 만들지 않는다).
 * Claude: 자식(agent_id 가 붙은 이벤트)의 도구 이벤트는 자식 줄만 바꾸고, 자식이 승인·질문을 기다리면 그 막힘은 부모로 올린다(Orca 와 같다).
 */
export function applyHookEvent(prev: HookPane | null, source: HookSource, payload: Record<string, unknown>, now: number): HookPane | null {
  const next = applyHookEventInner(prev, source, payload, now)
  // M11: 카드 글은 막힘 동안만 산다(막힘이 풀리면 카드도 내린다 — Orca: post-tool 이벤트가 답한 카드를 되살리지 않는다).
  if (next && next.state !== 'blocked' && next.ask !== undefined) return { ...next, ask: undefined }
  return next
}

function applyHookEventInner(prev: HookPane | null, source: HookSource, payload: Record<string, unknown>, now: number): HookPane | null {
  const event = str(payload, 'hook_event_name')
  if (!event) return null
  const base: HookPane = prev ?? { state: 'idle', children: [], at: now }
  const tool = str(payload, 'tool_name')

  if (source === 'gemini') {
    if (event === 'BeforeAgent') return { ...base, state: 'working', kind: undefined, tool: undefined, at: now }
    if (event === 'BeforeTool' || event === 'AfterTool') return { ...base, state: 'working', kind: undefined, tool, at: now }
    if (event === 'AfterAgent') return { ...base, state: 'idle', kind: undefined, tool: undefined, at: now }
    return null
  }

  const agentId = str(payload, 'agent_id')
  const agentType = str(payload, 'agent_type')
  const waits = event === 'PermissionRequest' || (event === 'PreToolUse' && isQuestionTool(tool))
  const kind: BlockKind = isQuestionTool(tool) ? 'question' : 'permission'

  if (event === 'SubagentStart' && agentId) {
    const { [agentId]: _revived, ...ended } = base.ended ?? {}
    return { ...base, children: withChild(base.children, agentId, { agentType, state: 'working' }, now), ended, at: now }
  }
  if ((event === 'SubagentStop' || event === 'StopFailure') && agentId) return { ...forgetChild(base, agentId, now), at: now }
  // 부모 세션이 끝났다(/clear·종료) — 그 세션의 자식은 다 끝났다. 새 세션은 빈 목록으로.
  if (event === 'SessionEnd') return { state: 'idle', children: [], at: now }

  if (agentId) {
    // 방금 끝난 자식의 늦은 도구 이벤트는 버린다(되살리지 않는다).
    const endedAt = base.ended?.[agentId]
    if (endedAt !== undefined && now - endedAt <= ENDED_MS) return null
    // 자식의 도구 이벤트. 막힘만 부모로 — 나머지는 자식 줄의 "지금 하는 일"이다.
    if (waits) return { ...base, state: 'blocked', kind, ask: deriveInteractivePrompt(tool, payload['tool_input'], event), children: withChild(base.children, agentId, { agentType, state: 'blocked', tool }, now), at: now }
    if (event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const children = withChild(base.children, agentId, { agentType, state: 'working', tool: event === 'PreToolUse' ? tool : undefined }, now)
      // 그 자식의 막힘이 풀렸으면 부모도 일하는 중으로 되돌린다.
      const unblocked = base.state === 'blocked' && base.children.find((c) => c.id === agentId)?.state === 'blocked'
      return { ...base, ...(unblocked ? { state: 'working' as const, kind: undefined } : {}), children, at: now }
    }
    return null
  }

  if (waits) return { ...base, state: 'blocked', kind, tool, ask: deriveInteractivePrompt(tool, payload['tool_input'], event), at: now }
  if (event === 'UserPromptSubmit') return { ...base, state: 'working', kind: undefined, tool: undefined, at: now }
  if (event === 'PreToolUse') return { ...base, state: 'working', kind: undefined, tool, at: now }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') return { ...base, state: 'working', kind: undefined, tool: undefined, at: now }
  if (event === 'Stop' || event === 'StopFailure') return { ...base, state: 'idle', kind: undefined, tool: undefined, at: now }
  return null
}

/** 훅이 이만큼 말이 없으면서 화면이 이미 쉬고 있으면 화면을 믿는다(Orca README "hooks that went silent for 2 minutes"). Esc 로 끊은 턴은 Stop 훅이 안 온다. */
export const HOOK_SILENT_MS = 2 * 60_000

/**
 * 훅과 화면 판정을 합친다. 훅이 있으면 훅이 이긴다(herdr·Orca 같음). 예외 둘:
 *  ① 화면에 **살아 있는 막힘 UI**(visibleBlocker)가 보이는데 훅은 막힘이 아니라고 하면 막힘(추정) — Gemini 는 승인 훅이 없다.
 *  ② 훅이 '일하는 중'에서 2분 넘게 말이 없고 화면은 살아 있는 쉼(visibleIdle)을 보이면 쉼(추정).
 * 훅이 없으면 화면 판정이 '추정'으로 채운다. 화면이 판정을 건너뛰라고 하면(skip) 앞 상태를 그대로 둔다.
 */
export function resolveStatus(
  sessionId: string,
  hook: { pane: HookPane; event: string } | null,
  screen: ScreenDetection | null,
  prev: AgentStatusView | null,
  now: number
): AgentStatusView {
  const children = hook?.pane.children ?? []
  if (hook) {
    const p = hook.pane
    if (screen?.visibleBlocker && p.state !== 'blocked') return { sessionId, state: 'blocked', kind: 'permission', estimated: true, children, source: `screen:${screen.rule}` }
    if (p.state === 'working' && now - p.at > HOOK_SILENT_MS && screen?.visibleIdle) return { sessionId, state: 'idle', estimated: true, children, source: `screen:${screen.rule}` }
    return { sessionId, state: p.state, kind: p.kind, tool: p.tool, estimated: false, children, source: `hook:${hook.event}`, ...(p.ask ? { ask: p.ask } : {}) }
  }
  if (!screen || screen.skip) return prev ?? { sessionId, state: null, estimated: true, children, source: 'none' }
  if (screen.state === 'unknown') return { sessionId, state: null, estimated: true, children, source: 'screen:unknown' }
  return { sessionId, state: screen.state, kind: screen.state === 'blocked' ? 'permission' : undefined, estimated: true, children, source: `screen:${screen.rule ?? 'fallback'}` }
}

// ── 훅(Orca 방식): ~/.ara/agent-hooks/<cli>-hook.(cmd|sh) 스크립트 + 그 스크립트를 부르는 줄. M9 R3: 줄은 전역 설정 파일이 아니라 아라가 띄우는 실행에만(launchHooks) ─────

/** 훅 스크립트가 읽는 env 셋. 에이전트 탭 셸에만 넣는다 — 터미널 공간 셸에는 없다(그 셸에서 직접 친 claude 는 훅이 아무 일도 안 한다). */
/** M4 DM-01: 데몬이 죽어 잃은 에이전트 세션의 종료 코드(main/daemon/service.ts 가 낸다) — 탭이 "잃음"으로 그린다. */
export const AGENT_SESSION_LOST_EXIT = -32768

export const HOOK_ENV = { port: 'ARA_AGENT_HOOK_PORT', token: 'ARA_AGENT_HOOK_TOKEN', pane: 'ARA_PANE_KEY' } as const
export const HOOK_TOKEN_HEADER = 'x-ara-agent-hook-token'
export const HOOK_PANE_HEADER = 'x-ara-pane-key'

/** CLI 별 심는 이벤트·설정 파일. */
export const HOOK_TARGETS: Record<HookSource, { configDir: string; events: readonly string[]; matcherEvents: readonly string[]; timeout: number }> = {
  // Orca CLAUDE_EVENTS 에서 상태·자식 줄에 쓰는 것만. matcher '*' 는 도구 이벤트(모든 도구).
  claude: {
    configDir: '.claude',
    // 2.2.21 SessionEnd — /clear·종료 때 자식 줄을 비운다(SubagentStop 이 안 온 자식이 남지 않게).
    events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd'],
    matcherEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'],
    timeout: 10
  },
  // Orca GEMINI_EVENTS — Gemini 는 승인 훅이 없다(막힘은 화면 판정이 채운다). 제한 시간은 밀리초(Claude 는 초).
  gemini: { configDir: '.gemini', events: ['BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'], matcherEvents: [], timeout: 10_000 }
}

export const hookScriptName = (source: HookSource, win: boolean): string => `${source}-hook.${win ? 'cmd' : 'sh'}`

/**
 * 훅 스크립트. 규율(Orca hook-script.ts 와 같다):
 *  · 먼저 `{}` 를 찍는다 — 승인 훅은 빈 출력이면 막힌 쪽으로 닫힌다. 어떤 길로 나가도 이 줄이 먼저다.
 *  · env 셋 중 하나라도 없으면(우리 에이전트 탭 밖에서 뜬 CLI) 아무 일도 안 하고 0 으로 나간다.
 *  · 본문(훅 JSON)은 stdin 그대로 curl 로 흘려보낸다(명령줄에 안 싣는다). curl 은 0.5초 연결·1.5초 상한. 무슨 일이 있어도 0.
 * Windows 는 Windows 10+ 에 들어 있는 `%SystemRoot%\System32\curl.exe` 를 절대 경로로 부른다(저장소 안 curl 가로채기 방지·PowerShell 기동 없음).
 */
export function hookScript(source: HookSource, win: boolean): string {
  const { port, token, pane } = HOOK_ENV
  if (win) {
    return [
      '@echo off',
      'setlocal',
      'echo {}',
      `if "%${port}%"=="" exit /b 0`,
      `if "%${token}%"=="" exit /b 0`,
      `if "%${pane}%"=="" exit /b 0`,
      `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%${port}%/hook/${source}" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" -H "${HOOK_TOKEN_HEADER}: %${token}%" -H "${HOOK_PANE_HEADER}: %${pane}%" --data-binary @- >nul 2>&1`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    'printf "{}\\n"',
    `if [ -z "$${port}" ] || [ -z "$${token}" ] || [ -z "$${pane}" ]; then`,
    '  exit 0',
    'fi',
    `curl -sS -X POST "http://127.0.0.1:\${${port}}/hook/${source}" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" -H "${HOOK_TOKEN_HEADER}: \${${token}}" -H "${HOOK_PANE_HEADER}: \${${pane}}" --data-binary @- >/dev/null 2>&1`,
    'exit 0',
    ''
  ].join('\n')
}

/**
 * 설정 파일에 적을 명령. Windows 는 슬래시로 바꾼 맨 경로(Orca wrapWindowsDirectCmdHookCommand) — Git Bash·PowerShell·CreateProcess 셋 다 그대로 실행한다.
 * ponytail: 경로에 공백·특수 글자가 있으면(사용자 이름에 공백) 큰따옴표로 감싼다 — Git Bash·cmd 는 되지만 PowerShell 호스트는 문자열로 읽는다.
 * Orca 는 그때 PowerShell -EncodedCommand 런처로 간다. 그런 PC 가 나오면 그 런처를 옮긴다.
 */
export function hookCommand(scriptPath: string, win: boolean): string {
  if (!win) return /^[A-Za-z0-9_./~-]+$/.test(scriptPath) ? scriptPath : `'${scriptPath.replace(/'/g, `'\\''`)}'`
  const p = scriptPath.replace(/\\/g, '/')
  return /^[A-Za-z]:\/[A-Za-z0-9_.:/~-]+$/.test(p) ? p : `"${p}"`
}

// ── M9 AI-10 Claude statusLine → 사용량(Orca src/main/claude/statusline-script.ts) ─────
// Claude ≥2.1.80 는 statusLine 명령의 stdin JSON 에 `rate_limits`(5시간·주간)를 싣는다 — 사용량 엔드포인트를 두드리지 않고 실시간 값을 받는다.
// M9 R2: **전역 settings.json 에 심지 않는다**(사용자 PC 침범 — 터미널에서 친 claude 상태줄이 비고, 사용자 statusLine 이 있으면 못 받았다).
// 아라가 띄우는 claude 에만 `--settings <파일>` 로 준다. 사용자의 원래 statusLine 이 있으면 `<우리 스크립트> pass | <원래 명령>` —
// 우리 스크립트가 같은 입력을 그대로 흘려보내고, 화면에 찍히는 것은 원래 명령의 출력이다.

export const STATUSLINE_PATH = '/statusline/claude'
export const statusLineScriptName = (win: boolean): string => `claude-statusline.${win ? 'cmd' : 'sh'}`
/** R1 이 전역 설정에 심을 때 남긴 표식(같은 폴더). R2 정리(removeOurStatusLine) 뒤 지운다. */
export const STATUSLINE_MARKER = 'claude-statusline.installed'
/** statusLine 은 초당 몇 번 돈다 — 스크립트가 15초에 한 번만 curl 을 띄운다(Orca CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS). */
const STATUSLINE_MIN_POST_SECONDS = 15

/**
 * statusLine 스크립트. 인자 없이 돌면 **아무것도 찍지 않는다**. `pass` 를 주면 받은 입력을 그대로 stdout 으로 흘린다(뒤에 사용자 명령이 파이프로 붙는다) —
 * 일찍 끝나는 길(env 없음·백그라운드 작업 CLAUDE_JOB_DIR·rate_limits 없음·15초 안의 두 번째)에서도 흘린다.
 * Windows 는 stdin 을 `findstr "^"` 로 받는다(바이트 그대로 — R1 의 more.com 은 코드페이지를 거쳐 한글 경로가 깨졌다).
 */
export function statusLineScript(win: boolean): string {
  const { port, token, pane } = HOOK_ENV
  if (win) {
    const findstr = '"%SystemRoot%\\System32\\findstr.exe"'
    return [
      '@echo off',
      'setlocal',
      'set "ARA_SL_PASS="',
      'if /i "%~1"=="pass" set "ARA_SL_PASS=1"',
      'if not "%CLAUDE_JOB_DIR%"=="" goto :passonly',
      `if "%${pane}%"=="" goto :passonly`,
      `if "%${port}%"=="" goto :passonly`,
      `if "%${token}%"=="" goto :passonly`,
      `set "ARA_SL_ID=%${pane}:~-36%"`,
      'set "ARA_SL_ID=%ARA_SL_ID::=_%"',
      'set "ARA_SL_FILE=%TEMP%\\ara-claude-statusline-%ARA_SL_ID%-%RANDOM%.tmp"',
      `${findstr} "^" >"%ARA_SL_FILE%" 2>nul`,
      'set "ARA_SL_STAMP=%TEMP%\\ara-claude-statusline-last-%ARA_SL_ID%.tmp"',
      'set "ARA_SL_NOW="',
      'set "ARA_SL_TIME=%TIME: =0%"',
      'for /f "tokens=1-3 delims=:.," %%a in ("%ARA_SL_TIME%") do set /a "ARA_SL_NOW=(1%%a %% 100)*3600+(1%%b %% 100)*60+(1%%c %% 100)" 2>nul',
      'set "ARA_SL_LAST="',
      'set "ARA_SL_ELAPSED="',
      'if exist "%ARA_SL_STAMP%" set /p ARA_SL_LAST=<"%ARA_SL_STAMP%"',
      'if defined ARA_SL_LAST for /f "delims=0123456789" %%d in ("%ARA_SL_LAST%") do set "ARA_SL_LAST="',
      'if defined ARA_SL_NOW if defined ARA_SL_LAST set /a "ARA_SL_ELAPSED=ARA_SL_NOW-ARA_SL_LAST" 2>nul',
      'if not defined ARA_SL_ELAPSED goto :probe',
      `if %ARA_SL_ELAPSED% GEQ 0 if %ARA_SL_ELAPSED% LSS ${STATUSLINE_MIN_POST_SECONDS} goto :cleanup`,
      ':probe',
      `${findstr} /c:\\"rate_limits\\" "%ARA_SL_FILE%" >nul 2>nul`,
      'if errorlevel 1 goto :cleanup',
      'if defined ARA_SL_NOW (>"%ARA_SL_STAMP%" echo %ARA_SL_NOW%)',
      `"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%${port}%${STATUSLINE_PATH}" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" -H "${HOOK_TOKEN_HEADER}: %${token}%" -H "${HOOK_PANE_HEADER}: %${pane}%" --data-binary @"%ARA_SL_FILE%" >nul 2>&1`,
      ':cleanup',
      'if defined ARA_SL_PASS type "%ARA_SL_FILE%"',
      'del "%ARA_SL_FILE%" >nul 2>nul',
      'exit /b 0',
      ':passonly',
      `if defined ARA_SL_PASS ${findstr} "^"`,
      'exit /b 0',
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    'mode=$1',
    'payload=$(cat)',
    'out() { [ "$mode" = pass ] && printf \'%s\\n\' "$payload"; exit 0; }',
    '[ -n "$CLAUDE_JOB_DIR" ] && out',
    `if [ -z "$${port}" ] || [ -z "$${token}" ] || [ -z "$${pane}" ]; then out; fi`,
    'case "$payload" in *\'"rate_limits"\'*) ;; *) out ;; esac',
    `stamp="\${TMPDIR:-/tmp}/ara-claude-statusline-last-$(printf '%s' "$${pane}" | tr -c 'A-Za-z0-9._-' '_')"`,
    'now=$(date +%s 2>/dev/null) || now=',
    'case "$now" in [1-9]*) ;; *) now= ;; esac',
    'if [ -n "$now" ] && [ -f "$stamp" ]; then',
    '  last=$(cat "$stamp" 2>/dev/null)',
    '  case "$last" in [1-9]*) [ $((now - last)) -ge 0 ] && [ $((now - last)) -lt ' + STATUSLINE_MIN_POST_SECONDS + ' ] && out ;; esac',
    'fi',
    '[ -n "$now" ] && printf \'%s\' "$now" >"$stamp" 2>/dev/null',
    `printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:\${${port}}${STATUSLINE_PATH}" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/json" -H "${HOOK_TOKEN_HEADER}: \${${token}}" -H "${HOOK_PANE_HEADER}: \${${pane}}" --data-binary @- >/dev/null 2>&1`,
    'out',
    ''
  ].join('\n')
}

const isOurStatusLine = (command: string): boolean => /[\\/]\.ara[\\/]agent-hooks[\\/]/.test(command) && command.includes('claude-statusline.')
type StatusLineDef = Record<string, unknown> & { command: string }
const statusLineOf = (settings: unknown): StatusLineDef | null => {
  const sl = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Settings)['statusLine'] : null
  return sl && typeof sl === 'object' && typeof (sl as { command?: unknown }).command === 'string' && (sl as { command: string }).command.trim() ? (sl as StatusLineDef) : null
}

/**
 * 사용자의 원래 statusLine(높은 것부터: `<cwd>/.claude/settings.local.json` · `<cwd>/.claude/settings.json` · 사용자 settings.json).
 * 우리 것(R1 이 전역에 심은 줄)은 건너뛴다. 없으면 null.
 */
export function userStatusLine(layers: readonly unknown[]): StatusLineDef | null {
  for (const l of layers) {
    const sl = statusLineOf(l)
    if (sl && !isOurStatusLine(sl.command)) return sl
  }
  return null
}

/**
 * `--settings` 로 넘길 설정(아라 에이전트 탭의 claude 에만). 사용자 statusLine 이 있으면 그 나머지 칸(padding 등)은 그대로 두고 명령만
 * `<스크립트> pass | <원래 명령>` 으로 — 원래 명령이 같은 입력을 받아 같은 줄을 찍는다.
 * ponytail: 원래 명령이 `a && b` 처럼 여러 개면 파이프는 첫 명령에만 붙는다(원래도 둘째는 남은 입력을 받았다). 그런 사용자가 나오면 셸 묶음으로.
 */
export function claudeLaunchSettings(scriptCommand: string, user: StatusLineDef | null, hookCmd?: string): Settings {
  return {
    ...(hookCmd ? launchHooks('claude', hookCmd) : {}),
    statusLine: user ? { ...user, type: 'command', command: `${scriptCommand} pass | ${user.command}` } : { type: 'command', command: scriptCommand }
  }
}

/** R1 이 전역 settings.json 에 심은 우리 statusLine 을 뺀 설정. 우리 것이 아니거나 없으면 null(쓰지 않는다 — 남의 statusLine 은 그대로). */
export function removeOurStatusLine(settings: unknown): Settings | null {
  const sl = statusLineOf(settings)
  if (!sl || !isOurStatusLine(sl.command)) return null
  const next = { ...(settings as Settings) }
  delete next['statusLine']
  return next
}

type HookCmd = { type?: string; command?: unknown; timeout?: number }
type HookDef = { matcher?: string; hooks?: HookCmd[] } & Record<string, unknown>
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> }

/** 훅 줄을 지운다(남의 줄은 그대로, 비어 버린 묶음·이벤트만 없앤다). `ours` 가 참인 명령만. */
function stripHooks(settings: Settings, ours: (command: string) => boolean): { next: Settings; removed: number } {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') return { next: settings, removed: 0 }
  let removed = 0
  const nextHooks: Record<string, unknown> = {}
  for (const [event, defs] of Object.entries(hooks)) {
    if (!Array.isArray(defs)) {
      nextHooks[event] = defs
      continue
    }
    const kept = (defs as HookDef[]).flatMap((d) => {
      if (!d || typeof d !== 'object' || !Array.isArray(d.hooks)) return [d]
      const hs = d.hooks.filter((h) => {
        const mine = typeof h?.command === 'string' && ours(h.command)
        if (mine) removed++
        return !mine
      })
      if (hs.length === d.hooks.length) return [d]
      return hs.length ? [{ ...d, hooks: hs }] : []
    })
    if (kept.length || defs.length === 0) nextHooks[event] = kept
  }
  return { next: { ...settings, hooks: nextHooks }, removed }
}

/** 우리 훅 줄인가 — 스크립트 파일 이름으로 가린다(Orca createManagedCommandMatcher: 옛 경로·옮긴 홈의 줄도 잡힌다). */
export const isOurHookCommand = (source: HookSource) => (command: string): boolean => /[\\/]\.ara[\\/]agent-hooks[\\/]/.test(command) && command.includes(`${source}-hook.`)

/**
 * 우리 훅을 심은 설정을 돌려준다(순수). 우리 줄은 지우고 다시 넣고, 남의 줄은 그대로. 이미 같으면 `null`(파일을 안 고친다).
 */
export function mergeHooks(settings: unknown, source: HookSource, command: string): Settings | null {
  const base: Settings = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Settings) : {}
  const { next } = stripHooks(base, isOurHookCommand(source))
  const t = HOOK_TARGETS[source]
  const hooks = { ...(next.hooks ?? {}) } as Record<string, unknown>
  for (const event of t.events) {
    const cur = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const def: HookDef = { ...(t.matcherEvents.includes(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: t.timeout }] }
    hooks[event] = [...cur, def]
  }
  const out = { ...next, hooks }
  return JSON.stringify(out) === JSON.stringify(base) ? null : out
}

/**
 * M9 R3 — 실행 한 번에 넘길 훅 설정(`{ hooks }`). 전역 설정 파일에 심지 않고 Claude 는 `--settings` 파일, Gemini 는 시스템 기본값 파일에 담는다.
 * 두 CLI 모두 hooks 는 층마다 **이어 붙인다**(실측: Claude 2.1.300 get_settings effective = userSettings + flagSettings 훅 둘 다·둘 다 실행,
 * gemini-cli 0.46 settingsSchema hooks.* mergeStrategy concat) — 사용자 원래 훅은 그대로 돈다.
 */
export const launchHooks = (source: HookSource, command: string): Settings => mergeHooks({}, source, command) ?? {}

/** M3 이 전역 settings.json 에 심은 우리 훅 줄만 뺀 설정. 우리 줄이 없으면 null(쓰지 않는다 — 남의 훅은 그대로). 비어 버린 hooks 칸은 없앤다. */
export function removeOurHooks(settings: unknown, source: HookSource): Settings | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const { next, removed } = stripHooks(settings as Settings, isOurHookCommand(source))
  if (!removed) return null
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks
  return next
}

/** 옛 아라 훅(1.x~2.1, `# ara-agent-hook` 표식 — main/agent/claudeHooks.ts)의 표식. S2 정리 1회가 이 줄만 지운다. */
export const LEGACY_HOOK_MARK = 'ara-agent-hook'

/** 옛 아라 훅 줄만 지운 설정(없으면 `null` — 파일을 안 고친다). 남의 훅·새 훅(`.ara/agent-hooks`)은 그대로. */
export function removeLegacyHooks(settings: unknown): Settings | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const { next, removed } = stripHooks(settings as Settings, (c) => c.includes(`# ${LEGACY_HOOK_MARK}`))
  return removed ? next : null
}
