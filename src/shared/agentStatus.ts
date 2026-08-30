// F1a 훅 기반 에이전트 상태 — **추론을 그만두는 자리**(docs/orca-analysis.md §3).
//
// 전에는 `aiSessions.ts` 가 한 줄로 정했다: `idle >= 60초 → 조용함`. 그래서 **3분짜리 빌드가
// "아라가 기다립니다" 알림**이 됐다 — 아무도 안 기다리는데. 답은 더 잘 추론하는 게 아니라
// CLI 가 자기 상태를 **직접 말하게** 하는 것이다: Claude Code 는 훅을 지원하고, 훅은 셸 한 줄이라
// 우리 로컬 서버로 POST 하나 보내면 끝난다(main/agent/AgentHookServer.ts).
//
// ⚠️ **침묵은 이 파일의 입력이 아니다.** 아래 어디에도 "얼마나 조용했나"를 보는 자리가 없다 —
// 그래서 조용한 빌드가 대기로 읽힐 **방법 자체가 없다**. 다음 사람이 그 판정을 여기 되살리려면
// 인자를 새로 만들어야 하고, 그때 이 주석을 읽게 된다.

/**
 * 상태 넷. **동의어를 만들지 마라**(docs/reference/ssh-execution-boundary.md 의 규율과 같다).
 *  · working — CLI 가 지금 일하고 있다(도구 호출·프롬프트 제출 직후)
 *  · waiting — **사람을 기다린다**(권한 질문·되묻기). 알림이 울리는 유일한 상태다
 *  · done    — CLI 가 한 턴을 끝냈다고 **스스로** 말했다
 *  · unverifiable — **모른다.** 훅이 없거나(설치 실패·훅 없는 CLI) 아직 한 마디도 못 들었다.
 *    ⚠️ 여기서 옛 60초 규칙으로 되돌아가지 마라 — 모르면 모른다고 하는 것이 이 라운드의 전부다.
 */
export type AgentState = 'working' | 'waiting' | 'done' | 'unverifiable'

export type AgentStatus = {
  /** **우리 터미널 세션 id**(훅이 `ARA_PANE` 헤더로 되돌려 준다). CLI 자신의 세션 id 가 아니다. */
  sessionId: string
  /** 어느 CLI 가 말했나. 지금은 claude 뿐이지만 경로(`/hook/<cli>`)와 표가 이미 갈려 있다. */
  cli: HookCli
  state: AgentState
  /** **모든 이벤트**에 갱신. "마지막으로 무슨 소리라도 들은 때". */
  updatedAt: number
  /**
   * **상태가 바뀔 때만** 갱신. 알림 id 를 이 값으로 만들면(`notifyTag`) 같은 상태의 반복 이벤트가
   * OS 알림 한 개로 합쳐진다 — 중복 제거 표가 필요 없다(orca-analysis §3 값싼 것 a).
   */
  stateStartedAt: number
  /**
   * **우리가 스스로 주장한 상태**라는 표시. 훅이 말해 준 것이 아니므로 **나이와 무관하게
   * 신선하지 않다** — 화면엔 그리되 알림은 이걸 안 믿고, 첫 실제 훅이 지운다.
   *
   * 로컬 라운드(F1a)에는 아직 이걸 만드는 자리가 없다: 상태를 영속화하지 않아 재시작하면 통째로
   * 사라지고, 못 들은 세션은 상태를 만들지 않고 `unverifiable` 로 그린다. 자리는 F1b(원격 —
   * 연결이 끊긴 동안의 마지막 상태)와 상태 영속화가 붙는 날이다.
   */
  restoredUnconfirmed?: boolean
}

/** 훅을 받는 CLI. 새 CLI 는 여기 표 한 줄과 `/hook/<cli>` 경로만 추가하면 된다. */
export type HookCli = 'claude'

/**
 * Claude Code 훅 이벤트 → 상태.
 *
 * 실측(2026-08-30, `claude --settings` 로 실제 훅을 받아 확인): 한 턴은
 * `SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop` 으로 온다.
 * `Notification` 은 권한 질문·입력 대기 때 온다 — 둘 다 **사람을 기다리는** 상태라 같이 waiting 이다.
 */
const CLAUDE_EVENT_STATE: Readonly<Record<string, AgentState>> = {
  SessionStart: 'working',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'done'
}

/**
 * CLI 별 매핑. **표에 없는 이벤트는 `null` — 아무 주장도 안 한다.**
 *
 * ⚠️ `null` 이 이 설계의 핵심이다. "모르는 이벤트"가 상태를 바꾸면 침묵이 다시 판정의 입력이 된다
 * (CLI 가 새 이벤트를 하나 추가하는 것만으로 우리 판정이 흔들린다). 모르면 이전 상태를 그대로 둔다.
 */
export const HOOK_STATE_OF: Readonly<Record<HookCli, (event: string) => AgentState | null>> = {
  claude: (event) => CLAUDE_EVENT_STATE[event] ?? null
}

/** 우리가 훅을 심는 이벤트 = 위 표의 키. 표에 없는 이벤트는 애초에 설치하지 않는다. */
export const CLAUDE_HOOK_EVENTS: readonly string[] = Object.keys(CLAUDE_EVENT_STATE)

/**
 * 경로에서 온 문자열이 우리 표에 있는 CLI 인가.
 *
 * ⚠️ `in` 을 쓰면 안 된다 — 프로토타입까지 본다. `/hook/constructor/Stop` 이 통과해서
 * `HOOK_STATE_OF['constructor'](event)` 를 부르고, 그 반환값(객체)이 `null` 이 아니라 **상태로
 * 취급된다.** 경로는 신뢰 경계 밖이다.
 */
export function isHookCli(v: string): v is HookCli {
  return Object.prototype.hasOwnProperty.call(HOOK_STATE_OF, v)
}

/**
 * 훅 하나를 상태에 반영한다. **순수 함수** — 여기서 틀리면 화면이 조용히 거짓말을 한다.
 *
 * 규칙 셋:
 *  ① 모르는 이벤트는 상태를 안 건드린다. 다만 `updatedAt` 은 움직인다 — 무슨 소리든 **들었다**는
 *     사실은 참이고, 그 사실이 상태를 주장하지는 않는다.
 *  ② 없던 세션에 모르는 이벤트가 오면 아무것도 만들지 않는다(`null`) — 상태를 모르는 것과
 *     "상태가 있는데 모르는 값"은 다르다.
 *  ③ 첫 실제 훅은 `restoredUnconfirmed` 를 지우고, 그때는 값이 같아도 **상태가 바뀐 것으로 친다** —
 *     이전 값은 우리 추측이었지 그 CLI 의 말이 아니었다.
 */
export function applyHook(
  prev: AgentStatus | null,
  ev: { cli: HookCli; sessionId: string; event: string },
  now: number
): AgentStatus | null {
  const next = HOOK_STATE_OF[ev.cli](ev.event)
  if (!prev) {
    if (next === null) return null
    return { sessionId: ev.sessionId, cli: ev.cli, state: next, updatedAt: now, stateStartedAt: now }
  }
  const state = next ?? prev.state
  const fresh = state !== prev.state || prev.restoredUnconfirmed === true
  return {
    sessionId: prev.sessionId,
    cli: ev.cli,
    state,
    updatedAt: now,
    stateStartedAt: fresh ? now : prev.stateStartedAt
  }
}

/**
 * OS 알림 id. **상태가 시작된 시각**이 들어가므로 같은 상태의 반복 이벤트는 알림 하나로 합쳐지고
 * (Notification 의 `tag` 가 앞 것을 대체한다), 상태가 바뀌면 새 알림이 된다. 중복 제거 표가 없다.
 */
export function notifyTag(s: Pick<AgentStatus, 'sessionId' | 'stateStartedAt'>): string {
  return `agent:${s.sessionId}:${s.stateStartedAt}`
}

/** 훅 설치 결과 — 설정 화면이 이걸 그대로 말한다(성공/왜 실패했나). */
export type AgentHookInstall =
  | { ok: true; path: string }
  /**
   * · parse — 파일이 있는데 JSON 이 깨졌다. **덮어쓰지 않는다**(사용자 설정을 날리는 것이 이 라운드에서
   *   가장 나쁜 실패다). 사람이 고쳐야 하므로 화면에 말한다.
   * · write — 읽기는 됐는데 쓰기가 실패했다(권한·디스크·오피스키퍼).
   * · noHome — 홈 디렉터리를 못 찾았다.
   * · skipped — **실패가 아니라 안 한 것이다**(F1b 원격). 그 서버에 `~/.claude` 가 아예 없으면
   *   Claude Code 가 없는 서버라, 심어 봐야 아무도 안 읽는 파일을 남의 프로덕션 서버에 만드는 일이다.
   *   설치는 SSH 가 붙을 때마다 다시 시도하므로 나중에 깔면 그다음 접속에서 심긴다.
   */
  | { ok: false; reason: 'parse' | 'write' | 'noHome' | 'skipped'; message: string }

/** 설정 화면·렌더러가 한 번에 받아 가는 것. */
export type AgentHookState = {
  /** 훅이 POST 하는 포트(0 = 서버가 안 떴다). */
  port: number
  install: AgentHookInstall
  statuses: AgentStatus[]
}
