import { memo, useEffect, useRef, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronRight, ImageIcon, SquareTerminal } from 'lucide-react'
import { fmtDuration, mergeMessages, nearBottom, type ChatBlock, type ChatMessage } from '@shared/agentChat'
import { effortLabel, optionCommand, type ModelOption } from '@shared/agentOptions'
import type { AgentStatusView } from '@shared/agentHooks'
import { AGENTS } from '@shared/agents'
import { t } from '../../i18n'
import { loadMarkdown, Markdown } from '../../components/mdLazy'
import { registerPasteTarget } from '../../store/pasteFiles'
import { ChatComposer, useChatInput } from './ChatComposer'
import type { AgentTab } from './agentStore'
import { AgentAskCard } from './AgentAskCard'
import { AccountSwitchCard } from './AccountSwitch'
import { AgentGlyph } from './AgentGlyph'
import '../../styles/agentChat.css'

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
 * 모양 = 시안 A 문서형(mockups/v3/chat/A.html · styles/agentChat.css): 가운데 열, 이름줄, 도구는 한 줄 각주.
 * 시안의 이름줄 모델·시각, 도구 줄 결과 요약(`+18 −11` · `3/4 통과 · 12.4s`)은 transcript 블록에 그 값이 없어 뺐다 — 오른쪽엔 실행 중/오류만.
 */
export function AgentChatView({ tab, cwd, status, onTerminal }: { tab: AgentTab; cwd: string; status: AgentStatusView | undefined; onTerminal: () => void }): JSX.Element {
  const sid = tab.sessionId
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [file, setFile] = useState<string | null | undefined>(undefined)
  const [shown, setShown] = useState(PAGE)
  const [dropping, setDropping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** 바닥에 붙어 있다 — 열 때(탭 전환도 key 로 다시 마운트) true. 사용자가 위로 올리면 false. */
  const stick = useRef(true)
  /** 스크롤바·글을 마우스로 잡고 있는 동안은 스크롤을 건드리지 않는다. */
  const holding = useRef(false)
  /** 위로 올라가 있는 동안 새 내용이 왔다 — [↓ 새 내용]. */
  const [unseen, setUnseen] = useState(false)
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

  // 바닥 따라가기 — 내용 높이가 바뀔 때마다(새 메시지·마크다운 늦은 로드·도구 결과·입력칸 높이) 붙어 있을 때만 맨 아래로.
  // 예전엔 [messages] 때 한 번만 맞췄는데, 줄마다 content-visibility 추정 높이(80px)였다가 그려지면서 실제 높이로 바뀌어
  // 맞춘 뒤에 scrollHeight 가 자라 중간에 멈췄다(열 때 애매한 위치) — 스크롤바를 끌 때도 지나가는 줄이 커져 손잡이가 튀었다.
  useEffect(() => {
    const el = listRef.current
    const flow = flowRef.current
    if (!el || !flow) return
    const follow = (): void => {
      if (stick.current && !holding.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(follow)
    ro.observe(flow)
    ro.observe(el)
    const release = (): void => {
      if (!holding.current) return
      holding.current = false
      // 잡고 있던 동안 끌어 움직였다면 onScroll 이 stick 을 이미 바꿨다 — 그대로 두고, 붙어 있었으면 그동안 쌓인 만큼 따라간다.
      follow()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      ro.disconnect()
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])

  useEffect(() => {
    if (!stick.current && messages.length) setUnseen(true)
  }, [messages])

  const toBottom = (): void => {
    const el = listRef.current
    stick.current = true
    setUnseen(false)
    if (el) el.scrollTop = el.scrollHeight
  }

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
    toBottom()
    return true
  }

  const from = Math.max(0, messages.length - shown)
  const blocked = status?.state === 'blocked'
  const working = status?.state === 'working' && !tab.exited
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
        onPointerDown={() => (holding.current = true)}
        onScroll={(e) => {
          stick.current = nearBottom(e.currentTarget, STICK_PX)
          if (stick.current) setUnseen(false)
        }}
      >
        <div ref={flowRef} className="aiws-chat-flow">
          {from > 0 && (
            <button type="button" className="btn sec aiws-chat-older" onClick={() => setShown((n) => n + PAGE)}>
              {t('aiws.chat.older').replace('{n}', String(from))}
            </button>
          )}
          {messages.length === 0 && <p className="aiws-note aiws-chat-empty">{file === undefined ? t('aiws.chat.loading') : file ? t('aiws.chat.empty') : t('aiws.chat.noFile')}</p>}
          {messages.slice(from).map((m, i, list) => (
            <Row key={m.id} m={m} who={m.role === 'system' || list[i - 1]?.role === m.role ? undefined : m.role === 'user' ? t('aiws.chat.me') : AGENTS[tab.agent].label} onTerminal={onTerminal} />
          ))}
          {/* 터미널 탭 머리와 같은 도는 고리(AgentGlyph) — 마지막 메시지 뒤, 일하는 동안만. */}
          {working && (
            <div className="aiws-chat-working" role="status" data-aiws="chat-working">
              <AgentGlyph display="working" estimated={!!status?.estimated} />
              <span>{t('aiws.chat.working')}</span>
            </div>
          )}
        </div>
        {unseen && (
          <button type="button" className="btn sec aiws-chat-new" data-aiws="chat-new" onClick={toBottom}>
            <ArrowDown aria-hidden />
            {t('aiws.chat.newBelow')}
          </button>
        )}
      </div>
      {/* M11 질문/승인 카드(훅이 질문·승인 글을 준 막힘) — 없으면 예전처럼 '터미널에서 답하기' 줄. */}
      {blocked && status?.ask && !tab.exited && <AgentAskCard sessionId={sid} agent={tab.agent} ask={status.ask} onTerminal={onTerminal} />}
      {/* R0 한도에 걸리면 다른 계정으로 이어서(목업 5-switch A 카드). */}
      <AccountSwitchCard tab={tab} />
      {blocked && !status?.ask && (
        <div className="aiws-chat-blocked" role="status" data-aiws="chat-blocked">
          <span className="ag-ask-chip">{t('aiws.ask.turn')}</span>
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
        {/* 칸 하나(.aiws-chat-box, grid) — 글 · 첨부 · 모델 pill | 보내기. ChatComposer 의 줄(.aiws-chat-row)은 display: contents. */}
        <div className="aiws-chat-box">
          <ChatComposer
            draft={draft}
            setDraft={setDraft}
            inputRef={inputRef}
            onSubmit={send}
            slashAgent={tab.agent}
            slashCwd={cwd}
            disabled={tab.exited}
            placeholder={t('aiws.chat.placeholder')}
            rows={2}
            cls={{ row: 'aiws-chat-row', input: 'aiws-input aiws-chat-input', send: 'btn pri aiws-chat-send' }}
            sendIcon={<ArrowUp />}
            sendLabel={t('aiws.chat.send')}
          />
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
        </div>
        <span className="aiws-note aiws-chat-hint">{t('aiws.chat.hint')}</span>
      </div>
    </div>
  )
}

/** who = 이름줄(같은 쪽 말이 이어지면 첫 조각에만 — 그때만 .head). */
const Row = memo(function Row({ m, who, onTerminal }: { m: ChatMessage; who?: string; onTerminal: () => void }): JSX.Element {
  return (
    <div className={'aiws-chat-msg ' + m.role + (who ? ' head' : '')} data-role={m.role}>
      {who && <div className="aiws-chat-who">{who}</div>}
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
      <div className={b.answered ? 'aiws-chat-asked' : 'aiws-chat-question'} data-aiws="chat-question">
        {b.questions.map((q, i) => (
          <p key={i}>{q}</p>
        ))}
        {b.answered ? (
          <span className="aiws-chat-answered">
            <Check aria-hidden />
            {t('aiws.chat.answered')}
          </span>
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
        <b className="aiws-chat-tool-vb">{b.name}</b>
        <span className="aiws-mono">{b.summary}</span>
        <ToolRs b={b} />
      </summary>
      {b.result !== undefined && <pre className="aiws-mono">{b.result || t('aiws.chat.noOutput')}</pre>}
    </details>
  )
}

/** 도구 줄 오른쪽 — 실행 중… / 오류 / 줄 수·테스트·소요 시간(있는 것만). */
function ToolRs({ b }: { b: Extract<ChatBlock, { type: 'tool' }> }): JSX.Element | null {
  if (b.result === undefined) return <span className="aiws-chat-tool-rs">{t('aiws.chat.running')}</span>
  if (b.error) return <span className="aiws-chat-tool-rs">{t('aiws.chat.toolError')}</span>
  const dur = b.ms === undefined ? null : fmtDuration(b.ms)
  const edit = b.add !== undefined || b.del !== undefined
  if (!dur && !edit && !b.tests) return null
  return (
    <span className="aiws-chat-tool-rs">
      {edit && (
        <>
          <span className="p">+{b.add ?? 0}</span>
          {!!b.del && <span className="m"> −{b.del}</span>}
        </>
      )}
      {b.tests && <span className={b.tests.pass === b.tests.total ? 'p' : 'm'}>{t('aiws.chat.testsPassed').replace('{pass}', String(b.tests.pass)).replace('{total}', String(b.tests.total))}</span>}
      {dur && <span className="d">{dur}</span>}
    </span>
  )
}
