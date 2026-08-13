// F27 AI CLI 한 번에 시작 — 원격 셸에 밀어 넣을 **한 줄**을 만드는 유일한 자리.
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
  codex: { bin: 'codex', flags: [] },
  gemini: { bin: 'gemini', flags: [] },
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
 * 경로 인용. `cd '~/x'` 는 **동작하지 않는다** — 작은따옴표 안에서는 물결표가 홈으로 펼쳐지지 않아
 * "그런 폴더 없음"이 된다. 앞의 `~/` 만 따옴표 밖에 두고 나머지를 감싼다: `cd ~/'projects/새 작업'`.
 */
function quotePath(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) {
    const rest = p.slice(2)
    return rest === '' ? '~/' : `~/'${rest}'`
  }
  return `'${p}'`
}

/** 이 CLI 에서 처음에 켜져 있는 플래그. */
export function defaultFlags(cli: AiCliId): string[] {
  return AI_CLIS[cli].flags.filter((f) => f.default).map((f) => f.id)
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

export type LaunchOptions = {
  cli: AiCliId
  /** custom 일 때만 쓴다. */
  bin?: string
  /** AI_CLIS[cli].flags 의 **id** 만. 임의 인자를 실어 보낼 수 있는 문을 만들지 않는다. */
  flags: readonly string[]
  path: string
}

/**
 * `cd <경로> && <bin> <플래그>` 한 줄. 인자가 하나라도 틀리면 null(= 시작하지 않고 안내).
 *
 * `&&` 인 이유: `;` 로 이으면 폴더가 없어 cd 가 실패해도 CLI 가 **엉뚱한 폴더에서** 뜬다.
 * `&&` 면 거기서 멈추고 셸이 "그런 폴더 없음"을 그대로 보여 준다.
 */
export function buildLaunch(o: LaunchOptions): string | null {
  const spec = AI_CLIS[o.cli]
  if (!spec) return null
  const bin = o.cli === 'custom' ? validCliBin(o.bin) : spec.bin
  if (bin === null || bin === '') return null
  const path = validPath(o.path)
  if (path === null) return null
  // 표에 없는 id 가 하나라도 섞였으면 조립하지 않는다(조용히 무시하면 미리보기와 실제가 갈린다).
  const chosen = spec.flags.filter((f) => o.flags.includes(f.id))
  if (chosen.length !== new Set(o.flags).size) return null
  const groups = chosen.map((f) => f.group).filter((g): g is string => g !== undefined)
  if (new Set(groups).size !== groups.length) return null
  const args = chosen.map((f) => f.arg).join(' ')
  return `cd ${quotePath(path)} && ${bin}${args ? ' ' + args : ''}`
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
