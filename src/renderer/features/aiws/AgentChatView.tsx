import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, ImageIcon, Send, SquareTerminal } from 'lucide-react'
import { mergeMessages, type ChatBlock, type ChatMessage } from '@shared/agentChat'
import { effortLabel, optionCommand, type ModelOption } from '@shared/agentOptions'
import type { AgentStatusView } from '@shared/agentHooks'
import { t } from '../../i18n'
import { loadMarkdown, Markdown } from '../../components/mdLazy'
import { registerPasteTarget } from '../../store/pasteFiles'
import { ChatComposer, useChatInput } from './ChatComposer'
import type { AgentTab } from './agentStore'
import { AgentAskCard } from './AgentAskCard'

/** 한 번에 그리는 메시지 수 — 위로 [이전 메시지] 를 누르면 이만큼 더(Orca 의 older-history 창). */
const PAGE = 200
/** 바닥에서 이만큼 안이면 "바닥에 붙어 있다" — 새 메시지가 오면 따라 내려간다. */
const STICK_PX = 48
/** 클립보드 캡처가 떨어지는 [받은 파일] 하위 폴더(아라 채팅은 'ara'). */
const PASTE_SUB = 'agent'

/**
 * M5 AI-13·12·17 — 실행 중인 Claude PTY 세션을 채팅으로 본다(Orca native-chat 의 "터미널 기반 채팅" 1차).
 * 기록은 main 이 transcript 를 꼬리 읽기로 따라가 민다(이 화면이 떠 있을 때만 감시). 입력은 PTY 로(첫 지시와 같은 괄호 붙여넣기).
 * 승인·질문 응답은 터미널 몫이다 — 막히면 띠로 알리고 [터미널로] 를 준다(구조화 채팅이 아니라서 버튼으로 답할 길이 없다).
 * R2: 맨 앞 `/` 를 치면 명령·스킬 목록(AI-16), Claude 는 모델·추론 강도 pill(AI-15 — 고르면 그 탭 CLI 에 `/model …`·`/effort …`).
 * 뺀 것(Orca): 편집 diff 카드·이미지 미리보기·찾기·메시지 레일·되감기·하위 에이전트 구역·`@` 파일 멘션·지금 모델 읽기(화면 판독).
 */
export function AgentChatView({ tab, cwd, status, onTerminal }: { tab: AgentTab; cwd: string; status: AgentStatusView | undefined; onTerminal: () => void }): JSX.Element {
  const sid = tab.sessionId
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [file, setFile] = useState<string | null | undefined>(undefined)
  const [shown, setShown] = useState(PAGE)
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // AI-16 `/` 목록·AI-17 첨부·초안은 아라 채팅과 같은 입력(ChatComposer).
  const { draft, setDraft, intake, inputRef } = useChatInput(sid, PASTE_SUB, setError)
  // AI-15 모델 pill(Claude) — 목록은 main 이 CLI 에 처음 한 번 묻고 기억한다.
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  useEffect(() => {
    if (tab.agent !== 'claude') return
    let alive = true
    void window.ev.agents.models(tab.agent).then((c) => alive && 'models' in c && setModels(c.models))
    return () => {
      alive = false
    }
  }, [tab.agent])
  const efforts = (models.find((m) => m.id === model) ?? models.find((m) => m.isDefault))?.efforts ?? []
  /** 실행 중인 탭 CLI 에 옵션 명령(Orca: 터미널 탭은 `/model …` 를 친다 — 입력 상자가 뜬 뒤, 승인 창이면 기다린다). */
  const applyOption = async (kind: 'model' | 'effort', value: string): Promise<void> => {
    const cmd = optionCommand(kind, value)
    if (!cmd || tab.exited) return
    const r = await window.ev.agents.chatSend(sid, tab.agent, cmd)
    if (!r.ok) setError(t('aiws.chat.sendFailed'))
  }

  // 감시는 이 화면이 떠 있는 동안만(main 이 파일 변경 이벤트 + 스로틀).
  useEffect(() => {
    void loadMarkdown()
    let alive = true
    let pending: { messages: ChatMessage[]; reset?: boolean }[] = []
    let ready = false
    const off = window.ev.agents.onChat((e) => {
      if (e.sessionId !== sid) return
      if (!ready) pending.push(e)
      else setMessages((cur) => mergeMessages(cur, e.messages, e.reset))
    })
    void window.ev.agents.chatOpen(sid).then((snap) => {
      if (!alive) return
      ready = true
      setFile(snap.file)
      setMessages(pending.reduce((cur, e) => mergeMessages(cur, e.messages, e.reset), snap.messages))
      pending = []
    })
    return () => {
      alive = false
      off()
      void window.ev.agents.chatClose(sid)
    }
  }, [sid])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // 붙여넣기(Ctrl+V) — 파일·캡처만 첨부로, 글은 입력칸 몫(false).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    return registerPasteTarget({
      el,
      allowEditable: true,
      onFiles: (files) => {
        if (!files.length) return false
        void intake(files)
        return true
      }
    })
  }, [intake])

  const send = async (text: string): Promise<boolean> => {
    if (!text.trim() || tab.exited) return false
    const r = await window.ev.agents.chatSend(sid, tab.agent, text)
    if (!r.ok) {
      setError(t('aiws.chat.sendFailed'))
      return false
    }
    setError(null)
    stick.current = true
    return true
  }

  const from = Math.max(0, messages.length - shown)
  const blocked = status?.state === 'blocked'
  return (
    <div
      ref={rootRef}
      className={'aiws-chat' + (dropping ? ' drag-over' : '')}
      data-aiws="chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        void intake([...e.dataTransfer.files])
      }}
    >
      <div
        ref={listRef}
        className="aiws-chat-list"
        role="log"
        aria-label={t('aiws.chat.log')}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
      >
        {from > 0 && (
          <button type="button" className="btn sec aiws-chat-older" onClick={() => setShown((n) => n + PAGE)}>
            {t('aiws.chat.older').replace('{n}', String(from))}
          </button>
        )}
        {messages.length === 0 && <p className="aiws-note aiws-chat-empty">{file === undefined ? t('aiws.chat.loading') : file ? t('aiws.chat.empty') : t('aiws.chat.noFile')}</p>}
        {messages.slice(from).map((m) => (
          <Row key={m.id} m={m} onTerminal={onTerminal} />
        ))}
      </div>
      {/* M11 질문/승인 카드(훅이 질문·승인 글을 준 막힘) — 없으면 예전처럼 '터미널에서 답하기' 줄. */}
      {blocked && status?.ask && !tab.exited && <AgentAskCard sessionId={sid} agent={tab.agent} ask={status.ask} onTerminal={onTerminal} />}
      {blocked && !status?.ask && (
        <div className="aiws-chat-blocked" role="status" data-aiws="chat-blocked">
          <span>{t('aiws.chat.blocked')}</span>
          <button type="button" className="btn sec" onClick={onTerminal}>
            {t('aiws.chat.toTerminal')}
          </button>
        </div>
      )}
      {status?.promptFailed && !blocked && (
        <p className="aiws-note aiws-err" role="alert" data-aiws="chat-not-delivered">
          {t('aiws.chat.notDelivered')}
        </p>
      )}
      {error && (
        <p className="aiws-note aiws-err" role="alert">
          {error}
        </p>
      )}
      <div className="aiws-chat-composer">
        {models.length > 0 && (
          <div className="aiws-chat-opts" data-aiws="chat-options">
            <label className="aiws-pill" title={t('aiws.opt.live.title')}>
              <span>{t('aiws.opt.model')}</span>
              <select
                data-aiws="chat-model"
                value={model}
                disabled={tab.exited}
                onChange={(e) => {
                  setModel(e.target.value)
                  if (e.target.value) void applyOption('model', e.target.value)
                }}
              >
                <option value="">{t('aiws.opt.unchanged')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id} title={m.description}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {efforts.length > 0 && (
              <label className="aiws-pill" title={t('aiws.opt.live.title')}>
                <span>{t('aiws.opt.effort')}</span>
                <select data-aiws="chat-effort" value="" disabled={tab.exited} onChange={(e) => e.target.value && void applyOption('effort', e.target.value)}>
                  <option value="">{t('aiws.opt.unchanged')}</option>
                  {efforts.map((v) => (
                    <option key={v} value={v}>
                      {effortLabel(v)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          inputRef={inputRef}
          onSubmit={send}
          slashAgent={tab.agent}
          slashCwd={cwd}
          disabled={tab.exited}
          placeholder={t('aiws.chat.placeholder')}
          rows={3}
          cls={{ row: 'aiws-chat-row', input: 'aiws-input aiws-chat-input', send: 'btn pri aiws-chat-send' }}
          sendIcon={<Send />}
          sendLabel={t('aiws.chat.send')}
        />
        <span className="aiws-note aiws-chat-hint">{t('aiws.chat.hint')}</span>
      </div>
    </div>
  )
}

const Row = memo(function Row({ m, onTerminal }: { m: ChatMessage; onTerminal: () => void }): JSX.Element {
  return (
    <div className={'aiws-chat-msg ' + m.role} data-role={m.role}>
      {m.blocks.map((b, i) => (
        <Block key={i} b={b} role={m.role} onTerminal={onTerminal} />
      ))}
    </div>
  )
})

function Block({ b, role, onTerminal }: { b: ChatBlock; role: ChatMessage['role']; onTerminal: () => void }): JSX.Element {
  if (b.type === 'text') return role === 'assistant' ? <Markdown text={b.text} /> : <div className="aiws-chat-text">{b.text}</div>
  if (b.type === 'image')
    return (
      <span className="aiws-chat-chip">
        <ImageIcon aria-hidden />
        {t('aiws.chat.image')}
      </span>
    )
  if (b.type === 'question')
    return (
      <div className="aiws-chat-question" data-aiws="chat-question">
        {b.questions.map((q, i) => (
          <p key={i}>{q}</p>
        ))}
        {b.answered ? (
          <span className="aiws-note">{t('aiws.chat.answered')}</span>
        ) : (
          <button type="button" className="btn sec" onClick={onTerminal}>
            <SquareTerminal aria-hidden />
            {t('aiws.chat.answerInTerminal')}
          </button>
        )}
      </div>
    )
  return (
    <details className={'aiws-chat-tool' + (b.error ? ' err' : '')} data-tool={b.name}>
      <summary>
        <ChevronRight className="aiws-chat-caret" aria-hidden />
        <b>{b.name}</b>
        <span className="aiws-mono">{b.summary}</span>
        {b.result === undefined && <span className="aiws-note">{t('aiws.chat.running')}</span>}
      </summary>
      {b.result !== undefined && <pre className="aiws-mono">{b.result || t('aiws.chat.noOutput')}</pre>}
    </details>
  )
}
