import type { AgentStatus } from '@shared/agentStatus'

/**
 * F1a 에이전트 상태의 **렌더러 쪽 사본**. 원장은 main 이고 여기는 캐시다.
 *
 * 모듈 스코프에 두는 이유: 이 값을 읽는 데가 둘 이상이고(작업대 줄·알림 감시), 각자 구독하면
 * 같은 사실을 두 번 받아 두 벌로 갈린다. 세션 실행 기록(aiSessions.ts)과 같은 모양이다.
 *
 * 화면이 상태를 **만들지 않는다**: 여기에 쓰기 함수가 없다. 상태는 CLI 의 훅에서만 온다.
 */
const byId = new Map<string, AgentStatus>()
const listeners = new Set<() => void>()
let started = false

function emit(): void {
  listeners.forEach((f) => f())
}

/** 첫 구독자가 배선한다 — 창이 늦게 떠도 `agent:state` 로 그 사이 것을 받아 온다(MCP 패널과 같은 규칙). */
function start(): void {
  if (started) return
  started = true
  window.ev?.agent.onStatus((s) => {
    byId.set(s.sessionId, s)
    emit()
  })
  void window.ev?.agent
    .state()
    .then((st) => {
      for (const s of st.statuses) byId.set(s.sessionId, s)
      emit()
    })
    .catch(() => {
      // 못 받아도 화면은 돈다 — 그때 모든 세션이 `unverifiable` 로 보인다(그게 사실이다).
    })
}

export function agentStatuses(): AgentStatus[] {
  return [...byId.values()]
}

/**
 * 죽은 세션의 사본을 버린다. **화면이 상태를 만들지 않는다**는 규칙을 어기지 않는다 —
 * 여기서 지우는 것은 상태가 아니라 **이미 없어진 세션의 흔적**이다(main 은 세션이 끝날 때
 * 자기 원장에서 지우지만 그 사실을 렌더러로 밀어 주지 않는다).
 */
export function forgetAgentStatus(sessionId: string): void {
  if (byId.delete(sessionId)) emit()
}

/** 상태가 바뀔 때마다 불린다. 해지 함수 반환. */
export function subscribeAgent(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
