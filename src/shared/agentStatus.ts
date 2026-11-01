// F1a 훅 기반 에이전트 상태 — **추론을 그만두는 자리**(docs/orca-analysis.md §3).
// ⚠️ M3 S2 로 이 상태를 만들던 옛 훅 서버(main/agent/*)는 지워졌다. 남은 타입은 터미널 AI 작업대·대기 알림(S1·S4 에서 지움)이 읽는다 —
// 새 에이전트 상태는 shared/agentHooks.ts(AI 작업 공간).
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
 *  · unverifiable — **모른다.** 훅이 없거나(설치 실패·훅 없는 CLI), 아직 한 마디도 못 들었거나,
 *    **CLI 가 나갔다고 말했다**(SessionEnd — 아래 표 참고). 셋 다 "지금 저 탭에서 무엇이 도는지
 *    확인할 수 없다"라 같은 값이다.
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

/** 상태를 말한 CLI. */
export type HookCli = 'claude'

/**
 * OS 알림 id. **상태가 시작된 시각**이 들어가므로 같은 상태의 반복 이벤트는 알림 하나로 합쳐지고
 * (Notification 의 `tag` 가 앞 것을 대체한다), 상태가 바뀌면 새 알림이 된다. 중복 제거 표가 없다.
 */
export function notifyTag(s: Pick<AgentStatus, 'sessionId' | 'stateStartedAt'>): string {
  return `agent:${s.sessionId}:${s.stateStartedAt}`
}
