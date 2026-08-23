import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { splitBlocks, insertText, type AiBlock } from './aiBlocks'
import { writeClipboard } from '../store/clipboardWrite'
import { tailLines } from '../terminal/termRegistry'
import { maskSecrets } from '../../shared/maskSecrets'
import { dispatchAction } from '../../shared/keymap'
import { AI_CONTEXT_LINES, AI_PROVIDER_LABELS, DEFAULT_AI_PROVIDER, type AiEnv, type AiProvider, type AiTurn } from '@shared/types'

// F16 아라 패널 — 우측 고정 폭 레일(미니 프리뷰 바깥). 대화의 주인은 main 이라 이 컴포넌트는 뷰다:
// 마운트 때 ai:getState 로 전량을 받아 그리고, 그 뒤로는 ai:delta 를 이어 붙인다
// (session:attach 가 링버퍼를 재생하는 것과 같은 패턴). 패널을 닫았다 열어도 대화가 남는 이유다.
//
// 이 파일에는 SDK 도 네트워크도 없다. 질문은 ai:send 로 main 에 넘기고 답만 받는다.

// 아라 아바타. 별도 에셋을 쓰지 않는다 — assets/brand/ev-icon-2.svg 는 "E·V" 레터마크와
// 시안 HEX 가 그려져 있어 A.R.A 리브랜딩과 --purple(AI 전용 색) 방침을 모두 되돌린다.
// currentColor 로 그려 두면 색을 CSS 토큰이 정한다.
function AraMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" opacity="0.35" />
      <circle cx="12" cy="12" r="5.5" opacity="0.6" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

// 코드블록 하나. 우상단 두 버튼 — [복사] 는 클립보드, [터미널로 보내기] 는 **삽입만** 한다.
function CodeBlock({ block, sessionId }: { block: Extract<AiBlock, { type: 'code' }>; sessionId: string | null }) {
  const [copied, setCopied] = useState(false)
  const send = () => {
    // 개행을 붙이지 않는다 — 명령은 프롬프트에 입력된 채로 멈추고 사용자가 Enter 를 눌러야 실행된다.
    if (sessionId) window.ev?.session.input(sessionId, insertText(block.code))
  }
  return (
    <div className="ai-code">
      <div className="ai-code-hd">
        <span className="ai-code-lang">{block.lang || t('ai.code.plain')}</span>
        <button
          type="button"
          className="ai-code-btn"
          data-action="ai.copy"
          onClick={() => {
            void writeClipboard(block.code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? t('ai.code.copied') : t('ai.code.copy')}
        </button>
        <button
          type="button"
          className="ai-code-btn send"
          data-action="ai.insert"
          disabled={!sessionId}
          title={sessionId ? t('ai.code.insert.title') : t('ai.noSession')}
          onClick={send}
        >
          {t('ai.code.insert')}
        </button>
      </div>
      {/* React 텍스트 노드로만 그린다 — dangerouslySetInnerHTML 을 쓰지 않으므로 모델 응답이 HTML 로 해석될 수 없다. */}
      <pre className="ai-code-body">{block.code}</pre>
    </div>
  )
}

function Turn({ turn, sessionId }: { turn: AiTurn; sessionId: string | null }) {
  const [showCtx, setShowCtx] = useState(false)
  if (turn.role === 'user') {
    return (
      <div className="ai-turn user" data-turn={turn.id}>
        <div className="ai-user-text">{turn.text}</div>
        {turn.context && (
          <>
            {/* 전송 후에도 "그 턴에 실제로 보낸 그 텍스트"를 되짚을 수 있어야 신뢰가 성립한다. */}
            <button type="button" className="ai-ctx-badge" data-action="ai.ctxPeek" onClick={() => setShowCtx((v) => !v)}>
              📎 {t('ai.ctx.attached')} · {turn.context.split('\n').length}
              {t('ai.ctx.lines')}
            </button>
            {showCtx && <pre className="ai-ctx-full">{turn.context}</pre>}
          </>
        )}
      </div>
    )
  }
  const blocks = splitBlocks(turn.text)
  return (
    <div className="ai-turn ara" data-turn={turn.id}>
      {blocks.map((b, i) =>
        b.type === 'code' ? (
          <CodeBlock key={i} block={b} sessionId={sessionId} />
        ) : (
          <div className="ai-text" key={i}>
            {b.text}
          </div>
        )
      )}
      {turn.end === 'canceled' && <div className="ai-note">{t('ai.canceled')}</div>}
      {turn.error && <div className="ai-note err">{turn.error}</div>}
    </div>
  )
}

type Props = {
  open: boolean
  onClose: () => void
  // 활성 세션 — 컨텍스트 첨부 대상이자 [터미널로 보내기] 목적지. 없으면 둘 다 비활성.
  session: { id: string; env: AiEnv } | null
  // 우클릭 메뉴 [AI에게 질문] 이 넘긴 선택 텍스트. 값이 바뀔 때마다 컴포저에 채운다.
  // autoSend: F17 부트스트랩 전용 — 조립된 질문을 컴포저에 채우는 대신 즉시 보낸다(사용자가 이미
  // 부트스트랩 폼의 "아라에게 물어보기"를 눌러 의도를 밝혔으므로 여기서 다시 Enter 를 요구하지 않는다.
  // 이후 나오는 명령 블록은 F16 그대로 [터미널로 보내기] 삽입만 — 자동 실행 경로는 없다).
  prefill?: { text: string; at: number; autoSend?: boolean } | null
  // F17: 부트스트랩 폼 열기(패널 상단 버튼). Shell 이 상태를 갖고 있어 여기선 열기만 요청한다.
  onOpenBootstrap?: () => void
}

export function AiPanel({ open, onClose, session, prefill, onOpenBootstrap }: Props) {
  const [turns, setTurns] = useState<AiTurn[]>([])
  const [hasKey, setHasKey] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [usage, setUsage] = useState({ input: 0, output: 0 })
  // #80: 입력 예산 때문에 앞에서 버린 턴 수. 조용히 버리면 모델이 왜 앞을 잊었는지 알 길이 없다.
  const [dropped, setDropped] = useState(0)
  // W5: 무엇이 답하고 있는지 보이게(설계 W5 §UI) — 패널 마운트 시 인계, 프로바이더 전환은 보통
  // 설정 드로어에서 대화를 비우고 일어나므로 다음 재마운트/응답 종료 때 자연히 갱신된다.
  const [provider, setProvider] = useState<AiProvider>(DEFAULT_AI_PROVIDER)
  const [model, setModel] = useState('')
  const [draft, setDraft] = useState('')
  // 컨텍스트 첨부는 **기본 꺼짐**이고 영속하지 않는다 — 원격 출력을 외부 API 로 보내는 동의를
  // 재시작 너머로 끌고 가지 않는다(설계 §3.2 · F12 세션 로그와 같은 판단).
  const [ctxOn, setCtxOn] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 마운트 시 전량 인계 + 스트림 구독. 패널을 닫으면 언마운트되지만 대화는 main 에 남는다.
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.ev?.ai
      .getState()
      .then((s) => {
        if (!alive) return
        setTurns([...s.turns])
        setHasKey(s.hasKey)
        setStreaming(s.streaming)
        setUsage(s.usage)
        setDropped(s.droppedTurns)
        setProvider(s.provider)
        setModel(s.model)
      })
      .catch(() => {})
    const offDelta = window.ev?.ai.onDelta(({ turnId, text }) => {
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, text: t.text + text } : t)))
    })
    const offEnd = window.ev?.ai.onEnd((e) => {
      setStreaming(false)
      setTurns((prev) =>
        prev.map((t) =>
          t.id === e.turnId
            ? { ...t, end: e.ok ? 'done' : e.reason === 'canceled' ? 'canceled' : 'error', ...(e.ok ? {} : e.reason === 'canceled' ? {} : { error: e.message }) }
            : t
        )
      )
      if (!e.ok && e.reason === 'noKey') setHasKey(false)
      // 사용량은 응답에 딸려 오므로 종료 때 한 번만 다시 읽는다(표시 전용 — 상한을 강제하지 않는다).
      void window.ev?.ai
        .getState()
        .then((s) => {
          setUsage(s.usage)
          setDropped(s.droppedTurns)
        })
        .catch(() => {})
    })
    return () => {
      alive = false
      offDelta?.()
      offEnd?.()
    }
  }, [open])

  // 새 델타가 붙으면 아래로 따라간다.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 첨부될 원문. **렌더러 마스킹은 미리보기용 이중 방어다** — 실제 방어선은 main 이 전송 직전에
  // 한 번 더 돌리는 같은 함수다(maskSecrets 는 멱등이라 두 결과가 글자 단위로 같다).
  const contextText = useCallback((): string | undefined => {
    if (!ctxOn || !session) return undefined
    const lines = tailLines(session.id, AI_CONTEXT_LINES)
    if (lines.length === 0) return undefined
    return maskSecrets(lines.join('\n'))
  }, [ctxOn, session])

  // 실제 전송 — draft 상태가 아니라 넘겨받은 텍스트로 보낸다. send()(컴포저 버튼)와 F17 부트스트랩의
  // autoSend 프리필이 이 함수 하나를 공유한다(두 번째 AI 전송 경로를 새로 만들지 않는다).
  // 반환값은 "실제로 보냈는지" — 호출측이 draft 를 지울지 말지 그걸로 결정한다.
  const sendText = useCallback(
    (text: string): boolean => {
      if (!text || streaming || !hasKey || !window.ev) return false
      const context = contextText()
      setCtxOpen(false)
      setStreaming(true)
      void window.ev.ai
        .send({ text, ...(context ? { context } : {}), ...(session ? { env: session.env } : {}) })
        .then(({ turnId }) =>
          // main 이 만든 두 턴(사용자 + 빈 답변)을 낙관적으로 그린다. 델타가 답변 턴에 붙는다.
          setTurns((prev) => [
            ...prev,
            { id: `${turnId}-u`, at: Date.now(), role: 'user', text, ...(context ? { context } : {}) },
            { id: turnId, at: Date.now(), role: 'assistant', text: '' }
          ])
        )
        .catch(() => setStreaming(false))
      return true
    },
    [streaming, hasKey, contextText, session]
  )

  const send = useCallback(() => {
    if (sendText(draft.trim())) setDraft('')
  }, [draft, sendText])

  // 우클릭 메뉴 [AI에게 질문] 프리필(또는 F17 부트스트랩의 autoSend). at 이 바뀔 때만 반응한다
  // (같은 문자열을 두 번 골라도 반영되게).
  const prefillAt = prefill?.at
  useEffect(() => {
    if (!open || !prefillAt || !prefill?.text) return
    if (prefill.autoSend) sendText(prefill.text.trim())
    else {
      setDraft(prefill.text)
      inputRef.current?.focus()
    }
    // prefill.text 는 at 과 함께 오므로 deps 에 at 만 둔다(같은 선택을 다시 골라도 갱신).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillAt])

  if (!open) return null

  const preview = ctxOn && ctxOpen ? contextText() : undefined
  const canAttach = session !== null

  return (
    <aside className="ai-panel" role="complementary" aria-label={t('ai.title')}>
      <div className="ai-head">
        <span className="ai-mark">
          <AraMark />
        </span>
        <span className="ai-name">{t('ai.title')}</span>
        {hasKey && (
          <span className="ai-active-badge" title={`${AI_PROVIDER_LABELS[provider]} · ${model}`}>
            {AI_PROVIDER_LABELS[provider]} · {model}
          </span>
        )}
        {onOpenBootstrap && (
          // F17 진입점 ②(① 파일 메뉴). 패널 상단 버튼 하나 — 새 표면을 만들지 않는다.
          <button
            type="button"
            className="ai-head-btn"
            data-action="ai.bootstrap.open"
            title={t('ai.bootstrap.title')}
            onClick={onOpenBootstrap}
          >
            {t('ai.bootstrap.btn')}
          </button>
        )}
        <button
          type="button"
          className="ai-head-btn"
          data-action="ai.clear"
          title={t('ai.clear.title')}
          onClick={() => {
            void window.ev?.ai.clear()
            setTurns([])
            setStreaming(false)
          }}
        >
          {t('ai.clear')}
        </button>
        <span className="ai-x" title={t('ai.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>

      <div className="ai-body" ref={bodyRef}>
        {!hasKey && (
          <div className="ai-card">
            <div className="ai-card-t">{t('ai.noKey.title')}</div>
            <div className="ai-card-d">
              {AI_PROVIDER_LABELS[provider]} {t('ai.noKey.desc.suffix')}
            </div>
            <button
              type="button"
              className="btn sec"
              data-action="ai.openSettings"
              /**
               * 설정 창은 MainArea 소유다. 새 배선을 만들지 않고 keymap 단일 소스가 아는
               * 그 단축키(Ctrl+,)를 그대로 쏜다 — "여기서만 되는 경로"가 생기지 않는다.
               *
               * 2026-08-23 준영님 제보: 설정에서 키를 넣고 돌아와도 이 안내가 그대로 남아 있었다.
               * 이 패널은 열릴 때 한 번만 상태를 읽기 때문이다(마운트 시 getState). 준영님 제안대로
               * **여기서 패널을 닫는다** — 다시 열면 그때 새로 읽으니 안내가 저절로 사라진다.
               * 상태를 밀어 넣는 새 채널을 만드는 것보다 이쪽이 작고, 화면 흐름과도 맞는다
               * (설정을 보러 가는 순간 이 카드는 볼 일이 없다).
               */
              onClick={() => {
                dispatchAction('settings.open')
                onClose()
              }}
            >
              {t('ai.noKey.btn')}
            </button>
          </div>
        )}
        {hasKey && turns.length === 0 && <div className="ai-empty">{t('ai.empty')}</div>}
        {/* #80: 예산 때문에 앞을 버렸으면 말해 준다. 조용히 버리면 "아까 얘기한 걸 왜 잊었지?"가
            되고, 사용자는 모델이 이상해진 줄 안다. 대화는 화면에 그대로 남아 있고 **보내지 않았을
            뿐**이라 목록 맨 위에 띠로 붙인다. */}
        {dropped > 0 && <div className="ai-dropped">{t('ai.dropped').replace('{n}', String(dropped))}</div>}
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} sessionId={session?.id ?? null} />
        ))}
        {/* 2026-08-23 제보: "응답이 오기 전까지 아무 애니메이션도 없다."
            첫 글자가 오면 그 글자가 곧 신호이므로, **아직 한 글자도 안 온 동안**만 보여 준다. */}
        {streaming && (turns[turns.length - 1]?.text ?? '') === '' && (
          <div className="ai-think" role="status" aria-label={t('ai.thinking')}>
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      <div className="ai-composer">
        <div className="ai-chips">
          <button
            type="button"
            className={'ai-chip' + (ctxOn ? ' on' : '')}
            data-action="ai.ctxToggle"
            aria-pressed={ctxOn}
            disabled={!canAttach}
            title={canAttach ? t('ai.ctx.title') : t('ai.noSession')}
            onClick={() => {
              const next = !ctxOn
              setCtxOn(next)
              setCtxOpen(next)
            }}
          >
            {ctxOn ? `${t('ai.ctx.on')} · ${AI_CONTEXT_LINES}${t('ai.ctx.lines')}` : t('ai.ctx.off')}
          </button>
          {ctxOn && (
            <button type="button" className="ai-chip ghost" data-action="ai.ctxPreview" onClick={() => setCtxOpen((v) => !v)}>
              {ctxOpen ? t('ai.ctx.hide') : t('ai.ctx.show')}
            </button>
          )}
        </div>
        {/* 보내기 전에도 첨부 전문을 눈으로 확인할 수 있다 — 이 텍스트가 main 이 실제로 보내는 텍스트다. */}
        {ctxOpen && <pre className="ai-ctx-full compose">{preview ?? t('ai.ctx.emptyBuf')}</pre>}
        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="ai-input"
            rows={2}
            value={draft}
            disabled={!hasKey}
            placeholder={hasKey ? t('ai.placeholder') : t('ai.placeholder.noKey')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 보내기 / Shift+Enter 줄바꿈. 여기서 멈추지 않으면 앱 단축키가 함께 발동한다.
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {streaming ? (
            <button type="button" className="btn sec" data-action="ai.stop" onClick={() => void window.ev?.ai.cancel()}>
              {t('ai.stop')}
            </button>
          ) : (
            <button type="button" className="btn" data-action="ai.send" disabled={!hasKey || !draft.trim()} onClick={send}>
              {t('ai.send')}
            </button>
          )}
        </div>
        <div className="ai-usage">
          {t('ai.usage')} · {t('ai.usage.in')} {usage.input.toLocaleString('ko-KR')} / {t('ai.usage.out')}{' '}
          {usage.output.toLocaleString('ko-KR')}
        </div>
      </div>
    </aside>
  )
}
