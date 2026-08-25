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
type Phase = 'closed' | 'opening' | 'idle' | 'working' | 'noEngine'

export function AraChatPanel({
  open,
  onClose,
  active
}: {
  open: boolean
  onClose: () => void
  active: { type: 'local' | 'ssh' | 'rdp'; cwd: string | null } | null
}): JSX.Element | null {
  const [items, setItems] = useState<ChatItem[]>([])
  const [phase, setPhase] = useState<Phase>('closed')
  const [cwd, setCwd] = useState<string | null>(null)
  // 어느 엔진으로 열려 있나(#126). **늘 보인다** — 돈도 능력도 다르다.
  const [engine, setEngine] = useState<'cli' | 'api'>('cli')
  // #135 문지기가 막은 것. 목록에 쌓지 않고 **입력칸 바로 위**에 세운다 — 지금 답해야 할 일이다.
  const [blocked, setBlocked] = useState<{ tool: string; cls: 'write' | 'exec' } | null>(null)
  const [cost, setCost] = useState<{ usd: number; turns: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [openTools, setOpenTools] = useState<Set<string>>(new Set())
  // 남은 시간을 초 단위로 다시 그리기 위한 시계(되묻기 카드가 열려 있을 때만 돈다).
  const [now, setNow] = useState(Date.now())
  const bodyRef = useRef<HTMLDivElement>(null)
  const askRef = useRef<HTMLDivElement>(null)

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
        setPhase('noEngine')
        return
      }
      if (e.t === 'blocked') {
        setBlocked({ tool: e.tool, cls: e.cls })
        return
      }
      if (e.t === 'closed') {
        setPhase('closed')
        return
      }
      if (e.t === 'turn') {
        setPhase('idle')
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
      if (r && !r.ok && !r.noEngine) setPhase('closed')
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
    setBlocked(null)
    setItems((cur) => pushMine(cur, s))
    setDraft('')
    setPhase('working')
    void window.ev?.ara.send(s)
  }

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
        {/* API 키 모드는 **한눈에 달라 보여야 한다** — 도구가 없고 지갑이 다르다. */}
        {engine === 'api' && <span className="ara-eng">{t('ara.engine.api')}</span>}
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

        {/* #126 이 PC 에 claude 가 없다. 갈 수 있는 길을 둘 다 보여 준다 —
            설치하고 다시 보든지, 지금 API 키로 쓰든지. 조용히 한쪽으로 끌고 가지 않는다. */}
        {phase === 'noEngine' && (
          <div className="ara-empty">
            <div>{t('ara.noEngine')}</div>
            <code className="ara-cmd">npm i -g @anthropic-ai/claude-code</code>
            <div className="ara-row">
              <button type="button" className="ara-btn" onClick={() => void start()}>
                {t('ara.recheck')}
              </button>
              <button type="button" className="ara-btn p" onClick={() => void start({ engine: 'api' })}>
                {t('ara.useApi')}
              </button>
            </div>
          </div>
        )}
        {phase === 'closed' && items.length === 0 && <div className="ara-empty">{t('ara.closed')}</div>}
      </div>

      {/* #135: 문지기가 막았다. 허용은 **이 대화 동안**만이고, 프로세스를 --resume 으로 다시
          문다(실측: 도는 중에는 못 되돌린다). 설정을 대신 바꾸지 않는다. */}
      {blocked && (
        <div className="ara-block">
          <span className="q">{t('ara.blocked').replace('{tool}', blocked.tool)}</span>
          <button
            type="button"
            className="ara-btn p"
            onClick={() => {
              const cls = blocked.cls
              setBlocked(null)
              setPhase('opening')
              void window.ev?.ara.allow(cls)
            }}
          >
            {t('ara.blocked.allow')}
          </button>
        </div>
      )}

      <div className="ara-compose">
        <textarea
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
