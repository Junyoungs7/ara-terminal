import { useCallback, useEffect, useRef, useState } from 'react'
import type { AraChatEvent } from '../../main/ai/AraChat'
import type { AraChatRow } from '../../main/ai/araChats'
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
import { IconClose, IconRefresh, IconHistory, IconPencil, IconPlus } from './icons'
import { Markdown } from './md'
import { ARA_MODELS, araModelLabel } from '@shared/aiModels'
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
  const [home, setHome] = useState(false)
  // 어느 엔진으로 열려 있나(#126). **늘 보인다** — 돈도 능력도 다르다.
  const [engine, setEngine] = useState<'cli' | 'api'>('cli')
  const [cost, setCost] = useState<{ usd: number; turns: number } | null>(null)
  // #136 계획 먼저 — 켜면 아라가 **아무것도 건드리지 않고** 계획만 낸다(실측으로 확인한 모드).
  // planReady = 그 계획이 나왔다(턴이 끝났다) → 승인 줄을 세운다.
  const [planOn, setPlanOn] = useState(false)
  // #137 고른 모델. 빈 문자열 = 사용자의 ~/.claude 기본값.
  const [model, setModel] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  // #137 폭. 고정 360px 이 좁다는 제보 — 왼쪽 가장자리를 끌어 넓힌다(세션 동안 유지).
  const [width, setWidth] = useState(360)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const [planReady, setPlanReady] = useState(false)
  // 사건 처리기는 한 번만 붙으므로(deps []) 최신 값을 ref 로 본다.
  const planOnRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [openTools, setOpenTools] = useState<Set<string>>(new Set())
  // 남은 시간을 초 단위로 다시 그리기 위한 시계(되묻기 카드가 열려 있을 때만 돈다).
  const [now, setNow] = useState(Date.now())
  const bodyRef = useRef<HTMLDivElement>(null)
  /**
   * 지난 대화(2026-08-26 준영님 요청). Claude Code 의 `--resume` 목록을 우리 화면으로 가져온 것 —
   * 기록은 그쪽 것을 읽기만 하고, **이름만 우리가 저장한다**(CLI 에는 대화 이름이 없다).
   */
  const [chatsOpen, setChatsOpen] = useState(false)
  const [chats, setChats] = useState<AraChatRow[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const loadChats = async (): Promise<void> => {
    const r = await window.ev?.ara.chats().catch(() => null)
    setChats(r?.items ?? [])
  }
  // 지금 이어 가는 대화 id — 목록에서 그 줄을 표시한다(어디에 있는지 모르면 목록이 미궁이 된다).
  const [resumeId, setResumeId] = useState<string | null>(null)
  /**
   * 그 대화를 이어서 연다. 지금 대화는 닫히고 그쪽 기록 위에서 다시 시작한다.
   *
   * **그 대화의 엔진으로 연다**(2026-08-26): API 로 하던 대화를 CLI 로 열면 문맥이 통째로 없는
   * 새 대화가 되는데, 사용자는 "이어졌다"고 믿는다. 기록이 어느 쪽에 있는지는 목록이 안다.
   */
  const resume = async (row: AraChatRow): Promise<void> => {
    setChatsOpen(false)
    setPhase('opening')
    setResumeId(row.id)
    /**
     * **지난 말들을 먼저 그린다**(2026-08-26 제보: *"클릭하면 여전히 아무것도 안나와"*).
     *
     * `--resume` 은 CLI 가 문맥을 이어받는 것이지 지난 메시지를 다시 보내 주지 않는다. 그래서
     * 아라는 앞 얘기를 아는데 화면만 비어 있었다 — 사용자 눈에는 "안 열렸다" 다. 기록은 파일에
     * 그대로 있으니 우리가 읽어 채운다.
     */
    const log = await window.ev?.ara.chatLog(row.id).catch(() => null)
    setItems(
      (log?.items ?? []).reduce<ChatItem[]>(
        (acc, m) => (m.role === 'user' ? pushMine(acc, m.text) : reduceChat(reduceChat(acc, { t: 'text', text: m.text }), { t: 'turn', costUsd: null, ms: 0, turns: 0, text: '' })),
        []
      )
    )
    await window.ev?.ara.open({ resumeId: row.id, engine: row.engine, ...(row.engine === 'cli' && cwd ? { cwd } : {}), active })
  }
  /** 새 대화 — 이어 가던 것을 놓고 빈 판에서 시작한다(resumeId 없이 다시 연다). */
  const newChat = async (): Promise<void> => {
    setChatsOpen(false)
    setItems([])
    setResumeId(null)
    setPhase('opening')
    await window.ev?.ara.open({ ...(cwd ? { cwd } : {}), engine, active })
  }
  const saveName = async (id: string, name: string): Promise<void> => {
    setRenaming(null)
    await window.ev?.ara.renameChat(id, name).catch(() => {})
    await loadChats()
  }
  const openChats = async (): Promise<void> => {
    if (chatsOpen) {
      setChatsOpen(false)
      return
    }
    await loadChats()
    setChatsOpen(true)
  }
  const askRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ask = openAsk(items)

  // 엔진 사건 → 목록. 상태줄에 쓰는 것(비용·단계)은 따로 뽑는다.
  useEffect(() => {
    const off = window.ev?.ara.onEvent((e: AraChatEvent) => {
      if (e.t === 'opened') {
        setCwd(e.cwd)
        // 아라 폴더(고를 것이 없어 떨어진 자리)는 **경로를 감춘다** — `%APPDATA%/ara/ara-home` 은
        // 사람에게 아무것도 알려 주지 않는다(2026-08-25 준영님). 대신 버튼은 남긴다:
        // 감추면서 누를 자리까지 없애면 폴더를 바꿀 길이 사라진다.
        setHome(e.home === true)
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
      if (e.t === 'model') {
        setModel(e.model)
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

  /**
   * 새 줄이 오면 아래로 붙인다 — 사람이 위로 올려 읽는 중이면 건드리지 않는다.
   *
   * **매번 거리를 재면 안 된다**(2026-08-26 준영님 제보: *"응답이 오면 채팅 스크롤이 자동으로
   * 내려가게 상용 서비스처럼"*). 전에는 그릴 때마다 `바닥까지 80px 이내인가`를 봤는데, 표나 코드
   * 블록이 한 번에 80px 넘게 들어오면 그 순간 조건이 깨지고 **그 뒤로 영영 안 따라간다.** 답이
   * 길수록 확실히 어긋나서 "긴 답일수록 안 내려간다"가 됐다.
   *
   * 그래서 거리가 아니라 **의사**를 기억한다: 사람이 스크롤을 움직였을 때만 붙어 있을지 정하고,
   * 그 사이 내용이 얼마나 늘어나든 그 결정을 지킨다. 우리가 내리는 것도 scroll 이벤트를 내지만
   * 그때는 바닥이라 붙어 있음이 유지된다.
   */
  const stick = useRef(true)
  const onBodyScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    const el = bodyRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
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

  // 끄는 동안 창 전체가 텍스트를 잡지 않게 window 에 붙인다(패널 밖으로 나가도 따라온다).
  const onDragDown = (e: React.MouseEvent): void => {
    drag.current = { x: e.clientX, w: width }
    const move = (ev: MouseEvent): void => {
      const d = drag.current
      if (!d) return
      // 왼쪽으로 끌면 넓어진다. 320 아래로는 글이 읽히지 않고, 화면의 3/4 를 넘으면 터미널이 죽는다.
      setWidth(Math.max(320, Math.min(Math.round(window.innerWidth * 0.75), d.w + (d.x - ev.clientX))))
    }
    const up = (): void => {
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 닫혀도 **컴포넌트는 살아 있다**(대화 목록·엔진 유지). 훅 뒤에서 그리기만 접는다.
  if (!open) return null

  return (
    <div className="ara-panel" onKeyDown={onKey} style={{ width, flexBasis: width }}>
      {/* 폭 조절 손잡이 — 왼쪽 가장자리. 사이드바 리사이저와 같은 자리·같은 동작이다. */}
      <div className="ara-grip" onMouseDown={onDragDown} title={t('ara.width')} />
      <div className="ara-hd">
        <span className="t">{t('ara.title')}</span>
        {/* 폴더는 **묻지 않는다**(2026-08-25) — 늘 어딘가에서 돌고, 여기를 누르면 바꾼다.
            아라를 특정 폴더에 매어 두는 물건으로 만들지 않기 위해서다. */}
        {cwd && (
          <button
            type="button"
            className={'cwd' + (home ? ' home' : '')}
            title={home ? t('ara.cwd.change') : `${t('ara.cwd.change')}\n${cwd}`}
            onClick={() => void pickFolder()}
          >
            {home ? t('ara.cwd.pick') : cwd}
          </button>
        )}
        {/* 지난 대화(2026-08-26). 아이콘만 두니 무엇인지 안 읽혔다(준영님: *"잘 보이지않는데"*) —
            **글자로 쓴다.** 좁은 레일이라도 이 버튼은 이름값을 한다. */}
        {/* 새 대화(2026-08-26 준영님 요청). 이어 가던 것을 놓고 **빈 판**에서 시작한다 —
            resumeId 를 비우고 다시 여는 것이 전부다. */}
        <button type="button" className="ara-hist" title={t('ara.chats.new')} data-action="ara.chats.new" onClick={() => void newChat()}>
          <IconPlus />
          <span>{t('ara.chats.new')}</span>
        </button>
        <button type="button" className="ara-hist" title={t('ara.chats')} data-action="ara.chats" onClick={() => void openChats()}>
          <IconHistory />
          <span>{t('ara.chats')}</span>
        </button>
        <button type="button" className="ara-ic" title={t('ara.restart')} onClick={() => void start({ ...(cwd ? { cwd } : {}), engine })}>
          <IconRefresh />
        </button>
        <button type="button" className="ara-ic" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {chatsOpen && (
        /**
         * **팝업으로 띄운다**(2026-08-26 준영님: *"대화창에서 뜨지 말고 팝업으로 선택하게"*).
         *
         * 처음엔 패널 머리 아래에 펼쳤는데 좁은 레일에서 대화를 밀어내며 반쪽만 보였다 — 고르는
         * 화면이 고를 것을 가리면 안 된다. 화면 가운데 창으로 띄우면 목록이 한눈에 들어온다.
         *
         * 고르면 **그 대화를 이어서 연다**(`--resume`). 이름을 붙이면 목록에 그 이름이 뜬다
         * (안 붙이면 첫 질문이 제목이다).
         */
        <div
          className="overlay open dlg-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChatsOpen(false)
          }}
        >
          <div className="modal ara-chats" role="dialog" aria-modal="true" aria-label={t('ara.chats')} data-field="ara.chats">
            <div className="modal-hd">
              <span>{t('ara.chats')}</span>
              <button type="button" className="ara-ic" title={t('mon.close')} onClick={() => setChatsOpen(false)}>
                <IconClose />
              </button>
            </div>
            <div className="ac-list">
              {chats.length === 0 && <div className="ac-empty">{t('ara.chats.none')}</div>}
              {chats.map((c) => (
                <div className={'ac-row' + (c.id === resumeId ? ' on' : '')} key={c.id} data-chat={c.id}>
                  {renaming === c.id ? (
                    <input
                      className="ac-name"
                      defaultValue={c.name}
                      autoFocus
                      placeholder={t('ara.chats.name')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveName(c.id, (e.target as HTMLInputElement).value)
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={(e) => void saveName(c.id, e.target.value)}
                    />
                  ) : (
                    <>
                      <button type="button" className="ac-open" title={t('ara.chats.resume')} onClick={() => void resume(c)}>
                        {/* 줄머리 태그 — 사이드바의 SSH·RDP 배지와 같은 모양이다(2026-08-26 준영님:
                            *"ssh, rdp처럼 태그를 만들어서 구분"*). 엔진을 섞어 쓰는 것보다 **어느
                            쪽 대화인지 한눈에 아는 것**이 낫다는 판단이다. */}
                        <span className={'sess-type ' + (c.engine === 'api' ? 'api' : 'cc')}>
                          {c.engine === 'api' ? 'API' : 'CC'}
                        </span>
                        <span className="ac-txt">
                          <span className="ac-t">{c.name || c.title || t('ara.chats.untitled')}</span>
                          <span className="ac-at">{new Date(c.at).toLocaleString()}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ara-ic sm"
                        title={t('ara.chats.rename')}
                        data-action="ara.chats.rename"
                        onClick={() => setRenaming(c.id)}
                      >
                        {/* 크기는 `.ara-ic svg`(13px)가 정한다. 탐색기 [이름 바꾸기]와 같은 그림. */}
                        <IconPencil />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="ara-body" ref={bodyRef} onScroll={onBodyScroll}>
        {items.map((it) =>
          it.k === 'me' ? (
            <div className="ara-me" key={it.id}>
              {it.text}
            </div>
          ) : it.k === 'ai' ? (
            <div className="ara-ai" key={it.id}>
              <Markdown text={it.text} />
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

        {/* 도는 동안 **목록 맨 아래**에서 점이 움직인다(2026-08-25 준영님: "돌아가는지 모르겠다").
            상태줄 글자만으로는 눈에 안 걸린다 — 답이 흘러나오는 그 자리에 있어야 보인다. */}
        {phase === 'working' && (
          <div className="ara-think" aria-label={t('ara.phase.working')}>
            <i />
            <i />
            <i />
          </div>
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
        {/* 메타 줄 — 무엇으로 도는지·무슨 모델인지·계획 먼저인지, 그리고 비용.
            **입력칸 위**다: ChatGPT·Claude 가 모델 고르기를 입력 근처에 두는 것과 같은 자리다. */}
        <div className="ara-bar">
          {/* 엔진 스위치 — claude 가 없으면 main 이 알아서 API 로 넘기고 여기가 그쪽으로 옮겨져 있다. */}
          <button
            type="button"
            className={'ara-chip eng' + (engine === 'api' ? ' on' : '')}
            aria-pressed={engine === 'api'}
            title={t(engine === 'api' ? 'ara.engine.tip.api' : 'ara.engine.tip.cli')}
            onClick={() => void start({ ...(cwd ? { cwd } : {}), engine: engine === 'api' ? 'cli' : 'api' })}
          >
            {t(engine === 'api' ? 'ara.engine.api' : 'ara.engine.cli')}
          </button>

          {/* #137 모델 고르기 — **도는 중에 바뀐다**(실측: set_model 이 먹는다). API 키 모드에는
              이 스위치가 없다: 그쪽 모델은 설정 [AI] 에서 고르고, 여기서 또 고르면 두 자리가 된다. */}
          {engine === 'cli' && (
            <div className="ara-model">
              <button
                type="button"
                className={'ara-chip' + (model ? ' on' : '')}
                aria-expanded={modelOpen}
                title={t('ara.model.tip')}
                onClick={() => setModelOpen((v) => !v)}
              >
                {araModelLabel(model)}
              </button>
              {modelOpen && (
                <div className="ara-menu" role="menu">
                  {ARA_MODELS.map((m) => (
                    <button
                      type="button"
                      key={m.id || 'default'}
                      className={m.id === model ? 'on' : ''}
                      data-model={m.id || 'default'}
                      onClick={() => {
                        setModelOpen(false)
                        void window.ev?.ara.model(m.id)
                      }}
                    >
                      <span className="l">{m.label}</span>
                      <span className="h">{m.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className={'ara-chip plan' + (planOn ? ' on' : '')}
            aria-pressed={planOn}
            title={t('ara.plan.tip')}
            onClick={() => void window.ev?.ara.planMode(!planOn)}
          >
            {t('ara.plan')}
          </button>
          <span className="sp" />
          {cost && (
            <span className="c">
              ${cost.usd.toFixed(3)} · {t('ara.turns').replace('{n}', String(cost.turns))}
            </span>
          )}
        </div>

        {/* 입력칸 — **보내기·중지 버튼이 같은 줄 안**에 있다(2026-08-25 준영님, 상용 서비스 배치).
            도는 중에는 같은 버튼이 [중지]가 된다: 자리를 옮기면 눈이 그때마다 버튼을 다시 찾는다. */}
        <div className={'ara-box' + (CAN_TYPE.has(phase) ? '' : ' off')}>
          <textarea
            ref={inputRef}
            className="ara-input"
            rows={1}
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
          <button
            type="button"
            className={'ara-send' + (phase === 'working' ? ' stop' : '')}
            disabled={phase === 'working' ? false : draft.trim() === '' || !CAN_TYPE.has(phase)}
            title={t(phase === 'working' ? 'ara.stop' : 'ara.send')}
            aria-label={t(phase === 'working' ? 'ara.stop' : 'ara.send')}
            onClick={() => {
              if (phase === 'working') void window.ev?.ara.interrupt()
              else if (ask) answer(ask.askId, draft.trim() || '(빈 답)')
              else send(draft)
            }}
          >
            {phase === 'working' ? (
              <svg viewBox="0 0 16 16" aria-hidden>
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M8 13V3M8 3L4 7M8 3l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
        {/* 상태는 입력칸 아래 아주 얇게 — 늘 보이되 자리를 거의 안 먹는다. */}
        <div className="ara-st">
          <span className={'ara-dot' + (phase === 'working' ? ' run' : phase === 'closed' ? ' off' : '')} />
          {t('ara.phase.' + phase)}
        </div>
      </div>
    </div>
  )
}
