import { useEffect, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { MessageCircleQuestion, X } from 'lucide-react'
import { childStale, type AgentChild } from '@shared/agentHooks'
import { t } from '../../i18n'
import type { AgentDisplay } from './agentStatusView'

/** "응답 없음" 판정을 다시 보는 간격(이벤트가 없으면 다시 그릴 일이 없다). */
const STALE_TICK_MS = 60_000

/**
 * M3 R2 AI-11 상태 글리프 — Orca StatusIndicator·AgentWorkingSpinner·AgentQuestionIcon(orcaRef 7a7f46f8a3)의 모양:
 * 일함 = 도는 고리, 막힘(승인·질문) = 말풍선 물음표, 끝(안 봄) = 초록 점, 쉼(봄) = 흐린 점, 모름 = 빈 점.
 * '추정'(훅 없이 화면 판정)은 Orca 에 없는 상태라 점선 고리를 두른다(시안 톤 — 같은 글리프, 확신만 낮춘 모양).
 * 툴팁은 네이티브 title(Orca StateIndicatorTooltip 의 문구: 상태 · 도구 · 근거).
 */
export function AgentGlyph({ display, estimated, detail }: { display: AgentDisplay; estimated: boolean; detail?: string }): JSX.Element {
  const label = t(`aiws.st.${display}`) + (estimated ? ` · ${t('aiws.st.estimated')}` : '') + (detail ? ` · ${detail}` : '')
  return (
    <span className={'ag-glyph' + (estimated ? ' est' : '')} data-agent-state={display} data-estimated={estimated || undefined} title={label} role="img" aria-label={label}>
      {display === 'working' ? <span className="ag-spin" /> : display === 'blocked' || display === 'question' ? <MessageCircleQuestion className="ag-q" aria-hidden /> : <span className={'ag-dot ' + display} />}
    </span>
  )
}

/** 서브에이전트 자식 줄(AI-06, Orca agent-child-row-model 의 이름 · 지금 도구). sessionId = 그 자식의 부모 에이전트 탭. */
export type AgentChildItem = AgentChild & { sessionId: string }

/**
 * 2.2.21 오래(CHILD_STALE_MS) 조용한 자식은 흐리게 "응답 없음". [×]·우클릭은 **목록에서만** 뺀다(서브에이전트를 끝내지 않는다).
 * 막힘 자식은 사람을 기다리는 중이라 응답 없음으로 치지 않는다.
 */
export function AgentChildRows({ items, onForget, onMenu }: { items: AgentChildItem[]; onForget?: (c: AgentChildItem) => void; onMenu?: (e: ReactMouseEvent, c: AgentChildItem) => void }): JSX.Element | null {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (items.length === 0) return
    const id = setInterval(() => setNow(Date.now()), STALE_TICK_MS)
    return () => clearInterval(id)
  }, [items.length])
  if (items.length === 0) return null
  return (
    <div className="ag-children" role="list" aria-label={t('aiws.st.subagents')}>
      {items.map((c) => {
        const stale = childStale(c, now)
        return (
          <div key={c.sessionId + c.id} className={'ag-child' + (stale ? ' stale' : '')} role="listitem" data-child={c.id} data-stale={stale || undefined} title={stale ? t('aiws.st.childStale') : undefined} onContextMenu={onMenu ? (e) => onMenu(e, c) : undefined}>
            <AgentGlyph display={c.state === 'blocked' ? 'blocked' : stale ? 'idle' : 'working'} estimated={false} />
            <span className="ag-child-name">{c.agentType ?? t('aiws.st.subagent')}</span>
            {stale ? <span className="ag-child-tool">{t('aiws.st.childStaleShort')}</span> : c.tool && <span className="ag-child-tool">{c.tool}</span>}
            {onForget && (
              <button
                type="button"
                className="ag-child-x"
                data-aiws="child-forget"
                title={t('aiws.st.childForget')}
                aria-label={t('aiws.st.childForget')}
                onClick={(e) => {
                  e.stopPropagation()
                  onForget(c)
                }}
              >
                <X aria-hidden />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
