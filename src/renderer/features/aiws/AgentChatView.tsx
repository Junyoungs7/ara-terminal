import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, ImageIcon, Paperclip, Send, SquareTerminal, X } from 'lucide-react'
import { composeChatText, mergeMessages, type ChatBlock, type ChatDraft, type ChatMessage } from '@shared/agentChat'
import type { AgentStatusView } from '@shared/agentHooks'
import { t } from '../../i18n'
import { loadMarkdown, Markdown } from '../../components/mdLazy'
import { saveClipFile } from '../../components/AraChatPanel'
import { filePaths, registerPasteTarget } from '../../store/pasteFiles'
import { readDraft, writeDraft } from './chatDraft'
import type { AgentTab } from './agentStore'

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
 * 뺀 것(Orca): 편집 diff 카드·이미지 미리보기·찾기·메시지 레일·슬래시 자동완성(AI-16)·모델 고르기(AI-15)·되감기·하위 에이전트 구역.
 */
export function AgentChatView({ tab, status, onTerminal }: { tab: AgentTab; status: AgentStatusView | undefined; onTerminal: () => void }): JSX.Element {
  const sid = tab.sessionId
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [file, setFile] = useState<string | null | undefined>(undefined)
  const [shown, setShown] = useState(PAGE)
  const [draft, setDraftState] = useState<ChatDraft>(() => readDraft(sid))
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  const setDraft = useCallback(
    (f: (d: ChatDraft) => ChatDraft) =>
      setDraftState((d) => {
        const next = f(d)
        writeDraft(sid, next)
        return next
      }),
    [sid]
  )

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

  const intake = useCallback(
    async (files: readonly File[]): Promise<void> => {
      const paths = filePaths(files)
      for (const f of files) {
        if (window.ev.app.pathForFile(f)) continue
        const r = await saveClipFile(f, PASTE_SUB)
        if ('path' in r) paths.push(r.path)
        else setError(r.error)
      }
      if (paths.length) setDraft((d) => ({ ...d, files: [...d.files, ...paths.filter((p) => !d.files.includes(p))] }))
      inputRef.current?.focus()
    },
    [setDraft]
  )

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

  const send = async (): Promise<void> => {
    const text = composeChatText(draft.text, draft.files)
    if (!text.trim() || tab.exited) return
    const r = await window.ev.agents.chatSend(sid, tab.agent, text)
    if (!r.ok) return setError(t('aiws.chat.sendFailed'))
    setError(null)
    stick.current = true
    setDraft(() => ({ text: '', files: [] }))
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
      {blocked && (
        <div className="aiws-chat-blocked" role="status" data-aiws="chat-blocked">
          <span>{t('aiws.chat.blocked')}</span>
          <button type="button" className="btn sec" onClick={onTerminal}>
            {t('aiws.chat.toTerminal')}
          </button>
        </div>
      )}
      {error && (
        <p className="aiws-note aiws-err" role="alert">
          {error}
        </p>
      )}
      <div className="aiws-chat-composer">
        {draft.files.length > 0 && (
          <div className="aiws-chat-files" data-aiws="chat-files">
            {draft.files.map((f) => (
              <span key={f} className="aiws-chat-file" title={f}>
                <Paperclip aria-hidden />
                <span>{f.split(/[\\/]/).pop()}</span>
                <button type="button" className="aiws-ic" aria-label={t('aiws.chat.detach')} onClick={() => setDraft((d) => ({ ...d, files: d.files.filter((x) => x !== f) }))}>
                  <X />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="aiws-chat-row">
          <textarea
            ref={inputRef}
            className="aiws-input aiws-chat-input"
            data-aiws="chat-input"
            rows={3}
            placeholder={t('aiws.chat.placeholder')}
            disabled={tab.exited}
            value={draft.text}
            onChange={(e) => {
              const text = e.target.value
              setDraft((d) => ({ ...d, text }))
            }}
            onKeyDown={(e) => {
              // Enter = 보내기, Shift+Enter = 줄바꿈. 한글 조합 중 Enter 는 조합 끝내기다.
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              void send()
            }}
          />
          <button type="button" className="btn pri aiws-chat-send" data-aiws="chat-send" aria-label={t('aiws.chat.send')} title={t('aiws.chat.send')} disabled={tab.exited || !composeChatText(draft.text, draft.files).trim()} onClick={() => void send()}>
            <Send />
          </button>
        </div>
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
