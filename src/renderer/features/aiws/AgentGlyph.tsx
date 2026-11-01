import type { JSX } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { AgentChild } from '@shared/agentHooks'
import { t } from '../../i18n'
import type { AgentDisplay } from './agentStatusView'

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

/** 서브에이전트 자식 줄(AI-06, Orca agent-child-row-model 의 이름 · 지금 도구). */
export function AgentChildRows({ items }: { items: AgentChild[] }): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="ag-children" role="list" aria-label={t('aiws.st.subagents')}>
      {items.map((c) => (
        <div key={c.id} className="ag-child" role="listitem" data-child={c.id}>
          <AgentGlyph display={c.state === 'blocked' ? 'blocked' : 'working'} estimated={false} />
          <span className="ag-child-name">{c.agentType ?? t('aiws.st.subagent')}</span>
          {c.tool && <span className="ag-child-tool">{c.tool}</span>}
        </div>
      ))}
    </div>
  )
}
