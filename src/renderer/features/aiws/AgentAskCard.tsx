import { useEffect, useState, type JSX } from 'react'
import { Check, X } from 'lucide-react'
import type { AgentId } from '@shared/agents'
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, hasAskAnswer, parseInteractivePrompt, type AskAnswerKeyGroup, type AskPrompt, type ChatApproval } from '@shared/agentAsk'
import { t } from '../../i18n'

/**
 * M11 질문/승인 카드 — Orca NativeChatInteractiveCard·NativeChatQuestionCard·NativeChatApprovalCard(orcaRef fdfcfb3551)의 흐름:
 * 질문은 한 번에 하나(단일 선택은 고르면 다음으로, 다중 선택·직접 입력은 [다음]/[보내기]), 승인은 [허용]/[거부].
 * 답은 TUI 키로(main agents:answer 가 걸음 간격을 둔다). 보낸 뒤엔 카드를 접고 훅이 막힘을 풀면 사라진다.
 * '답할 차례' 신호는 시안 C 의 반전 칩(.ag-ask-chip). 모양은 채팅 시안 A(styles/agentChat.css) — 라디오 점 · 글 · 오른쪽 번호, 고른 것 = 앰버.
 * 뺀 것: 미리 보기 선택기의 메모 칸(직접 입력으로 대신), 숫자 키 단축, 카드 접기(입력 줄 돌려주기).
 */
export function AgentAskCard({ sessionId, agent, ask, onTerminal }: { sessionId: string; agent: AgentId; ask: string; onTerminal?: () => void }): JSX.Element | null {
  const card = parseInteractivePrompt(ask)
  const [sent, setSent] = useState(false)
  // 새 질문(글이 바뀜)이면 다시 보인다.
  useEffect(() => setSent(false), [ask])
  if (!card || sent) return null
  const send = async (groups: AskAnswerKeyGroup[]): Promise<void> => {
    if (!groups.length) return
    const r = await window.ev.agents.answer(sessionId, groups)
    if (r.ok) setSent(true)
  }
  return (
    <div className="ag-ask" role="group" aria-label={t('aiws.ask.label')} data-aiws="ask-card" data-kind={card.kind}>
      <div className="ag-ask-head">
        <span className="ag-ask-chip">{t('aiws.ask.turn')}</span>
        {onTerminal && (
          <button type="button" className="btn sec ag-ask-term" onClick={onTerminal}>
            {t('aiws.chat.toTerminal')}
          </button>
        )}
      </div>
      {card.kind === 'approval' ? <Approval a={card.approval} onSend={(raw) => void send([{ raw }])} /> : <Questions prompt={card.prompt} agent={agent} onSend={(g) => void send(g)} />}
    </div>
  )
}

function Approval({ a, onSend }: { a: ChatApproval; onSend: (raw: string) => void }): JSX.Element {
  return (
    <>
      <p className="ag-ask-q">{t('aiws.ask.allowTitle').replace('{tool}', a.tool)}</p>
      {a.summary && <pre className="aiws-mono ag-ask-detail">{a.summary}</pre>}
      <div className="aiws-new-foot">
        <button type="button" className="btn sec" data-aiws="ask-deny" onClick={() => onSend(a.denySend)}>
          <X aria-hidden />
          {t('aiws.ask.deny')}
        </button>
        <button type="button" className="btn pri" data-aiws="ask-allow" onClick={() => onSend(a.allowSend)}>
          <Check aria-hidden />
          {t('aiws.ask.allow')}
        </button>
      </div>
    </>
  )
}

const ESC = String.fromCharCode(27)

function Questions({ prompt, agent, onSend }: { prompt: AskPrompt; agent: AgentId; onSend: (g: AskAnswerKeyGroup[]) => void }): JSX.Element {
  const [index, setIndex] = useState(0)
  const [picks, setPicks] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [other, setOther] = useState<string[]>(() => prompt.questions.map(() => ''))
  const total = prompt.questions.length
  const q = prompt.questions[Math.min(index, total - 1)]!
  const isLast = index >= total - 1
  const selections = (p = picks, o = other): { indices: number[]; other?: string }[] => p.map((indices, i) => ({ indices, ...(o[i]?.trim() ? { other: o[i] } : {}) }))
  const submit = (p = picks, o = other): void => {
    const sel = selections(p, o)
    if (!hasAskAnswer(prompt, sel)) return
    onSend(agent === 'codex' ? buildCodexAskAnswerKeys(prompt, sel) : buildAskAnswerKeys(prompt, sel))
  }
  const next = (p = picks, o = other): void => (isLast ? submit(p, o) : setIndex(index + 1))
  const pick = (i: number): void => {
    const cur = picks[index] ?? []
    const row = q.multiSelect ? (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]) : [i]
    const p = picks.map((x, k) => (k === index ? row : x))
    // 단일 선택은 고르면 그 줄의 직접 입력을 비우고 바로 다음으로(Orca auto-advance).
    const o = q.multiSelect ? other : other.map((x, k) => (k === index ? '' : x))
    setPicks(p)
    setOther(o)
    if (!q.multiSelect) next(p, o)
  }
  return (
    <>
      {total > 1 && <span className="aiws-note">{t('aiws.ask.step').replace('{n}', String(index + 1)).replace('{total}', String(total))}</span>}
      {q.header && <b className="ag-ask-header">{q.header}</b>}
      <p className="ag-ask-q">{q.question}</p>
      <div className="ag-ask-opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = (picks[index] ?? []).includes(i)
          return (
            <button key={i} type="button" role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} className={'ag-ask-opt' + (on ? ' on' : '')} data-aiws="ask-option" onClick={() => pick(i)}>
              <span className="ag-ask-rd" aria-hidden />
              <span className="ag-ask-ot">
                <b>{o.label}</b>
                {o.description && <span className="aiws-note">{o.description}</span>}
              </span>
              <span className="ag-ask-num">{i + 1}</span>
            </button>
          )
        })}
      </div>
      <input
        className="aiws-input"
        data-aiws="ask-other"
        placeholder={t('aiws.ask.otherPh')}
        value={other[index] ?? ''}
        onChange={(e) => {
          const v = e.target.value
          setOther((o) => o.map((x, k) => (k === index ? v : x)))
          // 단일 선택에서 직접 입력하면 고른 줄을 푼다(둘 중 하나 — Orca TYPED_ANSWER).
          if (!q.multiSelect && v) setPicks((p) => p.map((x, k) => (k === index ? [] : x)))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            next()
          }
        }}
      />
      <div className="aiws-new-foot">
        {/* 질문 거절 = Esc(Orca cancelAsk — 턴은 끊지 않는다). */}
        <button type="button" className="btn sec" data-aiws="ask-cancel" onClick={() => onSend([{ raw: ESC }])}>
          {t('aiws.ask.cancel')}
        </button>
        {index > 0 && (
          <button type="button" className="btn sec" onClick={() => setIndex(index - 1)}>
            {t('aiws.ask.prev')}
          </button>
        )}
        <button type="button" className="btn pri" data-aiws="ask-submit" disabled={isLast && !hasAskAnswer(prompt, selections())} onClick={() => next()}>
          {isLast ? t('aiws.ask.submit') : (picks[index]?.length ?? 0) > 0 || other[index]?.trim() ? t('aiws.ask.next') : t('aiws.ask.skip')}
        </button>
      </div>
    </>
  )
}
