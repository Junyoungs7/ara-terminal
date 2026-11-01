// 옛 터미널 AI CLI 표(F27) — M3 S1 에서 터미널 쪽 실행(buildLaunch·최근 조합·기본 플래그)을 지우고 남은 것.
//
// 남은 쓰임: ① `Session.aiCli`(옛 스냅샷의 끊김 카드 — S3 에서 지운다)를 거르는 `aiCliOf`·`AI_CLIS[cli].bin`·`canResume`,
// ② MCP 원격 카탈로그의 `validCliBin`, ③ 셸 문법 판정 `LaunchShell`·`shellFor`(에이전트 실행 계획이 쓴다).
// 플래그 표(AI_CLIS[].flags)는 옛 설정 `ui.aiCliFlags` 의 id 를 읽는 근거라 남긴다(shared/agents.ts migrateAiCliFlags).

export type AiCliId = 'claude' | 'codex' | 'gemini' | 'custom'

/** 드롭다운 순서. Record 의 키 순서에 기대지 않는다. */
export const AI_CLI_IDS: readonly AiCliId[] = ['claude', 'codex', 'gemini', 'custom']

/**
 * 저장값 → 이 표에 있는 CLI 인가. 없으면 null.
 *
 * `Session.aiCli`(스냅샷에 실린다)는 손으로 고칠 수 있는 파일에서 돌아온다 — 모르는 이름이
 * `AI_CLIS[cli]` 로 들어가면 `undefined.bin` 이라 화면이 통째로 죽는다. 읽는 쪽에서 한 번 거른다
 * (uiScaleOf 와 같은 규칙: 저장값은 신뢰 경계 밖이다).
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

const MAX_BIN = 64

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
 * 로컬 셸 종류 → 조립 규칙. `PtyBackend.shellKind` 는 pwsh 와 powershell 5.1 을 둘 다
 * 'powershell' 로 보는데 **그게 맞다** — 에이전트 실행 줄의 PowerShell 문법이 양쪽에서 다 돈다.
 */
export function shellFor(kind: 'powershell' | 'bash' | 'other', platform: 'win32' | 'other'): LaunchShell {
  if (kind === 'powershell') return 'powershell'
  if (kind === 'bash') return 'posix'
  // 'other' 는 Windows 면 cmd(PtyBackend 의 폴백), 그 밖에는 posix 계열 로그인 셸이다.
  return platform === 'win32' ? 'cmd' : 'posix'
}
