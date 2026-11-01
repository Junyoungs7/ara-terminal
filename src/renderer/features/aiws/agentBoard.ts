// M3 R3 AI-08 대시보드·AI-09 활동 피드·완료 알림 — 순수 규칙(화면과 단위 시험이 같은 함수를 쓴다).
// 칸 갈래는 Orca components/dashboard/dashboard-card-bucket.ts(MIT, orcaRef 7a7f46f8a3)의 attention·working·done·idle,
// 피드 항목은 docs/site/content/docs/activity.mdx 의 "턴 끝(쉼·막힘)" 이벤트를 시간순 한 줄로(스레드 묶기는 뺐다).
import type { AgentStatusView } from '@shared/agentHooks'
import type { NoteKind } from '../../store/notify'
import type { AgentDisplay } from './agentStatusView'

/** 보드 칸 — 작업 중 · 기다림(승인·질문) · 끝남(안 봄) · 쉼. 상태 모름·종료된 탭은 쉼. */
export type BoardBucket = 'working' | 'waiting' | 'done' | 'idle'
export const BOARD_BUCKETS: readonly BoardBucket[] = ['working', 'waiting', 'done', 'idle']

export function bucketOf(display: AgentDisplay, exited = false): BoardBucket {
  if (display === 'done') return 'done'
  if (exited) return 'idle'
  if (display === 'working') return 'working'
  if (display === 'blocked' || display === 'question') return 'waiting'
  return 'idle'
}

/** 칸별로 가른다(들어온 순서 그대로 — 탭 순서). */
export function boardOf<T extends { display: AgentDisplay; exited?: boolean }>(cards: readonly T[]): Record<BoardBucket, T[]> {
  const out: Record<BoardBucket, T[]> = { working: [], waiting: [], done: [], idle: [] }
  for (const c of cards) out[bucketOf(c.display, c.exited)].push(c)
  return out
}

/** 피드 항목 종류 — 일 시작 · 승인 대기 · 질문 · 끝남 · 오류(StopFailure). */
export type FeedKind = 'working' | 'blocked' | 'question' | 'done' | 'error'
export type FeedEvent = { id: number; at: number; sessionId: string; kind: FeedKind; estimated: boolean }

const kindOf = (v: AgentStatusView): FeedKind | null =>
  v.state === null ? null : v.state === 'working' ? 'working' : v.state === 'blocked' ? (v.kind === 'question' ? 'question' : 'blocked') : v.source === 'hook:StopFailure' ? 'error' : 'done'

/**
 * 상태가 바뀌어 피드에 남길 것. 같은 종류가 이어지면(도구만 바뀜) 없음. 쉼은 **일하거나 막혔다가** 쉬게 된 순간만
 * (셸이 뜨고 처음 판정된 쉼은 끝난 게 아니다 — nextSeen 과 같은 규칙).
 */
export function feedKindOf(prev: AgentStatusView | undefined, next: AgentStatusView): FeedKind | null {
  const k = kindOf(next)
  if (k === null) return null
  const pk = prev ? kindOf(prev) : null
  if (k === pk) return null
  if ((k === 'done' || k === 'error') && pk !== 'working' && pk !== 'blocked' && pk !== 'question') return null
  return k
}

/** 피드 상한 — 오래된 것부터 버린다. ponytail: 고정 상한·영속 없음(재시작하면 탭도 없다 — M4 데몬 때 다시 본다). */
export const FEED_CAP = 200
/** 최신이 위. 같은 시각이면 나중에 들어온 것(id 큰 것)이 위. */
export function feedView(events: readonly FeedEvent[]): FeedEvent[] {
  return [...events].sort((a, b) => b.at - a.at || b.id - a.id)
}

/**
 * 알림 센터로 보낼 종류. 끄면 없음, 그 탭을 지금 보고 있으면 없음(보는 사람에게 또 알리지 않는다 — Orca 도 포커스된 칸은 안 울린다).
 * 일 시작은 알리지 않는다. 맥박은 store/notify 의 attention 이 wait 에만 켠다(결정: 기다림에만).
 */
export function noteKindOf(kind: FeedKind, viewingNow: boolean, enabled: boolean): NoteKind | null {
  if (!enabled || viewingNow || kind === 'working') return null
  return kind === 'done' ? 'done' : kind === 'error' ? 'error' : 'wait'
}
