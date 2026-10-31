// F27 AI CLI 한 번에 시작 — 그 CLI 를 **무엇으로 띄울지 정하는 유일한 자리.**
//
// 길은 하나다: 이미 열린 셸에 **밀어 넣을 한 줄**(buildLaunch) — 사용자가 직접 치는 것과 같은 채널.
// (D · #168 의 "새 세션의 프로세스로 띄우기" 길은 2026-10-12 에 되돌렸고 M0 0-10 에서 지웠다.)
//
// 왜 여기 한 곳인가(remoteCatalog.ts 와 같은 이유, 성격은 다르다):
// F26 의 `remote:*` 는 exec 채널이라 렌더러가 명령 문자열을 넘길 수 없게 id 만 받는다. 이쪽은
// `session.input` — 사람이 키보드로 치는 것과 **같은 채널**이라 그런 봉쇄가 성립하지 않는다
// (사용자는 어차피 아무 명령이나 칠 수 있다). 그래서 여기서 막는 것은 "임의 실행"이 아니라
// **조립 규칙이 화면마다 갈리는 것**이다. 진입점이 넷이라 각자 문자열을 만들면 어느 화면은
// 인용을 빠뜨리고, 어느 화면은 다른 플래그를 붙인다.
//
// 그리고 이 파일에는 계약이 하나 더 있다: 화면의 "보낼 명령" 줄과 실제 전송 문자열은 **같은 함수의
// 같은 반환값**이다. `--dangerously-skip-permissions` 는 권한 확인을 끄는 플래그라, 무엇이 실행되는지
// 감추면 안 된다.
//
// 검증 실패는 예외가 아니라 null 이다 — 던진 예외는 위쪽 try/catch 에 삼켜져 "조용히 아무 일도
// 안 일어남"이 되기 쉽지만, null 은 호출측이 반드시 분기해야 한다(타입이 강제한다).

export type AiCliId = 'claude' | 'codex' | 'gemini' | 'custom'

/** 드롭다운 순서. Record 의 키 순서에 기대지 않는다. */
export const AI_CLI_IDS: readonly AiCliId[] = ['claude', 'codex', 'gemini', 'custom']

/**
 * 저장값 → 이 표에 있는 CLI 인가. 없으면 null.
 *
 * `Session.aiCli`(스냅샷에 실린다)는 손으로 고칠 수 있는 파일에서 돌아온다 — 모르는 이름이
 * `AI_CLIS[cli]` 로 들어가면 `undefined.bin` 이라 화면이 통째로 죽는다. 읽는 쪽에서 한 번 거른다
 * (uiScaleOf·aiCliFlagsOf 와 같은 규칙: 저장값은 신뢰 경계 밖이다).
 */
export function aiCliOf(v: unknown): AiCliId | null {
  return AI_CLI_IDS.includes(v as AiCliId) ? (v as AiCliId) : null
}

export type AiCliFlag = {
  id: string
  /** 실제로 명령줄에 붙는 인자. 화면은 id 만 다루고 이 값을 만지지 않는다. */
  arg: string
  labelKey: string
  default: boolean
  /** 같은 그룹의 플래그는 동시에 켤 수 없다(claude 의 -r 과 -c). */
  group?: string
}

export type AiCliSpec = { bin: string; flags: readonly AiCliFlag[] }

/**
 * 실행할 수 있는 CLI 표.
 *
 * claude 말고는 플래그를 비워 뒀다 — codex·gemini 에도 비슷한 "확인 건너뛰기"류 옵션이 있지만
 * 이름이 버전마다 다르고, 틀린 플래그를 기본값으로 켜 두면 CLI 가 아예 안 뜬다. 실제로 쓰는 조합이
 * 확인되면 그때 이 표에 한 줄씩 추가한다(화면·검증은 이미 표에서 파생된다).
 */
export const AI_CLIS: Record<AiCliId, AiCliSpec> = {
  claude: {
    bin: 'claude',
    flags: [
      { id: 'skipPerms', arg: '--dangerously-skip-permissions', labelKey: 'aicli.flag.skipPerms', default: true },
      // -r(고르기) 과 -c(직전 이어서) 는 서로 배타다. 둘 다 주면 claude 가 뒤엣것만 보거나 오류를 낸다.
      { id: 'resume', arg: '-r', labelKey: 'aicli.flag.resume', default: true, group: 'session' },
      { id: 'continue', arg: '-c', labelKey: 'aicli.flag.continue', default: false, group: 'session' }
    ]
  },
  /**
   * codex·gemini 도 자기 플래그를 갖는다 (2026-08-23 준영님 제보 — "claude 것만 뜬다").
   *
   * **기본값은 전부 꺼 둔다.** claude 의 `--dangerously-skip-permissions` 는 준영님이 늘 쓰시는
   * 조합이라 켜 뒀지만, 이 둘은 이 저장소에서 실사용으로 확인한 적이 없다. 승인 절차를 건너뛰는
   * 플래그를 **우리가 먼저 켜 두는** 것은 하면 안 되는 일이다 — 한 번 체크하면 그 뒤로 기억한다.
   */
  codex: {
    bin: 'codex',
    flags: [
      // 샌드박스 안에서 스스로 실행. 승인 절차를 완전히 끄는 아래 것과는 배타다.
      { id: 'fullAuto', arg: '--full-auto', labelKey: 'aicli.flag.fullAuto', default: false, group: 'approval' },
      {
        id: 'bypass',
        arg: '--dangerously-bypass-approvals-and-sandbox',
        labelKey: 'aicli.flag.bypass',
        default: false,
        group: 'approval'
      }
    ]
  },
  gemini: {
    bin: 'gemini',
    flags: [
      { id: 'yolo', arg: '--yolo', labelKey: 'aicli.flag.yolo', default: false },
      { id: 'sandbox', arg: '--sandbox', labelKey: 'aicli.flag.sandbox', default: false },
      { id: 'checkpoint', arg: '--checkpointing', labelKey: 'aicli.flag.checkpoint', default: false }
    ]
  },
  // bin 은 사용자가 직접 적는다 — 아래 validCliBin 을 통과한 것만.
  custom: { bin: '', flags: [] }
}

const MAX_PATH = 4096
const MAX_BIN = 64

/**
 * 시작 폴더. 작은따옴표로 감싸 넘기므로 **작은따옴표가 든 경로는 거절**한다
 * (이스케이프로 살리는 것보다 못 쓰는 편이 안전하다 — remoteCatalog.validAbsPath 와 같은 판단).
 * 개행·NUL 도 거절: 한 줄짜리 명령에 줄을 하나 더 끼워 넣는 고전적인 수법이다.
 * 공백은 받는다 — 인용이 그걸 위해 있다.
 */
export function validPath(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const p = v.trim()
  if (p === '' || p.length > MAX_PATH) return null
  // eslint-disable-next-line no-control-regex
  return /['\r\n\x00]/.test(p) ? null : p
}

/**
 * custom CLI 이름(또는 그 경로). 셸 메타문자가 하나라도 있으면 거절한다 —
 * 인용으로 막는 대신 아예 안 받는다(remoteCatalog.validUnit 과 같은 판단: 인용은 한 겹 실수하면 뚫린다).
 * 하이픈은 맨 뒤에 둬야 범위(-)가 아니라 글자로 읽힌다. 백슬래시·공백·따옴표는 일부러 뺐다.
 */
export function validCliBin(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const b = v.trim()
  if (b === '' || b.length > MAX_BIN) return null
  return /^[A-Za-z0-9@._/+-]+$/.test(b) ? b : null
}

/**
 * 어느 셸에 밀어 넣는 한 줄인가(#90, 2026-08-16).
 *
 * 원격은 늘 POSIX 였지만 **로컬은 Windows 라 갈린다.** `PtyBackend.ts` 가 기본 셸을
 * PWSH env → powershell → (스폰 실패 시) cmd 순으로 고르는데, `powershell.exe`(5.1)는 **`&&` 가 파서 오류다** —
 * 명령이 아예 실행되지 않는다. 프롬프트(`PS C:\…>`)만으로는 5.1 인지 7 인지 알 수 없고
 * 기존 ShellKind 도 둘을 구분하지 않으므로, **버전을 알아내려 하지 말고 양쪽에서 다 되는
 * 문법**을 쓴다(`;` + `if ($?)`).
 */
export type LaunchShell = 'posix' | 'powershell' | 'cmd'

/**
 * POSIX 경로 인용. `cd '~/x'` 는 **동작하지 않는다** — 작은따옴표 안에서는 물결표가 홈으로
 * 펼쳐지지 않아 "그런 폴더 없음"이 된다. 앞의 `~/` 만 따옴표 밖에 두고 나머지를 감싼다.
 */
function quotePosix(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) {
    const rest = p.slice(2)
    return rest === '' ? '~/' : `~/'${rest}'`
  }
  return `'${p}'`
}

/**
 * PowerShell 경로 인용. 작은따옴표 안의 작은따옴표는 `''` 로 이스케이프한다 —
 * **POSIX 규칙(`'\''`)을 그대로 쓰면 안 된다.** 다만 validPath 가 작은따옴표를 이미 거절하므로
 * 여기까지 오지 않는다(규칙을 아는 채로 두는 편이 다음 사람에게 안전하다).
 */
function quotePwsh(p: string): string {
  return `'${p.replace(/'/g, "''")}'`
}

/** cmd 경로 인용. 큰따옴표뿐이고 이스케이프 수단이 없다 — validPath 가 걸러 준 값만 온다. */
function quoteCmd(p: string): string {
  return `"${p}"`
}

/**
 * `cd` 와 CLI 를 잇는 한 줄. **폴더가 없으면 거기서 멈춰야 한다** — 이어서 실행하면 CLI 가
 * 엉뚱한 폴더에서 뜨고 사용자는 그 사실을 모른다.
 *   posix      : `cd '<경로>' && <명령>`
 *   powershell : `Set-Location -LiteralPath '<경로>'; if ($?) { <명령> }`
 *                (`if ($?)` 가 `&&` 의 의도를 그대로 지킨다 — 5.1·7 공통.
 *                 `-LiteralPath` 는 대괄호 등 와일드카드 문자가 든 경로에서도 안전하다.)
 *   cmd        : `cd /d "<경로>" && <명령>`
 *                (`/d` 가 없으면 다른 드라이브로 못 넘어간다 — C: 에서 `cd D:\x` 는 아무 일도 안 한다.)
 */
function cdThen(shell: LaunchShell, path: string, cmd: string): string {
  if (shell === 'powershell') return `Set-Location -LiteralPath ${quotePwsh(path)}; if ($?) { ${cmd} }`
  if (shell === 'cmd') return `cd /d ${quoteCmd(path)} && ${cmd}`
  return `cd ${quotePosix(path)} && ${cmd}`
}

/** 이 CLI 에서 처음에 켜져 있는 플래그. */
export function defaultFlags(cli: AiCliId): string[] {
  return AI_CLIS[cli].flags.filter((f) => f.default).map((f) => f.id)
}

/**
 * 설정 [AI] 의 **기본 플래그** — 최근 목록에 아무것도 없을 때 쓸 값 (2026-08-20).
 *
 * 왜 필요한가: 시작 창을 없애면서(2026-08-18) 플래그를 고르는 화면이 사라졌다. 준영님 PC 는
 * 최근 목록에 조합이 남아 있어 티가 안 났지만, **새로 설치한 동료는 맨몸 `claude`** 로 떴다.
 *
 * 저장된 값은 신뢰 경계 밖이다(workspace.json 은 손으로 고칠 수 있다) — 표에 없는 id 는 버린다.
 * `arg` 가 아니라 **id 만** 담는 이유도 같다: 명령줄에 실릴 문자열의 주인은 끝까지 이 표다.
 *
 * **키가 없는 것과 빈 배열은 다르다.** 없으면 카탈로그 기본값(claude 는 skipPerms+resume),
 * 빈 배열이면 "사용자가 전부 껐다"로 읽는다 — 껐는데 다음 실행에 되살아나면 설정이 아니다.
 */
export function aiCliFlagsOf(saved: unknown): Record<AiCliId, string[]> {
  const src = (saved ?? {}) as Partial<Record<string, unknown>>
  const out = {} as Record<AiCliId, string[]>
  for (const cli of AI_CLI_IDS) {
    const v = src[cli]
    if (!Array.isArray(v)) {
      out[cli] = defaultFlags(cli)
      continue
    }
    const known = AI_CLIS[cli].flags.map((f) => f.id)
    // 배타 그룹은 toggleFlag 로 다시 쌓아 한 번 더 거른다 — 손으로 `-r` 과 `-c` 를 같이 적어 둘 수 있다.
    out[cli] = v
      .filter((x): x is string => typeof x === 'string' && known.includes(x))
      .reduce<string[]>((acc, id) => toggleFlag(cli, acc, id), [])
  }
  return out
}

/**
 * 플래그 켜기·끄기. 배타 그룹(-r/-c)은 여기서 한 번만 처리한다 — 화면이 같은 표를 두 번 해석하면
 * 미리보기와 실제 명령이 갈릴 수 있다.
 */
export function toggleFlag(cli: AiCliId, flags: readonly string[], id: string): string[] {
  const spec = AI_CLIS[cli]
  const target = spec.flags.find((f) => f.id === id)
  if (!target) return [...flags]
  if (flags.includes(id)) return flags.filter((x) => x !== id)
  const kept = target.group
    ? flags.filter((x) => spec.flags.find((f) => f.id === x)?.group !== target.group)
    : [...flags]
  return [...kept, id]
}

/** 직전 대화를 이어서 시작하는 플래그의 id. 표에 이 id 를 가진 CLI 만 "이어서"가 성립한다. */
const CONTINUE_FLAG = 'continue'

/**
 * 이 CLI 는 **직전 대화를 이어서** 시작할 수 있나 (1.0.8 ② 끊김 카드).
 *
 * 지금은 claude(`-c`)뿐이다 — codex·gemini 에는 그런 플래그가 없다. 없는 기능을 있는 척하지
 * 않으려고 **표에 물어본다**: 카드의 버튼 글자([이어서 시작]/[다시 시작])와 실제로 붙는 플래그가
 * 같은 근거를 봐야 "이어서 시작을 눌렀는데 새 대화가 뜬다"가 안 생긴다.
 */
export function canResume(cli: AiCliId): boolean {
  return AI_CLIS[cli].flags.some((f) => f.id === CONTINUE_FLAG)
}

/**
 * 끊김 카드에서 되살릴 때 쓸 플래그 — **저장된 조합에서 "이어서"만 갈아 끼운다.**
 *
 * 🔴 `-r`(고르기)과 `-c`(직전 이어서)는 **배타**다(위 표의 group:'session' 주석). 그런데
 * `resume`(-r)은 **기본값이 true** 라, 빼지 않으면 되살릴 때 반드시 둘 다 실린다 — claude 가
 * 뒤엣것만 보거나 오류를 낸다. 그 처리를 여기서 하지 않고 호출측에 맡기면 화면마다 갈린다.
 * 빼는 일은 `toggleFlag` 가 이미 안다(같은 group 을 걷어 낸다) — 규칙을 두 벌로 만들지 않는다.
 *
 * 이어서 시작할 수 없는 CLI(codex·gemini·custom)는 **저장된 조합 그대로** 다시 띄운다.
 */
export function resumeFlags(cli: AiCliId, saved: readonly string[]): string[] {
  if (!canResume(cli)) return [...saved]
  // 이미 켜져 있으면 toggleFlag 가 꺼 버린다 — 먼저 걷어 내고 한 번만 켠다.
  return toggleFlag(cli, saved.filter((x) => x !== CONTINUE_FLAG), CONTINUE_FLAG)
}

export type LaunchOptions = {
  cli: AiCliId
  /** custom 일 때만 쓴다. */
  bin?: string
  /** AI_CLIS[cli].flags 의 **id** 만. 임의 인자를 실어 보낼 수 있는 문을 만들지 않는다. */
  flags: readonly string[]
  path: string
  /** #90: 어느 셸에 보낼 한 줄인가. 원격은 늘 posix — 기본값이 그것이라 기존 호출은 그대로 돈다. */
  shell?: LaunchShell
}

/** 실행할 CLI 하나(bin + 인자 낱말). buildLaunch 가 이것을 한 줄로 잇는다. */
export type AiCommand = { bin: string; args: string[] }

/** 플래그 개수 상한. 이 표의 CLI 중 제일 많은 것이 셋이라 넉넉하다. */
const MAX_ARGS = 16

/**
 * 명령줄에 **인용 없이** 그대로 실을 수 있는 토큰인가.
 *
 * 토큰에 공백·따옴표·`&`·`$`·`%` 가 없으면 posix·PowerShell·cmd **어느 파서가 읽어도 결과가 같다.**
 * 사용자가 고른 폴더는 여기 오지 않는다 — `cd` 쪽(cdThen)이 따로 인용한다.
 */
const ARGV_SAFE = /^[A-Za-z0-9@._/:+=-]+$/

/** 표에서 조립한 bin·인자를 한 번 더 본다. 통과하지 못하면 null(부르는 쪽이 반드시 분기한다). */
export function safeAiCommand(v: unknown): AiCommand | null {
  const o = v as AiCommand | null
  if (!o || typeof o !== 'object') return null
  const bin = validCliBin(o.bin)
  if (bin === null) return null
  if (!Array.isArray(o.args) || o.args.length > MAX_ARGS) return null
  if (!o.args.every((a) => typeof a === 'string' && a !== '' && a.length <= MAX_BIN && ARGV_SAFE.test(a))) return null
  return { bin, args: [...o.args] }
}

/** 이 CLI 를 이 플래그로 띄울 argv. 검증은 `buildLaunch` 와 **같은 것**을 지난다. */
export function aiCommandOf(o: Pick<LaunchOptions, 'cli' | 'bin' | 'flags'>): AiCommand | null {
  const spec = AI_CLIS[o.cli]
  if (!spec) return null
  const bin = o.cli === 'custom' ? validCliBin(o.bin) : spec.bin
  if (bin === null || bin === '') return null
  // 표에 없는 id 가 하나라도 섞였으면 조립하지 않는다(조용히 무시하면 미리보기와 실제가 갈린다).
  const chosen = spec.flags.filter((f) => o.flags.includes(f.id))
  if (chosen.length !== new Set(o.flags).size) return null
  const groups = chosen.map((f) => f.group).filter((g): g is string => g !== undefined)
  if (new Set(groups).size !== groups.length) return null
  return safeAiCommand({ bin, args: chosen.map((f) => f.arg) })
}

/**
 * 그 셸에서 실행될 한 줄. 인자가 하나라도 틀리면 null(= 시작하지 않고 안내).
 * 화면의 "보낼 명령" 미리보기와 실제 전송 문자열은 **이 함수의 같은 반환값**이다 —
 * 셸이 갈리면 미리보기도 갈려야 한다(PowerShell 대상인데 `cd … &&` 를 보여 주면 거짓말이다).
 *
 * 2026-10-12: **다시 제품 경로다** — Shell.runAiCliNow 가 이 한 줄을 그 셸에 친다(D(#168) 의
 * "새 AI 세션"을 되돌렸다). 로컬 셸 종류는 `app:launchShell`(PtyBackend.defaultLaunchShell)이 정한다.
 */
export function buildLaunch(o: LaunchOptions): string | null {
  const cmd = aiCommandOf(o)
  if (cmd === null) return null
  const path = validPath(o.path)
  if (path === null) return null
  return cdThen(o.shell ?? 'posix', path, [cmd.bin, ...cmd.args].join(' '))
}

/**
 * #90: 로컬 대상을 가리키는 값. `AiCliRecent.profileId` 가 서버를 전제하므로 sentinel 이 필요한데,
 * 탐색기가 이미 같은 문제를 `{ id: 'local', type: 'local' }` 로 풀어 뒀다(ExplorerView.LOCAL_SESSION).
 * 그 규약을 따른다 — 로컬을 가리키는 표현을 앱 안에 둘 만들지 않는다.
 */
export const AI_CLI_LOCAL = 'local'

/** 그 최근 항목이 내 PC 를 가리키는가. */
export function isLocalTarget(profileId: string): boolean {
  return profileId === AI_CLI_LOCAL
}

/**
 * 로컬 셸 종류 → 조립 규칙. `PtyBackend.shellKind` 는 pwsh 와 powershell 5.1 을 둘 다
 * 'powershell' 로 보는데 **그게 맞다** — 위 cdThen 의 PowerShell 문법이 양쪽에서 다 돈다.
 */
export function shellFor(kind: 'powershell' | 'bash' | 'other', platform: 'win32' | 'other'): LaunchShell {
  if (kind === 'powershell') return 'powershell'
  if (kind === 'bash') return 'posix'
  // 'other' 는 Windows 면 cmd(PtyBackend 의 폴백), 그 밖에는 posix 계열 로그인 셸이다.
  return platform === 'win32' ? 'cmd' : 'posix'
}

/** 설치 확인·실행에 쓸 실행 파일 이름. custom 이면 사용자가 적은 값(검증 통과분). */
export function binOf(cli: AiCliId, bin?: string): string | null {
  return cli === 'custom' ? validCliBin(bin) : AI_CLIS[cli].bin
}

// ── 최근 목록 ────────────────────────────────────────────────────────────────
// 저장은 부산물이다: 아무것도 저장해 두지 않은 상태에서 창을 열어 바로 시작할 수 있어야 하고,
// 이 목록은 시작한 뒤에 저절로 쌓인다. **비밀은 담지 않는다** — 서버는 profileId 로만 참조한다.

export type AiCliRecent = {
  profileId: string
  path: string
  cli: AiCliId
  bin?: string
  flags: string[]
}

export const AI_CLI_RECENT_MAX = 10

/** 같은 조합인가 — 서버·폴더·CLI·플래그가 모두 같으면 하나다(플래그 순서는 뜻이 없다). */
export function sameRecent(a: AiCliRecent, b: AiCliRecent): boolean {
  return (
    a.profileId === b.profileId &&
    a.path === b.path &&
    a.cli === b.cli &&
    (a.bin ?? '') === (b.bin ?? '') &&
    [...a.flags].sort().join(' ') === [...b.flags].sort().join(' ')
  )
}

/** 맨 위로 올리고(중복은 만들지 않는다) 상한을 넘으면 오래된 것부터 버린다. 순수 함수. */
export function pushRecent(
  list: readonly AiCliRecent[],
  next: AiCliRecent,
  max: number = AI_CLI_RECENT_MAX
): AiCliRecent[] {
  return [next, ...list.filter((x) => !sameRecent(x, next))].slice(0, max)
}
