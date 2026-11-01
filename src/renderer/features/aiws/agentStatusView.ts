// M3 R2 AI-11 — 에이전트 상태를 화면 글리프로(순수). 봄/안 봄(done·idle) 구분은 herdr app/actions.rs apply_pane_state_change·
// api_helpers.rs pane_agent_status·tab_attention_priority(Apache-2.0), 글리프 갈래는 Orca components/sidebar/StatusIndicator.tsx·AgentStateDot.tsx(MIT)에서.
import type { AgentStatusView } from '@shared/agentHooks'

/** 화면에 그리는 상태. done = 쉬는데 아직 안 봄(끝난 걸 사람이 못 봤다), idle = 쉬고 봤다. */
export type AgentDisplay = 'working' | 'blocked' | 'question' | 'done' | 'idle' | 'unknown'

/**
 * 봤나(herdr seen). 일하거나 막히면 늘 본 것으로(다음 쉼을 새로 알릴 수 있게), 일하다 쉬게 된 순간에는 그 탭을 지금 보고 있을 때만 본 것.
 * 그 밖에는 앞 값을 그대로. 나중에 그 탭을 열면 부르는 쪽이 true 로 바꾼다.
 */
export function nextSeen(prev: AgentStatusView | undefined, next: AgentStatusView, prevSeen: boolean, viewingNow: boolean): boolean {
  if (next.state !== 'idle') return true
  if (prev?.state === 'working' || prev?.state === 'blocked') return viewingNow
  return prevSeen
}

export function displayOf(v: AgentStatusView | undefined, seen: boolean): AgentDisplay {
  if (!v || v.state === null) return 'unknown'
  if (v.state === 'working') return 'working'
  if (v.state === 'blocked') return v.kind === 'question' ? 'question' : 'blocked'
  return seen ? 'idle' : 'done'
}

/** 여러 탭을 한 줄(워크트리)로 — 손댈 일이 큰 것이 이긴다(herdr tab_attention_priority: 막힘 > 안 본 끝 > 일함 > 본 쉼 > 모름). */
const RANK: Record<AgentDisplay, number> = { blocked: 5, question: 5, done: 4, working: 3, idle: 2, unknown: 1 }

export function aggregate(items: { display: AgentDisplay; estimated: boolean }[]): { display: AgentDisplay; estimated: boolean } | null {
  let best: { display: AgentDisplay; estimated: boolean } | null = null
  for (const x of items) if (!best || RANK[x.display] > RANK[best.display] || (RANK[x.display] === RANK[best.display] && best.estimated && !x.estimated)) best = x
  return best
}
