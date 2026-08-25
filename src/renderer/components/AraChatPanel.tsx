import { useCallback, useEffect, useRef, useState } from 'react'
import type { AraChatEvent } from '../../main/ai/AraChat'
import type { AskRequest } from '../../main/mcp/askUser'
import {
  dropAsk,
  openAsk,
  pickByKey,
  pushAsk,
  pushMine,
  reduceChat,
  remainText,
  type ChatItem
} from '../store/araChatItems'
import { IconClose, IconRefresh } from './icons'
import { t } from '../i18n'

// #125 아라 대화 v2 — **관제실**(설계 §9). 우측 레일의 그 자리에 산다.
//
// 모양은 준영님이 목업에서 고른 **B+C 혼합**이다(2026-08-24):
//   · 도구는 **접힌 묶음 한 줄**(B) — 평소엔 글만 보이고, 궁금하면 펴서 무엇을 했는지 본다.
//   · 되묻기는 **알약 버튼**(C) — 숫자 키로도 고른다. 좁은 레일에서 세로를 덜 먹는다.
//
// 접기 규칙은 화면이 아니라 store/araChatItems.ts 가 갖는다(순수 함수 — 검사 대상).
// 여기 있는 것은 그 결과를 그리는 일과, 사람이 누르는 것을 IPC 로 보내는 일뿐이다.

/** 이 상태들에서만 사람이 말을 보낼 수 있다(나머지는 먼저 할 일이 있다). */
const CAN_TYPE = new Set<Phase>(['idle', 'working'])

/** 상태줄에 뜨는 지금 상황. */
type Phase = 'closed' | 'opening' | 'idle' | 'working'

export function AraChatPanel({
  open,
  onClose,
  active,
  prefill
}: {
  open: boolean
  onClose: () => void
  active: { type: 'local' | 'ssh' | 'rdp'; cwd: string | null } | null
  /**
   * 바깥에서 얹어 주는 말(#127) — 우클릭 [아라에게 묻기]·프로세스 표·부트스트랩이 여기로 온다.
   * `at` 이 함께 오는 이유: 같은 문자열을 다시 골라도 새 요청인 줄 알아야 한다.
   * 기본은 **보내지 않고 입력칸에 얹기**다 — 무엇이 나갈지 보고 사람이 마무리한다.
   */
  prefill?: { text: string; at: number; autoSend?: boolean } | null
}): JSX.Element | null {
  const [items, setItems] = useState<ChatItem[]>([])
  const [phase, setPhase] = useState<Phase>('closed')
  const [cwd, setCwd] = useState<string | null>(null)
  // 어느 엔진으로 열려 있나(#126). **늘 보인다** — 돈도 능력도 다르다.
  const [engine, setEngine] = useState<'cli' | 'api'>('cli')
  const [cost, setCost] = useState<{ usd: number; turns: number } | null>(null)
  // #136 계획 먼저 — 켜면 아라가 **아무것도 건드리지 않고** 계획만 낸다(실측으로 확인한 모드).
  // planReady = 그 계획이 나왔다(턴이 끝났다) → 승인 줄을 세운다.
  const [planOn, setPlanOn] = useState(false)
  const [planReady, setPlanReady] = useState(false)
  // 사건 처리기는 한 번만 붙으므로(deps []) 최신 값을 ref 로 본다.
  const planOnRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [openTools, setOpenTools] = useState<Set<string>>(new Set())
  // 남은 시간을 초 단위로 다시 그리기 위한 시계(되묻기 카드가 열려 있을 때만 돈다).
  const [now, setNow] = useState(Date.now())
  const bodyRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ask = openAsk(items)

  // 엔진 사건 → 목록. 상태줄에 쓰는 것(비용·단계)은 따로 뽑는다.
  useEffect(() => {
    const off = window.ev?.ara.onEvent((e: AraChatEvent) => {
      if (e.t === 'opened') {
        setCwd(e.cwd)
        setEngine(e.engine)
        setPhase('idle')
        return
      }
      if (e.t === 'noEngine') {
        // 이제 여기서 멈추지 않는다 — main 이 곧바로 API 엔진으로 다시 열고 'opened' 를 보낸다.
        // 우리는 **왜 넘어갔는지**만 한 줄 남긴다(조용히 바꾸지 않는다는 약속이 이 줄이다).
        setItems((cur) => reduceChat(cur, { t: 'error', message: t('ara.noEngine') }))
        return
      }
      if (e.t === 'closed') {
        setPhase('closed')
        return
      }
      if (e.t === 'planMode') {
        planOnRef.current = e.on
        setPlanOn(e.on)
        if (!e.on) setPlanReady(false)
        return
      }
      if (e.t === 'turn') {
        setPhase('idle')
        // 계획 모드에서 턴이 끝났다 = 계획이 나왔다. 이제 사람이 정한다.
        setPlanReady(planOnRef.current)
        setCost((c) => ({ usd: (c?.usd ?? 0) + (e.costUsd ?? 0), turns: (c?.turns ?? 0) + e.turns }))
      }
      if (e.t === 'text' || e.t === 'tool') setPhase('working')
      setItems((cur) => reduceChat(cur, e))
    })
    return () => off?.()
  }, [])

  // 되묻기는 MCP 쪽 채널로 온다(도구가 부른 것이라 엔진 사건이 아니다).
  useEffect(() => {
    const offAsk = window.ev?.mcp.onAsk((r: AskRequest) => setItems((cur) => pushAsk(cur, r)))
    const offDone = window.ev?.mcp.onAskDone(({ askId }) => setItems((cur) => dropAsk(cur, askId)))
    // 패널을 닫았다 열었을 때 기다리던 질문을 되찾는다.
    void window.ev?.mcp.askPending().then((r) => setItems((cur) => r.items.reduce(pushAsk, cur)))
    return () => {
      offAsk?.()
      offDone?.()
    }
  }, [])

  // 새 줄이 오면 아래로 붙인다 — 사람이 위로 올려 읽는 중이면 건드리지 않는다.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    if (!ask) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ask])

  // 얹어 주는 말. at 이 바뀔 때만 반응한다(같은 선택을 다시 골라도 새 요청이다).
  const prefillAt = prefill?.at
  useEffect(() => {
    const text = prefill?.text?.trim()
    if (!open || !prefillAt || !text) return
    if (prefill?.autoSend) sendRef.current(text)
    else {
      setDraft(text)
      inputRef.current?.focus()
    }
    // prefill.text 는 at 과 함께 오므로 deps 에 at 만 둔다(AiPanel 이 쓰던 그 규칙).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillAt])

  // 되묻기가 오면 **카드로 포커스를 옮긴다.** 안 옮기면 숫자 키가 입력칸에 글자로 박히고,
  // 입력칸은 터미널 단축키를 막느라 키를 위로 안 올려 준다(stopPropagation) — 즉 숫자 선택이
  // 아예 안 닿는다. 자유롭게 쓰고 싶으면 입력칸을 누르면 된다(Enter 가 그 답으로 간다).
  const askId = ask?.askId
  useEffect(() => {
    if (askId) askRef.current?.focus()
  }, [askId])

  const start = useCallback(
    async (o: { cwd?: string; engine?: 'cli' | 'api' } = {}) => {
      setPhase('opening')
      const r = await window.ev?.ara.open({ ...o, active })
      if (r && !r.ok) setPhase('closed')
    },
    [active]
  )

  // 처음 열릴 때 한 번 붙는다. 기동에 시간이 드는 물건이라(≈20초) 패널을 열자마자 시작한다.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void start()
  }, [start])

  const send = (text: string): void => {
    const s = text.trim()
    if (s === '' || !CAN_TYPE.has(phase)) return
    setItems((cur) => pushMine(cur, s))
    setPlanReady(false)
    setDraft('')
    setPhase('working')
    void window.ev?.ara.send(s)
  }

  // send 는 매 렌더 새로 만들어진다 — prefill 효과가 옛 것을 붙잡지 않게 ref 로 본다.
  const sendRef = useRef(send)
  sendRef.current = send

  const answer = (askId: string, text: string): void => {
    setItems((cur) => dropAsk(cur, askId))
    void window.ev?.mcp.answerAsk(askId, text)
    setPhase('working')
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.ev?.fs.pickDir()
    if (dir) void start({ cwd: dir })
  }

  // 되묻기가 열려 있으면 숫자 키가 곧 선택이다(마우스 없이 답할 수 있어야 한다).
  const onKey = (e: React.KeyboardEvent): void => {
    if (!ask || ask.options.length === 0) return
    const picked = pickByKey(e.key, ask.options)
    if (picked === null) return
    e.preventDefault()
    answer(ask.askId, picked)
  }

  const toggleTools = (id: string): void =>
    setOpenTools((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })

  // 닫혀도 **컴포넌트는 살아 있다**(대화 목록·엔진 유지). 훅 뒤에서 그리기만 접는다.
  if (!open) return null

  return (
    <div className="ara-panel" onKeyDown={onKey}>
      <div className="ara-hd">
        <span className="t">{t('ara.title')}</span>
        {/* 폴더는 **묻지 않는다**(2026-08-25) — 늘 어딘가에서 돌고, 여기를 누르면 바꾼다.
            아라를 특정 폴더에 매어 두는 물건으로 만들지 않기 위해서다. */}
        {cwd && (
          <button type="button" className="cwd" title={`${t('ara.cwd.change')}\n${cwd}`} onClick={() => void pickFolder()}>
            {cwd}
          </button>
        )}
        <button type="button" className="ara-ic" title={t('ara.restart')} onClick={() => void start({ ...(cwd ? { cwd } : {}), engine })}>
          <IconRefresh />
        </button>
        <button type="button" className="ara-ic" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="ara-body" ref={bodyRef}>
        {items.map((it) =>
          it.k === 'me' ? (
            <div className="ara-me" key={it.id}>
              {it.text}
            </div>
          ) : it.k === 'ai' ? (
            <div className="ara-ai" key={it.id}>
              {it.text}
            </div>
          ) : it.k === 'note' ? (
            <div className={'ara-note' + (it.tone === 'bad' ? ' bad' : '')} key={it.id}>
              {it.text}
            </div>
          ) : it.k === 'tools' ? (
            // B: 평소엔 한 줄로 접혀 있다. 무엇을 했는지 궁금하면 편다.
            <div className="ara-fold" key={it.id} data-tools={it.lines.length}>
              <div className="hd" onClick={() => toggleTools(it.id)}>
                <span className="caret">{openTools.has(it.id) ? '▾' : '▸'}</span>
                <span className="n">{t('ara.tools.n').replace('{n}', String(it.lines.length))}</span>
                <span className="st">{it.lines.some((l) => l.ok === null) ? '…' : it.lines.every((l) => l.ok) ? '✓' : '✕'}</span>
              </div>
              {openTools.has(it.id) && (
                <div className="in">
                  {it.lines.map((l) => (
                    <div className="l" key={l.id}>
                      <span className={'k' + (l.ok === false ? ' bad' : '')}>{l.ok === null ? '·' : l.ok ? '✓' : '✕'}</span>
                      <span className="nm">{l.name}</span>
                      <span className="v" title={l.brief}>
                        {l.brief}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // C: 되묻기 — 알약 버튼. 숫자 키로도 고른다.
            <div
              className="ara-ask"
              key={it.id}
              data-ask={it.req.askId}
              tabIndex={-1}
              ref={it.req.askId === askId ? askRef : undefined}
            >
              <div className="q">{it.req.question}</div>
              {it.req.options.length > 0 && (
                <div className="opts">
                  {it.req.options.map((o, i) => (
                    <button type="button" className="pill" key={o + i} data-k={i + 1} onClick={() => answer(it.req.askId, o)}>
                      <span className="num">{i + 1}</span>
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <div className="meta">{remainText(it.req.expiresAt, now)}</div>
            </div>
          )
        )}

        {phase === 'closed' && items.length === 0 && <div className="ara-empty">{t('ara.closed')}</div>}
      </div>

      {/* #136: 계획이 나왔다. 누르면 실행 모드로 풀고 "그대로 진행해" 가 나간다 — 프로세스를
          다시 띄우지 않는다(실측: control 요청으로 모드만 갈아 끼우면 된다).
          고칠 게 있으면 그냥 아래에 쓰면 된다 — 버튼을 하나 더 두지 않는다. */}
      {planOn && planReady && (
        <div className="ara-plan">
          <span className="q">{t('ara.plan.ask')}</span>
          <button type="button" className="ara-btn p" onClick={() => void window.ev?.ara.approvePlan()}>
            {t('ara.plan.go')}
          </button>
        </div>
      )}

      <div className="ara-compose">
        <textarea
          ref={inputRef}
          className="ara-input"
          rows={2}
          value={draft}
          placeholder={ask ? t('ara.answerFirst') : t('ara.placeholder')}
          disabled={!CAN_TYPE.has(phase)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation() // 터미널 단축키가 가로채지 않게
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // 되묻기가 열려 있으면 그 답으로 보낸다(자유 입력 선택지).
              if (ask) answer(ask.askId, draft.trim() || '(빈 답)')
              else send(draft)
            }
          }}
        />
        <div className="ara-bar">
          {/* 엔진 스위치(2026-08-25 준영님) — 무엇으로 도는지 고르고, 지금 무엇으로 도는지 본다.
              claude 가 없으면 main 이 알아서 API 로 넘기고 이 스위치가 그쪽으로 옮겨져 있다. */}
          <button
            type="button"
            className={'ara-chip eng' + (engine === 'api' ? ' on' : '')}
            aria-pressed={engine === 'api'}
            title={t(engine === 'api' ? 'ara.engine.tip.api' : 'ara.engine.tip.cli')}
            onClick={() => void start({ ...(cwd ? { cwd } : {}), engine: engine === 'api' ? 'cli' : 'api' })}
          >
            {t(engine === 'api' ? 'ara.engine.api' : 'ara.engine.cli')}
          </button>
          {/* 계획 먼저는 **대화의 성격**을 바꾸는 스위치라 늘 보이는 자리에 둔다. */}
          <button
            type="button"
            className={'ara-chip plan' + (planOn ? ' on' : '')}
            aria-pressed={planOn}
            title={t('ara.plan.tip')}
            onClick={() => void window.ev?.ara.planMode(!planOn)}
          >
            {t('ara.plan')}
          </button>
          <span className={'ara-dot' + (phase === 'working' ? ' run' : phase === 'closed' ? ' off' : '')} />
          <span className="s">{t('ara.phase.' + phase)}</span>
          <span className="sp" />
          {cost && (
            <span className="c">
              ${cost.usd.toFixed(3)} · {t('ara.turns').replace('{n}', String(cost.turns))}
            </span>
          )}
          <button
            type="button"
            className="ara-btn"
            disabled={phase !== 'working'}
            onClick={() => void window.ev?.ara.interrupt()}
          >
            {t('ara.stop')}
          </button>
        </div>
      </div>
    </div>
  )
}
