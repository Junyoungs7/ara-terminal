// M8 DM-02·03 관리형 서버(orcad) — main·렌더러가 같이 쓰는 순수 규칙: 원격 명령 글, 그 출력 읽기, 동의·업데이트·제거 검증 판정.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/managed-server/{install/orcad-remote-host-support,lifecycle/orcad-managed-update-decision,
// install/orcad-remote-decommission}.ts — 핵심만(판정 규칙). Orca 의 Node 런타임 배포·활성화 트랜잭션·롤백·GC 는 뺐다(아래 host.ts 머리 주석).
//
// 원칙(m8-r1 지시서): 터미널 공간은 서버에 아무것도 깔지 않는다. orcad 는 AI 공간에서 **호스트별 동의를 받은 서버에만**,
// 사용자 홈 아래 한 폴더에, 사용자 권한으로만(root·sudo·systemd·crontab 없음). 제거하면 흔적 0 — 그것을 원격에서 재서 확인한다.
import { applyHookEvent, isHookSource, launchHooks, type HookSource } from './agentHooks'
import { GEMINI_DEFAULTS_ENV } from './oriel'

/** 설치 폴더 — 원격 사용자 홈 아래 이 이름 하나. SFTP 는 홈 기준 상대 경로, exec 은 "$HOME/…". */
export const MANAGED_DIR = '.ara-server'
/** orcad.py 가 쓰는 최소 파이썬(selectors·os.set_blocking·subprocess.DEVNULL — RHEL 7 의 3.6 까지). */
export const MANAGED_MIN_PYTHON: readonly [number, number] = [3, 6]
/** 원격에서 무엇이든 표시할 때 쓰는 홈 표기. */
export const managedDirShown = `~/${MANAGED_DIR}`

/** 설치하는 파일(동의 화면에 그대로 보인다). orcad.py 크기는 부르는 쪽이 채운다. */
export const MANAGED_FILES = ['orcad.py', 'token', 'version', 'claude-hooks.json', 'gemini-hooks.json'] as const
/** 돌 때만 생기는 파일(모두 설치 폴더 안 — 제거하면 함께 사라진다). agent.sock 은 SSH agent 포워딩을 켠 연결의 에이전트를 가리키는 링크(M15 R2 TM-05). */
export const MANAGED_RUNTIME_FILES = ['orcad.sock', 'orcad.pid', 'orcad.log', 'agent.sock'] as const
/** 원격 프로세스에 붙는 표식(환경 변수) — 제거 검증이 이것으로 "아라가 띄운 것"을 센다. orcad.py 의 MARK 와 같아야 한다. */
export const MANAGED_MARK = 'ARA_ORCAD_HOME'

// ── R2 서버에서 상태 판정 ── 원격 에이전트 실행에만 주는 훅 설정(설치 폴더 안 파일 — 서버 ~/.claude·~/.gemini 는 안 건드린다).
// 훅 명령은 orcad.py hook <cli> — orcad 가 받아 status 사건으로 붙은 PC 모두에 보낸다. 로컬 M9 R3 과 같은 이벤트 목록(launchHooks).
export const remoteHookCommand = (source: HookSource): string => `python3 "$HOME/${MANAGED_DIR}/orcad.py" hook ${source}`
export const remoteHookFileName = (source: HookSource): 'claude-hooks.json' | 'gemini-hooks.json' => `${source}-hooks.json`
export const remoteHookFile = (source: HookSource): string => JSON.stringify(launchHooks(source, remoteHookCommand(source)), null, 2)
/**
 * 원격 실행에 붙일 것. hookDir = orcad hello 의 설치 폴더(절대 경로 — 옛 orcad 는 안 준다 → 훅 없이 화면 판정 '추정'만).
 * Claude 는 `--settings <파일>`, Gemini 는 시스템 기본값 파일 env(로컬과 같은 방식 — 서버에 시스템 기본값 파일이 따로 있으면 이 실행에서는 우리 것이 대신한다).
 */
export function remoteHookLaunch(agent: string, hookDir: string | null): { extraArgs?: string[]; extraEnv?: Record<string, string> } {
  if (!hookDir || !isHookSource(agent)) return {}
  const file = `${hookDir}/${remoteHookFileName(agent)}`
  return agent === 'claude' ? { extraArgs: ['--settings', file] } : { extraEnv: { [GEMINI_DEFAULTS_ENV]: file } }
}
/** 서버 대장의 마지막 상태(orcad list·attach) → 목록 칸(기존 글리프). 모르면 null. */
export type ServerSessionState = 'working' | 'blocked' | 'question' | 'idle'
export function serverStateOf(status: unknown): ServerSessionState | null {
  if (!status || typeof status !== 'object') return null
  const { source, payload } = status as { source?: unknown; payload?: unknown }
  if (typeof source !== 'string' || !isHookSource(source) || !payload || typeof payload !== 'object') return null
  const p = applyHookEvent(null, source, payload as Record<string, unknown>, 0)
  if (!p) return null
  return p.state === 'blocked' ? (p.kind === 'question' ? 'question' : 'blocked') : p.state === 'working' ? 'working' : 'idle'
}

// ── R3 서버 계정 ── 설치 폴더 안 accounts/<id>/ 하나가 CLI 로그인 하나(CLAUDE_CONFIG_DIR·CODEX_HOME, 700). Claude 대화 기록은 claude-shared/ 로 링크.
export const ACCOUNTS_DIR = 'accounts'
export const SHARED_DIR = 'claude-shared'
/** 로그인하면 생기는 자격 증명 파일(Linux 는 키체인이 없어 계정 폴더에 파일로). orcad.py LOGIN_FILE 과 같아야 한다. */
export const CREDENTIAL_FILES = ['.credentials.json', 'auth.json'] as const
export const SERVER_ACCOUNT_AGENTS = ['claude', 'codex'] as const
export type ServerAccountAgent = (typeof SERVER_ACCOUNT_AGENTS)[number]
export const isServerAccountAgent = (v: unknown): v is ServerAccountAgent => v === 'claude' || v === 'codex'
export type ServerAccount = { id: string; agent: ServerAccountAgent; label: string; loggedIn: boolean; email: string | null; createdAt: number | null }
export type ServerAccounts = { accounts: ServerAccount[]; default: string | null }
/** 서버에서 로그인 — 계정 env 는 orcad 가 붙인다. 끝나면 셸도 닫아 로그인 칸이 저절로 내려가게. Codex 는 서버에 브라우저 콜백이 안 닿아 기기 코드 방식. */
export const accountLoginLine = (agent: ServerAccountAgent): string => `${agent === 'claude' ? 'claude auth login' : 'codex login --device-auth'}; exit`
/** 로그인 칸 세션 표식(meta.kind) — 서버 세션 목록·되살릴 탭에서 뺀다. */
export const LOGIN_SESSION_KIND = 'login'

/** orcad 의 account 답 → 목록(모르는 모양은 거른다). */
export function serverAccountsOf(v: unknown): ServerAccounts {
  const o = (v && typeof v === 'object' ? v : {}) as { accounts?: unknown; default?: unknown }
  const accounts = (Array.isArray(o.accounts) ? o.accounts : []).flatMap((a): ServerAccount[] => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    if (typeof x['id'] !== 'string' || !isServerAccountAgent(x['agent'])) return []
    return [{ id: x['id'], agent: x['agent'], label: typeof x['label'] === 'string' && x['label'] ? x['label'] : x['id'], loggedIn: x['loggedIn'] === true, email: typeof x['email'] === 'string' ? x['email'] : null, createdAt: typeof x['createdAt'] === 'number' ? x['createdAt'] : null }]
  })
  const def = typeof o.default === 'string' && accounts.some((a) => a.id === o.default) ? o.default : null
  return { accounts, default: def }
}

/** orcad 가 돌려준 실패(영어 한 단어) → 이유 + 할 일 한 줄. 모르는 것은 그대로. */
export function accountErrorText(e: string): string {
  if (/unknown request/.test(e)) return '이 서버의 아라 서버가 옛 판입니다 — 서버에서 도는 에이전트가 모두 끝난 뒤 다시 열면 새 판으로 바뀝니다.'
  if (/account in use/.test(e)) return '이 계정으로 도는 원격 탭이 있습니다 — 그 탭을 서버에서 끝낸 뒤 지워 주세요.'
  if (/no such account/.test(e)) return '서버에 그 계정이 없습니다 — 다른 PC 에서 지웠을 수 있습니다. 목록을 새로 고쳐 주세요.'
  return e
}

// ── 원격 명령 ── 모두 `sh -c '<글>'` 로 보낸다(로그인 셸이 fish·csh 여도 같은 문법). 사용자 값은 끼우지 않는다 — 고정 글뿐.
const D = `D="$HOME/${MANAGED_DIR}"`
/** R5 상주 끄기 표식 — 설치 폴더 안 파일 하나(orcad.py RESIDENT_OFF 와 같아야 한다). 없으면 상주(기본). */
export const RESIDENT_OFF = 'resident-off'

/** 플랫폼·파이썬·설치된 판 묻기. 출력은 key=value 줄(parseProbe). */
export const PROBE_SCRIPT = [
  `printf 'os=%s\\narch=%s\\nhome=%s\\n' "$(uname -s)" "$(uname -m)" "$HOME"`,
  `P=$(command -v python3 2>/dev/null)`,
  `printf 'python=%s\\n' "$P"`,
  // 판을 먼저 찍고, 필요한 모듈을 불러 본다(못 부르면 pymods 줄이 없다 → 지원 안 함).
  `[ -n "$P" ] && "$P" -c 'import sys;print("pyver=%d.%d"%sys.version_info[:2]);import pty,termios,fcntl,selectors;print("pymods=1")' 2>/dev/null`,
  D,
  // R1 채택 화면: 돌고 있나(소켓이 있다) — 있을 때만 세션을 센다(세려고 서버를 띄우지 않게).
  `[ -S "$D/orcad.sock" ] && echo running=1`,
  // R5 상주(기본 켜짐) — 끈 서버에만 이 파일이 있다.
  `[ -f "$D/${RESIDENT_OFF}" ] && echo resident=0`,
  `[ -f "$D/version" ] && printf 'installed=%s\\n' "$(cat "$D/version")"`,
  `true`
].join('\n')

/** R5 서버별 상주 켜고 끄기 — 파일만 만들거나 지운다(서버를 띄우지 않는다). 끄면 서버는 다음 idle 에 스스로 끝난다. */
export const residentScript = (on: boolean): string => (on ? `${D}; rm -f "$D/${RESIDENT_OFF}"` : `${D}; [ -d "$D" ] && : > "$D/${RESIDENT_OFF}"`)

/** 설치 폴더 만들기(본인만 읽고 쓰게 700). */
export const MKDIR_SCRIPT = `${D}; mkdir -p "$D" && chmod 700 "$D"`
/** 파일을 올린 뒤 권한·자가 시험. 마지막 줄이 protocol=N 이면 됐다. */
export const FINISH_SCRIPT = `${D}; chmod 600 "$D/token" "$D/version" && chmod 700 "$D/orcad.py" && python3 "$D/orcad.py" version`
/** R1 업데이트 직전: 세션이 0 일 때 옛 서버를 내린다 — 다른 PC 가 연결만 붙여 둔 옛 서버가 새 토큰을 거절하지 않게. */
export const STOP_SCRIPT = `${D}; [ -f "$D/orcad.py" ] && python3 "$D/orcad.py" stop; true`
/** 아라 쪽 연결 다리(stdin/stdout ↔ 원격 유닉스 소켓). 데몬이 없으면 띄운다. */
export const BRIDGE_SCRIPT = `exec python3 "$HOME/${MANAGED_DIR}/orcad.py" connect`

/**
 * 남은 것 재기. 아라가 띄운 프로세스 = 환경에 표식이 있거나 명령줄에 설치 경로의 orcad.py 가 든 것($$ — 이 셸 — 는 뺀다).
 * crontab·systemd 는 애초에 쓰지 않지만, "흔적 0"을 말하려면 재야 한다(부재는 양성 대조가 필요하다 — 시험이 그것을 한다).
 */
export const VERIFY_SCRIPT = [
  D,
  `[ -e "$D" ] && echo dir=yes || echo dir=no`,
  `n=0; for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue;`,
  `  if tr '\\000' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "${MANAGED_MARK}=$D" || tr '\\000' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "$D/orcad.py"; then n=$((n+1)); fi`,
  `done; echo proc=$n`,
  `echo cron=$(crontab -l 2>/dev/null | grep -c "${MANAGED_DIR}")`,
  // R3 서버 계정: 계정 폴더 수 · 로그인 자격 증명 파일 수(설치 폴더 안 — 지우면 0. 서버의 ~/.claude 는 세지 않는다 — 아라 것이 아니다).
  `echo accounts=$(ls -A "$D/${ACCOUNTS_DIR}" 2>/dev/null | grep -vxFc .default)`,
  `echo creds=$(find "$D" -name ${CREDENTIAL_FILES.join(' -o -name ')} 2>/dev/null | wc -l)`,
  `echo systemd=$(ls "$HOME/.config/systemd/user" 2>/dev/null | grep -ci ara-)`
].join('\n')

/**
 * 제거: 데몬을 끄고(SIGTERM → 데몬이 세션을 끝낸다 → 기다림 → 안 끝나면 KILL), 표식 달린 남은 프로세스를 끝내고, 폴더를 지운다. 이어서 VERIFY.
 * 표식은 orcad 가 띄운 셸·에이전트에게만 물려진다 — 사용자가 따로 띄운 프로세스는 건드리지 않는다.
 */
export const UNINSTALL_SCRIPT = [
  D,
  `if [ -f "$D/orcad.pid" ]; then P=$(cat "$D/orcad.pid"); kill -TERM "$P" 2>/dev/null; i=0; while kill -0 "$P" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "$P" 2>/dev/null; fi`,
  // 다른 PC 의 아라가 열어 둔 다리(orcad.py connect)도 — 명령줄에 설치 경로가 든다.
  `for p in /proc/[0-9]*; do q=\${p#/proc/}; [ "$q" = "$$" ] && continue; if tr '\\000' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "${MANAGED_MARK}=$D" || tr '\\000' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "$D/orcad.py"; then kill -KILL "$q" 2>/dev/null; fi; done`,
  `rm -rf "$D"`,
  VERIFY_SCRIPT
].join('\n')

/** 동의 화면에 보여 주는 "직접 지우는 법"(앱이 없을 때). */
export const MANUAL_REMOVE = `kill $(cat ~/${MANAGED_DIR}/orcad.pid) 2>/dev/null; rm -rf ~/${MANAGED_DIR}`

// ── 출력 읽기 ──
const kv = (out: string): Map<string, string> => {
  const m = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return m
}

export type ManagedProbe = { os: string; arch: string; home: string; python: string; pyver: string; pymods: boolean; installed: string | null; running?: boolean; resident?: boolean }

export function parseProbe(out: string): ManagedProbe {
  const m = kv(out)
  return { os: m.get('os') ?? '', arch: m.get('arch') ?? '', home: m.get('home') ?? '', python: m.get('python') ?? '', pyver: m.get('pyver') ?? '', pymods: m.get('pymods') === '1', installed: m.get('installed') || null, running: m.get('running') === '1', resident: m.get('resident') !== '0' }
}

/** 지원 판정. Linux 만(사내 서버 — x64 우선, 스크립트라 arm64 도 돈다). 나머지는 "지원 안 함"을 이유와 함께. */
export type ManagedSupport = { ok: true } | { ok: false; reason: 'os' | 'python' | 'pythonOld' | 'pythonModules' }

export function supportOf(p: ManagedProbe): ManagedSupport {
  if (p.os !== 'Linux') return { ok: false, reason: 'os' }
  if (!p.python) return { ok: false, reason: 'python' }
  const [maj, min] = p.pyver.split('.').map(Number)
  if (!(maj > MANAGED_MIN_PYTHON[0] || (maj === MANAGED_MIN_PYTHON[0] && min >= MANAGED_MIN_PYTHON[1]))) return { ok: false, reason: 'pythonOld' }
  if (!p.pymods) return { ok: false, reason: 'pythonModules' }
  return { ok: true }
}

// ── 판 비교·업데이트 판정(Orca planManagedOrcadAutoUpdate 의 핵심: 같으면 그대로, 낮추지 않는다) ──
/** 점으로 나눈 숫자 비교(앞 숫자만 — `2.11.0-beta` 의 꼬리는 무시). */
export function versionCmp(a: string, b: string): number {
  const n = (v: string): number[] => v.split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
  const x = n(a)
  const y = n(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * - `install`: 동의했는데 설치가 없다(처음·사용자가 손으로 지움).
 * - `current`: 같은 판.
 * - `keepNewer`: 서버 쪽이 더 새 판(다른 PC 의 새 아라가 깔았다) — 낮추지 않는다(Orca refuseOrcadHostDowngrade). 말(protocol)은 같아 그대로 쓴다.
 * - `defer`: 바꿔야 하지만 돌고 있는 에이전트가 있다 — 끝난 뒤 다음 연결 때.
 * - `update`: 바꾼다.
 */
export type ManagedUpdateDecision = 'install' | 'current' | 'keepNewer' | 'defer' | 'update'

export function decideUpdate(o: { installed: string | null; app: string; liveSessions: number }): ManagedUpdateDecision {
  if (!o.installed) return 'install'
  const c = versionCmp(o.installed, o.app)
  if (c === 0) return 'current'
  if (c > 0) return 'keepNewer'
  return o.liveSessions > 0 ? 'defer' : 'update'
}

// ── R6 연결 견고성 ──
/**
 * 서버의 통신 판(hello protocol)이 이 PC 와 다르면 이유 + 할 일 한 줄. 같으면 null.
 * 서버가 옛 판이면 세션이 끝난 뒤 저절로 오르고(decideUpdate), 새 판이면 이 PC 의 아라를 올려야 한다.
 */
export function protocolErrorText(server: number, app: number): string | null {
  if (server === app) return null
  return server < app
    ? '서버의 아라 부품이 옛 판이라 붙지 못했습니다 — 서버에서 도는 에이전트가 모두 끝나면 새 판으로 바뀝니다. 그 뒤 다시 연결해 주세요.'
    : '서버의 아라 부품이 이 PC 의 아라보다 새 판이라 붙지 못했습니다 — 이 PC 의 아라를 업데이트한 뒤 다시 연결해 주세요.'
}

/**
 * R5 재부팅으로 잃은 탭 — 저장한 탭 중 서버 목록에 없고, 만들 때 본 부팅 id 가 지금 서버의 것과 다른 것.
 * 부팅 id 를 모르면(옛 서버) 가르지 않는다(그냥 끝난 것으로).
 */
export function lostToReboot(saved: readonly { id: string; boot?: string | null }[], live: readonly string[], boot: string | null | undefined): string[] {
  if (!boot) return []
  return saved.filter((x) => !live.includes(x.id) && !!x.boot && x.boot !== boot).map((x) => x.id)
}

/** R6 자동 다시 연결 간격(초) — 이만큼 실패하면 멈추고 [다시 연결]만 남긴다(목업 3-link A "자동 재시도 멈춤(5회 실패)"). */
export const RELINK_DELAYS_S = [2, 4, 8, 16, 30] as const
/** R6 "다른 PC 입력 중" 표시가 마지막 입력 뒤 남아 있는 시간. */
export const TYPING_SHOW_MS = 3000

// ── 제거 검증 ──
/** 남은 것 이름: dir(설치 폴더) · proc:N(프로세스 수) · cron:N · systemd:N · accounts:N(서버 계정)·creds:N(자격 증명 파일) · unknown:<키>(못 잼 — 없다고 말하지 않는다). */
export function remnantsOf(out: string): string[] {
  const m = kv(out)
  const left: string[] = []
  const dir = m.get('dir')
  if (dir === undefined) left.push('unknown:dir')
  else if (dir !== 'no') left.push('dir')
  for (const k of ['proc', 'cron', 'systemd', 'accounts', 'creds'] as const) {
    const v = m.get(k)
    const n = v === undefined || v === '' ? NaN : Number(v)
    if (!Number.isFinite(n)) left.push(`unknown:${k}`)
    else if (n > 0) left.push(`${k}:${n}`)
  }
  return left
}

// ── 동의 기록 ──
/** 호스트 열쇠 — 같은 서버라도 다른 계정이면 다른 홈이라 따로 동의한다. */
export const hostKeyOf = (p: { username: string; host: string; port: number }): string => `${p.username}@${p.host}:${p.port}`

export type ManagedState = 'installed' | 'deferred' | 'failed' | 'missing'
export type ManagedRecord = {
  hostKey: string
  /** 동의한 때(ISO). 기록이 있다 = 동의했다. 철회 = 제거(기록도 지운다). */
  consentedAt: string
  /** 서버에 깔린 판(마지막으로 본 것). */
  version: string | null
  state: ManagedState
  checkedAt: string
  /** 실패·미룸 사유(사람이 읽는 글). */
  note?: string
  /** R5 상주 모드(마지막으로 본 것 — 없으면 기본 켜짐). */
  resident?: boolean
}

export type ManagedConsent = 'none' | 'consented'
export const consentOf = (records: readonly ManagedRecord[], hostKey: string): ManagedConsent => (records.some((r) => r.hostKey === hostKey) ? 'consented' : 'none')

/** 동의 화면 내용 — 무엇을(파일·크기), 어디에(폴더), 무엇이 상주(프로세스·소켓), 지우는 법. */
export type ManagedConsentPlan = {
  hostKey: string
  support: ManagedSupport
  probe: ManagedProbe
  dir: string
  files: { path: string; bytes: number }[]
  runtimeFiles: string[]
  /** 상주 프로세스 명령줄(사람이 ps 로 볼 모양). */
  process: string
  socket: string
  manualRemove: string
  /** R1 이 PC 의 판(채택 화면이 서버 판과 비교). */
  app?: string
  /** R1 이미 설치된 서버에 살아 있는 세션 수(서버가 안 돌면 0). */
  sessions?: number
}

/**
 * R1 이미 설치된 서버 채택 — 서버 판과 이 PC 판 비교.
 * same: 그대로 · older: 서버가 옛 판(세션이 없으면 올리고, 있으면 그 판으로 쓰다가 끝난 뒤 올린다) · newer: 서버가 새 판(낮추지 않고 그대로).
 */
export type AdoptKind = 'same' | 'older' | 'newer'
export const adoptKindOf = (installed: string, app: string): AdoptKind => {
  const c = versionCmp(installed, app)
  return c === 0 ? 'same' : c < 0 ? 'older' : 'newer'
}

// ── R1 서버 세션 목록(다른 PC 에서 이어 보기) ──
export type ServerSessionRow = {
  id: string
  hostKey: string
  cwd: string
  title: string
  agent: string
  /** 만든 PC(옛 세션은 모름). */
  pc: string | null
  startedAt: number | null
  /** 지금 붙은 PC 이름들(이 PC 포함). */
  viewers: string[]
  /** 이 PC 에 탭으로 열려 있다. */
  here: boolean
  /** R2 서버가 훅으로 들은 마지막 상태(null = 모름 — 옛 서버·훅 없는 에이전트). */
  state: ServerSessionState | null
}
export type ServerSessionsHost = { hostKey: string; label: string; version: string | null; ok: boolean; error?: string; sessions: ServerSessionRow[] }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** 서버 list 결과 → 목록 줄(최근 시작이 위). 제목은 이름 > 첫 지시 제목 > 실행 제목 순(탭 제목과 같은 순서). */
export function serverRowsOf(hostKey: string, infos: readonly { id: string; cwd: string; meta: Record<string, unknown>; viewers?: string[]; status?: unknown }[], here: (id: string) => boolean): ServerSessionRow[] {
  return infos
    .filter((x) => x.meta['kind'] !== LOGIN_SESSION_KIND)
    .map((x) => ({
      id: x.id,
      hostKey,
      cwd: x.cwd,
      title: str(x.meta['name']) ?? str(x.meta['genTitle']) ?? str(x.meta['title']) ?? x.id,
      agent: str(x.meta['agent']) ?? '',
      pc: str(x.meta['pc']),
      startedAt: typeof x.meta['startedAt'] === 'number' ? x.meta['startedAt'] : null,
      viewers: Array.isArray(x.viewers) ? x.viewers.filter((v): v is string => typeof v === 'string') : [],
      here: here(x.id),
      state: serverStateOf(x.status)
    }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

export function consentPlan(hostKey: string, probe: ManagedProbe, scriptBytes: number, tokenBytes: number, versionBytes: number, extra: { app?: string; sessions?: number } = {}): ManagedConsentPlan {
  const dir = probe.home ? `${probe.home}/${MANAGED_DIR}` : managedDirShown
  const size = (s: string): number => new TextEncoder().encode(s).length
  const bytes = { 'orcad.py': scriptBytes, token: tokenBytes, version: versionBytes, 'claude-hooks.json': size(remoteHookFile('claude')), 'gemini-hooks.json': size(remoteHookFile('gemini')) }
  return {
    hostKey,
    support: supportOf(probe),
    probe,
    dir,
    files: MANAGED_FILES.map((f) => ({ path: `${dir}/${f}`, bytes: bytes[f] })),
    runtimeFiles: MANAGED_RUNTIME_FILES.map((f) => `${dir}/${f}`),
    process: `python3 ${dir}/orcad.py serve`,
    socket: `${dir}/orcad.sock`,
    manualRemove: MANUAL_REMOVE,
    ...extra
  }
}
