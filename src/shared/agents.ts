// M3 라운드 1 — AI 작업 공간 에이전트(AI-01 설치 감지·피커, AI-02 실행 설정, AI-03 실행 + 첫 지시)의 순수 규칙.
// main(감지·실행 계획)과 렌더러(피커·설정 화면)가 같이 읽는다. Orca(orcaRef 7a7f46f8a3)에서 기능 단위로 옮겼다:
//  · 목록 = tui-agent-config.ts(detectCmd·promptInjectionMode) — 처음 지원 셋(결정 묶음 2). 나머지는 이 표에 한 줄씩.
//  · 권한 = tui-agent-permissions.ts·tui-agent-permission-choice.ts 의 플래그 표 그대로, 기본 full-access(Yolo — Orca 기본값).
//  · 명령 계획 = agent-command-plan.ts parseAgentCommand + command-environment.ts extractLeadingEnvAssignments.
//  · 판 = app-version.ts parseCliVersion · agent-cli-version-probe.ts(시험은 runProcess 를 바꿔 끼운다 — 진짜 CLI 안 띄움).
//  · 셸 PATH = startup/hydrate-shell-path.ts 의 표식 사이 값 읽기.
import type { LaunchShell } from './aiCli'

export const AGENT_IDS = ['claude', 'codex', 'gemini'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export function isAgentId(v: unknown): v is AgentId {
  return AGENT_IDS.includes(v as AgentId)
}

/** Orca AgentPermissionChoice — 저장값이라 이름을 바꾸지 않는다. own = 플래그를 붙이지 않음(CLI 자기 설정). */
export const PERMISSION_CHOICES = ['own', 'ask', 'accept-edits', 'auto', 'full-access'] as const
export type AgentPermissionChoice = (typeof PERMISSION_CHOICES)[number]
export const DEFAULT_PERMISSION: AgentPermissionChoice = 'full-access'

/** 첫 지시를 넘기는 방식(Orca promptInjectionMode). argv = 맨 끝 인자, flag-prompt-interactive = `--prompt-interactive <글>`. */
type PromptMode = 'argv' | 'flag-prompt-interactive'

type AgentSpec = {
  label: string
  /** 설치 감지·기본 실행 이름(Orca detectCmd). */
  bin: string
  prompt: PromptMode
  /** 권한 선택 → 붙일 플래그(Orca YOLO/AUTO/ASK/ACCEPT_EDITS_TUI_AGENT_ARGS). 없는 선택은 이 CLI 가 모르는 것. */
  permissionArgs: Partial<Record<Exclude<AgentPermissionChoice, 'own'>, string>>
  /** 사용자 인자에 이 중 하나가 있으면 권한 플래그를 붙이지 않는다 — 사용자가 직접 정한 것이 이긴다. */
  permissionFlags: readonly string[]
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    prompt: 'argv',
    permissionArgs: {
      'full-access': '--dangerously-skip-permissions',
      auto: '--permission-mode auto',
      'accept-edits': '--permission-mode acceptEdits',
      ask: '--permission-mode default'
    },
    permissionFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode']
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    prompt: 'argv',
    permissionArgs: {
      'full-access': '--dangerously-bypass-approvals-and-sandbox',
      auto: '--approve-for-me',
      ask: '-a on-request -s read-only -c approvals_reviewer=user'
    },
    permissionFlags: ['--dangerously-bypass-approvals-and-sandbox', '--approve-for-me', '-a', '--ask-for-approval', '-s', '--sandbox', '--full-auto', '--yolo']
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    prompt: 'flag-prompt-interactive',
    permissionArgs: { 'full-access': '--yolo' },
    permissionFlags: ['--yolo', '-y', '--approval-mode']
  }
}

/** 이 에이전트가 고를 수 있는 권한(own + 플래그가 있는 것). Orca agentPermissionChoices 의 터미널 쪽. */
export function permissionChoicesFor(agent: AgentId): AgentPermissionChoice[] {
  return PERMISSION_CHOICES.filter((c) => c === 'own' || AGENTS[agent].permissionArgs[c] !== undefined)
}

// ── 설정(AI-02) ───────────────────────────────────────────────────────────────

export type AgentPrefs = {
  /** 피커에 보일까(설정 › 에이전트의 켜고 끄기). */
  enabled: boolean
  permission: AgentPermissionChoice
  /** 덧붙일 인자(한 줄 — tokenizeArgs 로 나눈다). */
  args: string
  /** 덧붙일 환경 변수. 에이전트 탭 셸의 env 로 들어간다. */
  env: Record<string, string>
  /** 실행 명령 바꾸기(Orca cmdOverrides) — 빈 값이면 bin. `FOO=1 npx claude` 처럼 앞 env 할당·접두 인자 허용. */
  command: string
}

export type AgentSettings = {
  agents: Record<AgentId, AgentPrefs>
  /** 피커가 처음 고르는 것. */
  defaultAgent: AgentId
  /**
   * Claude 원격 제어 자동 켜기(`--rc`, 결정 묶음 9). **기본 꺼짐** — 팀 플랜 관리자 설정·로그인 상태에 따라
   * 실패할 수 있어 사용자가 켜게 한다.
   */
  claudeRemoteControl: boolean
  /** 옛 터미널 AI 기본 플래그(`aiCliFlags`)를 한 번 옮겼나(migrateAiCliFlags). */
  migratedAiCliFlags: boolean
  /**
   * M4 R3 자원: 에이전트를 낮은 우선순위로(묶음 0/13). **기본 켬** — 에이전트가 빌드·시험을 돌려도 사람이 쓰는 편집기·터미널이
   * 먼저 CPU 를 받는다. 다툼이 없으면 속도 차이가 없다(Windows BELOW_NORMAL 은 다툴 때만 밀린다).
   */
  lowPriority: boolean
  /** M4 R3 자원: 세션(프로세스 트리) 메모리 상한 MB — 넘으면 알림만(자동 종료 안 함). 0 = 끔(기본). */
  memoryCapMb: number
}

/** 메모리 상한 칸의 범위(MB). 넘거나 모자라면 끔(0)으로 읽는다. */
export const MEMORY_CAP_MAX_MB = 1024 * 1024

const defaultPrefs = (): AgentPrefs => ({ enabled: true, permission: DEFAULT_PERMISSION, args: '', env: {}, command: '' })

export function defaultAgentSettings(): AgentSettings {
  return {
    agents: { claude: defaultPrefs(), codex: defaultPrefs(), gemini: defaultPrefs() },
    defaultAgent: 'claude',
    claudeRemoteControl: false,
    migratedAiCliFlags: false,
    lowPriority: true,
    memoryCapMb: 0
  }
}

const MAX_TEXT = 2000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function envOf(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(
    Object.entries(v).filter(([k, x]) => ENV_NAME.test(k) && typeof x === 'string' && !/[\r\n\0]/.test(x))
  ) as Record<string, string>
}

const textOf = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')

/** 저장값(agents.json — 손으로 고칠 수 있다) → 확정값. 모르는 키·틀린 형은 기본값으로. */
export function agentSettingsOf(raw: unknown): AgentSettings {
  const base = defaultAgentSettings()
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AgentSettings, unknown>>
  const agents = (src.agents && typeof src.agents === 'object' ? src.agents : {}) as Partial<Record<string, unknown>>
  for (const id of AGENT_IDS) {
    const a = (agents[id] && typeof agents[id] === 'object' ? agents[id] : {}) as Partial<Record<keyof AgentPrefs, unknown>>
    const permission = PERMISSION_CHOICES.includes(a.permission as AgentPermissionChoice) ? (a.permission as AgentPermissionChoice) : DEFAULT_PERMISSION
    base.agents[id] = {
      enabled: a.enabled !== false,
      // 이 CLI 가 모르는 권한(예: gemini 의 auto)은 기본값으로.
      permission: permissionChoicesFor(id).includes(permission) ? permission : DEFAULT_PERMISSION,
      args: textOf(a.args),
      env: envOf(a.env),
      command: textOf(a.command)
    }
  }
  if (isAgentId(src.defaultAgent)) base.defaultAgent = src.defaultAgent
  base.claudeRemoteControl = src.claudeRemoteControl === true
  base.migratedAiCliFlags = src.migratedAiCliFlags === true
  base.lowPriority = src.lowPriority !== false
  base.memoryCapMb = memoryCapOf(src.memoryCapMb)
  return base
}

/** 저장값·입력 칸 → 메모리 상한 MB(정수). 범위 밖·숫자 아님 = 0(끔). */
export function memoryCapOf(v: unknown): number {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= MEMORY_CAP_MAX_MB ? Math.floor(n) : 0
}

/** 데몬에 보낼 상한(shared/resources AgentLimits). */
export function agentLimitsOf(s: Pick<AgentSettings, 'lowPriority' | 'memoryCapMb'>): { lowPriority: boolean; memoryBytes: number } {
  return { lowPriority: s.lowPriority, memoryBytes: s.memoryCapMb * 1024 * 1024 }
}

/** 설정 화면의 환경 변수 칸(`KEY=VALUE` 한 줄씩) → env. 형이 틀린 줄은 bad 로 돌려 화면이 알린다. */
export function parseEnvLines(text: string): { env: Record<string, string>; bad: string[] } {
  const env: Record<string, string> = {}
  const bad: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!ENV_NAME.test(name)) {
      bad.push(line)
      continue
    }
    env[name] = line.slice(eq + 1)
  }
  return { env, bad }
}

export function envToLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/**
 * 옛 설정 [AI] 의 터미널 AI 기본 플래그(`aiCliFlags` — shared/aiCli.ts 의 id 목록)를 에이전트 설정으로 **한 번** 옮긴다.
 * 실제 터미널 AI 제거(S1)는 라운드 3. 켜 둔 것(양의 신호)만 옮긴다 — codex·gemini 는 옛 기본값이 "전부 끔"이라
 * 끈 것과 안 만진 것을 가를 수 없으므로 새 기본값(Yolo, 결정 묶음 2)을 그대로 둔다.
 *  · claude: skipPerms 켬 → full-access, **꺼져 있으면 own**(옛 기본값이 켬이었으니 끈 것은 사용자 뜻)
 *            resume(-r)·continue(-c) 는 옮기지 않는다 — 첫 지시와 같이 쓰면 세션 고르기 화면이 지시를 먹는다(재개는 AI-07).
 *  · codex : bypass → full-access, fullAuto → 인자 `--full-auto`(권한 플래그로 읽혀 Yolo 를 덧붙이지 않는다)
 *  · gemini: yolo → full-access, sandbox·checkpoint → 인자
 */
export function migrateAiCliFlags(settings: AgentSettings, aiCliFlags: unknown): AgentSettings {
  const next: AgentSettings = { ...settings, agents: { ...settings.agents }, migratedAiCliFlags: true }
  const src = (aiCliFlags && typeof aiCliFlags === 'object' ? aiCliFlags : {}) as Partial<Record<string, unknown>>
  const flags = (id: AgentId): string[] | null => (Array.isArray(src[id]) ? (src[id] as unknown[]).filter((x): x is string => typeof x === 'string') : null)
  const addArgs = (cur: string, extra: string[]): string => [cur, ...extra.filter((x) => !cur.split(/\s+/).includes(x))].filter(Boolean).join(' ')

  const claude = flags('claude')
  if (claude) next.agents.claude = { ...next.agents.claude, permission: claude.includes('skipPerms') ? 'full-access' : 'own' }
  const codex = flags('codex')
  if (codex?.includes('bypass')) next.agents.codex = { ...next.agents.codex, permission: 'full-access' }
  if (codex?.includes('fullAuto')) next.agents.codex = { ...next.agents.codex, args: addArgs(next.agents.codex.args, ['--full-auto']) }
  const gemini = flags('gemini')
  if (gemini) {
    const extra = [gemini.includes('sandbox') ? '--sandbox' : '', gemini.includes('checkpoint') ? '--checkpointing' : ''].filter(Boolean)
    next.agents.gemini = {
      ...next.agents.gemini,
      ...(gemini.includes('yolo') ? { permission: 'full-access' as const } : {}),
      args: addArgs(next.agents.gemini.args, extra)
    }
  }
  return next
}

// ── 명령 계획(Orca agent-command-plan) ──────────────────────────────────────────

export type Tokenized = { ok: true; tokens: string[] } | { ok: false; error: string }

/**
 * 한 줄 → 낱말. Orca tokenizeCustomCommandTemplate 의 핵심(따옴표 두 종류·이어 붙는 조각·백슬래시).
 * backslash 'literal' = Windows(경로의 `\` 를 글자로). 셸 확장(`$x`·`` ` ``)은 하지 않는다 — 글자 그대로 넘긴다.
 */
export function tokenizeArgs(text: string, backslash: 'escape' | 'literal' = 'escape'): Tokenized {
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (backslash === 'escape' && quote === '"' && ch === '\\' && i + 1 < text.length) {
        cur += text[++i]
      } else if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (backslash === 'escape' && ch === '\\' && i + 1 < text.length) {
      cur += text[++i]
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(cur)
      cur = ''
      inToken = false
    } else {
      cur += ch
      inToken = true
    }
  }
  if (quote) return { ok: false, error: `닫히지 않은 따옴표(${quote})` }
  if (inToken) tokens.push(cur)
  return { ok: true, tokens }
}

/** 맨 앞의 `NAME=value` 낱말은 env 로(Orca extractLeadingEnvAssignments — 셸 식이 아니라 데이터). */
export function extractLeadingEnvAssignments(tokens: readonly string[]): { env?: Record<string, string>; rest: string[] } {
  const env = new Map<string, string>()
  let i = 0
  for (; i < tokens.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(tokens[i])
    if (!m) break
    env.delete(m[1])
    env.set(m[1], tokens[i].slice(m[0].length))
  }
  return { ...(env.size ? { env: Object.fromEntries(env) } : {}), rest: tokens.slice(i) }
}

/** Orca parseAgentCommand — 명령 바꾸기 칸 → 실행 파일·접두 인자·env. 빈 칸이면 기본 이름. */
export function parseAgentCommand(
  defaultBinary: string,
  override: string | undefined,
  backslash: 'escape' | 'literal' = 'escape'
): { ok: true; binary: string; prefixArgs: string[]; env?: Record<string, string> } | { ok: false; error: string } {
  const command = override?.trim()
  if (!command) return { ok: true, binary: defaultBinary, prefixArgs: [] }
  const t = tokenizeArgs(command, backslash)
  if (!t.ok) return { ok: false, error: `실행 명령이 올바르지 않습니다: ${t.error}` }
  const { env, rest } = extractLeadingEnvAssignments(t.tokens)
  const [binary, ...prefixArgs] = rest
  if (!binary) return { ok: false, error: '실행 명령은 실행 파일 이름으로 시작해야 합니다.' }
  return { ok: true, binary, prefixArgs, ...(env ? { env } : {}) }
}

// ── 판·PATH(AI-01) ─────────────────────────────────────────────────────────────

/** Orca parseCliVersion — `--version` 출력에서 첫 semver(앞 v·prerelease·build 포함). */
export function parseCliVersion(output: string | null | undefined): string | null {
  return output?.match(/(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![\w.+-])/)?.[1] ?? null
}

/** `where`/`which` 출력의 첫 경로. Windows 는 확장자 없는 npm 셔임(sh 스크립트)보다 실행 가능한 것(.exe·.cmd)을 앞에. */
export function firstCommandPath(stdout: string, win: boolean): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!win) return lines[0] ?? null
  return lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) ?? lines[0] ?? null
}

/** 로그인 셸 PATH 를 읽을 때 앞뒤에 찍는 표식(Orca shell-path-probe — rc 파일의 배너·색을 피한다). */
export const SHELL_PATH_MARK = '__ARA_SHELL_PATH__'

/** 표식 사이 값 → PATH 조각(순서 유지·중복 제거). 표식이 둘 다 없으면 빈 목록. */
export function parseShellPath(stdout: string, delimiter: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const a = clean.indexOf(SHELL_PATH_MARK)
  const b = a < 0 ? -1 : clean.indexOf(SHELL_PATH_MARK, a + SHELL_PATH_MARK.length)
  if (b < 0) return []
  const value = clean.slice(a + SHELL_PATH_MARK.length, b).trim()
  return [...new Set(value.split(delimiter).map((s) => s.trim()).filter(Boolean))]
}

/** 지금 PATH 에 없는 조각만 뒤에 붙인다(앱이 원래 쓰던 것이 먼저 — Orca mergePathSegments). Windows 는 대소문자 무시. */
export function mergePathSegments(current: string, segments: readonly string[], delimiter: string, win: boolean): string {
  const key = (s: string): string => (win ? s.toLowerCase().replace(/[\\/]+$/, '') : s.replace(/\/+$/, ''))
  const have = new Set(current.split(delimiter).filter(Boolean).map(key))
  const add = segments.filter((s) => !have.has(key(s)))
  return [current, ...add].filter(Boolean).join(delimiter)
}

export type DetectedAgent = { id: AgentId; installed: boolean; path: string | null; version: string | null }

// ── 실행 계획(AI-03) ─────────────────────────────────────────────────────────────

/** 첫 지시를 싣는 env 이름. 지시 글은 **명령줄에 끼우지 않는다** — 셸이 그 글을 코드로 읽을 길이 없게. */
export const PROMPT_ENV = 'ARA_AGENT_PROMPT'

export type LaunchPlan =
  | {
      ok: true
      /** 셸에 칠 한 줄(지시 글은 env 참조로만 들어간다 — 화면 미리보기도 이 값). */
      line: string
      /** 에이전트 탭 셸의 env(사용자 env + 명령 바꾸기 env + 지시 글). */
      env: Record<string, string>
      /** 사용자 인자에 권한 플래그가 있어 권한 모드 플래그를 붙이지 않았다. */
      permissionShadowed: boolean
      /** Windows 셸: 첫 지시를 줄에 싣지 않고 에이전트 입력 상자가 뜬 뒤 입력으로 넣는다(main/agents/status.ts). */
      deferredPrompt?: string
    }
  | { ok: false; error: string }

const SAFE_POSIX = /^[A-Za-z0-9@%._/:+=,-]+$/
// PowerShell: 맨 앞 `@`(스플랫)·`--`(5.1 이 네이티브 명령에 안 넘긴다)는 인용한다.
const SAFE_PWSH = /^[A-Za-z0-9._/:+=,\\-][A-Za-z0-9@._/:+=,\\-]*$/
const SAFE_CMD = /^[A-Za-z0-9@._/:+=,\\-]+$/

/** 그 셸에서 낱말 하나가 그대로 도착하게. cmd 는 `"`·`%`·`!`·개행을 안전하게 담을 수 없어 null(거절). */
export function quoteArg(arg: string, shell: LaunchShell): string | null {
  if (/[\r\n\0]/.test(arg)) return null
  if (shell === 'posix') return arg !== '' && SAFE_POSIX.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
  if (shell === 'powershell') return arg !== '' && arg !== '--' && SAFE_PWSH.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`
  if (/["%!]/.test(arg)) return null
  return arg !== '' && SAFE_CMD.test(arg) ? arg : `"${arg}"`
}

/**
 * 에이전트 실행 한 줄(Orca planAgentPaneLaunch 의 핵심만). 순서: 실행 파일 · 접두 인자 · 권한 플래그 · `--rc` · 사용자 인자 · 첫 지시.
 * 첫 지시:
 *   posix — env(`ARA_AGENT_PROMPT`)로 싣고 줄에는 참조 `"$ARA_AGENT_PROMPT"` 만(셸이 줄을 읽은 뒤에 값을 펴므로 `& ; $ "` 가 명령이 안 된다).
 *   powershell·cmd — **줄에 싣지 않는다**(`deferredPrompt`). 5.1 은 네이티브 인자 속 `"` 를 이스케이프하지 않고, npm `.cmd` 셔임은
 *   `%*` 로 다시 읽어 `&`·`%`·줄바꿈이 깨진다(M3 R1 한계). 에이전트 입력 상자가 뜬 뒤 입력으로 넣는다(Orca stdin-after-start).
 */
export function planAgentLaunch(o: {
  agent: AgentId
  settings: AgentSettings
  prompt?: string
  shell: LaunchShell
  /** M4 AI-07 지난 세션 재개 — 세션 id. 있으면 Orca buildAiVaultResumeCommand 처럼 실행 명령(바꾼 것 포함) + 재개 인자만(권한·사용자 인자·첫 지시 없음). */
  resume?: string
}): LaunchPlan {
  const spec = AGENTS[o.agent]
  const prefs = o.settings.agents[o.agent]
  const backslash = o.shell === 'posix' ? 'escape' : 'literal'
  const cmd = parseAgentCommand(spec.bin, prefs.command, backslash)
  if (!cmd.ok) return cmd
  const user = tokenizeArgs(prefs.args, backslash)
  if (!user.ok) return { ok: false, error: `인자가 올바르지 않습니다: ${user.error}` }
  const permissionShadowed = user.tokens.some((t) => spec.permissionFlags.includes(t.split('=')[0]))
  const perm = prefs.permission === 'own' || permissionShadowed ? '' : (spec.permissionArgs[prefs.permission] ?? '')
  const rc = o.agent === 'claude' && o.settings.claudeRemoteControl ? ['--rc'] : []
  const args = o.resume ? [...cmd.prefixArgs, ...resumeArgs(o.agent, o.resume)] : [...cmd.prefixArgs, ...(perm ? perm.split(' ') : []), ...rc, ...user.tokens]

  const quoted: string[] = []
  for (const a of [cmd.binary, ...args]) {
    const q = quoteArg(a, o.shell)
    if (q === null) return { ok: false, error: `이 셸(${o.shell})에 담을 수 없는 글자가 든 인자: ${a}` }
    quoted.push(q)
  }
  const prompt = !o.resume && o.prompt?.trim() ? o.prompt : ''
  const argv = o.shell === 'posix' ? prompt : ''
  const ref = `"$${PROMPT_ENV}"`
  if (argv) quoted.push(...(spec.prompt === 'flag-prompt-interactive' ? ['--prompt-interactive', ref] : [ref]))

  const body = quoted.join(' ')
  const line = o.shell === 'powershell' ? `& ${body}` : body
  const env = { ...prefs.env, ...cmd.env, ...(argv ? { [PROMPT_ENV]: argv } : {}) }
  return { ok: true, line, env, permissionShadowed, ...(prompt && !argv ? { deferredPrompt: prompt } : {}) }
}

/** 재개 인자(Orca ai-vault-resume-command buildAgentResumeInvocation): codex 는 하위 명령, claude·gemini 는 `--resume`. */
export function resumeArgs(agent: AgentId, sessionId: string): string[] {
  return agent === 'codex' ? ['resume', sessionId] : ['--resume', sessionId]
}
