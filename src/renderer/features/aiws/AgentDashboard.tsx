import type { JSX } from 'react'
import { Bot } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { t } from '../../i18n'
import { revealAgent, useAgentStore, worktreeName } from './agentStore'
import { displayOf } from './agentStatusView'
import { AgentGlyph } from './AgentGlyph'
import { BOARD_BUCKETS, boardOf, feedView, type FeedKind } from './agentBoard'
import type { AgentDisplay } from './agentStatusView'

/**
 * M3 R3 AI-08 에이전트 대시보드 — Orca AgentDashboardDrawer·DashboardAgentRow(orcaRef 7a7f46f8a3)의 1차:
 * 상태별 네 칸(작업 중·기다림·끝남(안 봄)·쉼), 카드 = 글리프 · 에이전트 · 워크트리 · 지금 도구, '추정'은 글리프의 점선 고리.
 * 카드를 누르면 그 워크트리·탭으로. 뺀 것: 팝아웃 창·대화 미리보기·자식 카드 펼침·필터·설정 메뉴.
 */
export function AgentDashboard(): JSX.Element {
  const tabs = useAgentStore((s) => s.tabs)
  const statusById = useAgentStore((s) => s.statusById)
  const seenById = useAgentStore((s) => s.seenById)
  const cards = tabs.map((x) => {
    const st = statusById[x.sessionId]
    return { tab: x, st, display: displayOf(st, seenById[x.sessionId] ?? true), exited: x.exited }
  })
  const board = boardOf(cards)
  return (
    <div className="aiws-board" role="region" aria-label={t('aiws.nav.dashboard')} data-aiws="dashboard">
      <h2 className="aiws-new-ttl">{t('aiws.nav.dashboard')}</h2>
      {cards.length === 0 ? (
        // C#19 빈 상태 = 가운데 아이콘 + 제목 + 안내(AI 첫 화면 .aiws-empty 와 같은 문법).
        <div className="aiws-empty">
          <Bot className="aiws-home-ic" aria-hidden />
          <b>{t('aiws.board.emptyTitle')}</b>
          <span>{t('aiws.board.empty')}</span>
        </div>
      ) : (
        <div className="aiws-board-cols">
          {BOARD_BUCKETS.map((b) => (
            <section key={b} className="aiws-board-col" data-bucket={b} aria-label={t('aiws.board.' + b)}>
              <header className="aiws-board-h">
                <span>{t('aiws.board.' + b)}</span>
                <b>{board[b].length}</b>
              </header>
              {board[b].map(({ tab, st, display }) => (
                <button key={tab.sessionId} type="button" className="aiws-card" data-session={tab.sessionId} title={tab.line} onClick={() => revealAgent(tab.sessionId)}>
                  <span className="aiws-card-l1">
                    <AgentGlyph display={display} estimated={st?.estimated ?? true} detail={st?.source} />
                    <b>{AGENTS[tab.agent].label}</b>
                    <span className="aiws-card-st">{tab.lost ? t('aiws.agent.lost') : tab.exited ? t('aiws.agent.exited') : t('aiws.st.' + display)}</span>
                  </span>
                  <span className="aiws-card-l2 aiws-mono">{worktreeName(tab.worktreeId)}</span>
                  {st?.tool && <span className="aiws-card-l2">{st.tool}</span>}
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/** 피드 항목 → 글리프 모양(같은 글리프를 쓴다 — 보드·사이드바와 한 벌). */
const FEED_GLYPH: Record<FeedKind, AgentDisplay> = { working: 'working', blocked: 'blocked', question: 'question', done: 'done', error: 'unknown' }

/**
 * M3 R3 AI-09 활동 피드 — Orca Agents 피드(docs activity.mdx)의 1차: 에이전트 상태 변화(일 시작·승인/질문 대기·끝남·오류)를 시간순(최신이 위) 한 줄씩.
 * 누르면 그 워크트리·탭으로. 뺀 것: 스레드 묶기·응답 미리보기·워크트리 생성 이벤트·필터(Ctrl+F)·안 읽음 배지·지우기.
 */
export function ActivityFeed(): JSX.Element {
  const feed = useAgentStore((s) => s.feed)
  const tabs = useAgentStore((s) => s.tabs)
  const items = feedView(feed)
  return (
    <div className="aiws-board" role="region" aria-label={t('aiws.nav.agents')} data-aiws="activity">
      <h2 className="aiws-new-ttl">{t('aiws.feed.title')}</h2>
      {items.length === 0 ? (
        <div className="aiws-empty">
          <Bot className="aiws-home-ic" aria-hidden />
          <b>{t('aiws.feed.emptyTitle')}</b>
          <span>{t('aiws.feed.empty')}</span>
        </div>
      ) : (
        <div className="aiws-feed" role="list">
          {items.map((e) => {
            const tab = tabs.find((x) => x.sessionId === e.sessionId)
            return (
              <button key={e.id} type="button" role="listitem" className="aiws-feed-row" data-feed={e.kind} data-session={e.sessionId} disabled={!tab} onClick={() => revealAgent(e.sessionId)}>
                <AgentGlyph display={FEED_GLYPH[e.kind]} estimated={e.estimated} />
                <span className="aiws-feed-t">
                  {tab ? `${AGENTS[tab.agent].label} · ${worktreeName(tab.worktreeId)}` : t('aiws.feed.closed')} — {t('aiws.feed.' + e.kind)}
                </span>
                <time className="aiws-feed-at" dateTime={new Date(e.at).toISOString()}>
                  {new Date(e.at).toLocaleTimeString()}
                </time>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
