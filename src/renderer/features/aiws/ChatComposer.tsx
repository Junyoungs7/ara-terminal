import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { Paperclip, X } from 'lucide-react'
import { composeChatText, type ChatDraft } from '@shared/agentChat'
import { filterSlash, slashQuery, type SlashItem } from '@shared/agentOptions'
import type { AgentId } from '@shared/agents'
import { t } from '../../i18n'
import { clipFileName } from '../../store/araChatItems'
import { filePaths } from '../../store/pasteFiles'
import { joinPath } from '../../components/filePath'
import { readDraft, writeDraft } from './chatDraft'

/**
 * M5 채팅 입력(AI-16 `/` 목록·AI-17 첨부·초안) — 에이전트 탭 채팅과 아라 채팅이 **같은 입력**을 쓴다(M5 R3).
 * 엔진은 각자다: 에이전트 탭은 PTY, 아라는 숨은 `claude -p`/API 엔진. 여기는 글·첨부를 모아 onSubmit 에 넘길 뿐이다.
 */

/**
 * 경로 없는 파일(= 클립보드 캡처)을 [받은 파일]/<sub> 에 떨구고 그 경로를 돌려준다.
 * 넘기는 것은 **경로**라(에이전트·아라가 자기 도구로 읽는다) 캡처는 실체가 있어야 한다.
 */
export async function saveClipFile(f: File, sub: string): Promise<{ path: string } | { error: string }> {
  const fail = (why?: string): { error: string } => ({ error: why ? `${t('ara.drop.failed')} — ${why}` : t('ara.drop.failed') })
  const dir = await window.ev?.fs.downloadsDir().catch(() => '')
  if (!dir) return fail()
  const name = clipFileName(f.name, Date.now())
  const bytes = new Uint8Array(await f.arrayBuffer())
  const r = await window.ev?.fs.saveBytes({ dir, sub, name, bytes }).catch(() => null)
  if (!r?.ok) return fail(r?.message)
  return { path: joinPath(joinPath(dir, sub), name) }
}

/** 초안(localStorage, key 별) + 첨부 받기. 끌어다 놓기·붙여넣기 등록은 화면마다 자리가 달라 부르는 쪽이 한다. */
export function useChatInput(
  key: string,
  pasteSub: string,
  onError: (message: string) => void
): {
  draft: ChatDraft
  setDraft: (f: (d: ChatDraft) => ChatDraft) => void
  intake: (files: readonly File[]) => Promise<void>
  inputRef: RefObject<HTMLTextAreaElement | null>
} {
  const [draft, setDraftState] = useState<ChatDraft>(() => readDraft(key))
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const errRef = useRef(onError)
  errRef.current = onError
  const setDraft = useCallback(
    (f: (d: ChatDraft) => ChatDraft) =>
      setDraftState((d) => {
        const next = f(d)
        writeDraft(key, next)
        return next
      }),
    [key]
  )
  const intake = useCallback(
    async (files: readonly File[]): Promise<void> => {
      const paths = filePaths(files)
      for (const f of files) {
        if (window.ev.app.pathForFile(f)) continue
        const r = await saveClipFile(f, pasteSub)
        if ('path' in r) paths.push(r.path)
        else errRef.current(r.error) // 조용히 버리지 않는다 — 붙인 사람은 붙었다고 믿는다
      }
      if (paths.length) setDraft((d) => ({ ...d, files: [...d.files, ...paths.filter((p) => !d.files.includes(p))] }))
      inputRef.current?.focus()
    },
    [setDraft, pasteSub]
  )
  return { draft, setDraft, intake, inputRef }
}

export function ChatComposer({
  draft,
  setDraft,
  inputRef,
  onSubmit,
  slashAgent,
  slashCwd,
  builtins = true,
  disabled,
  placeholder,
  busy = false,
  onStop,
  isolateKeys = false,
  rows,
  cls,
  sendIcon,
  stopIcon,
  sendLabel
}: {
  draft: ChatDraft
  setDraft: (f: (d: ChatDraft) => ChatDraft) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** 조립된 글(본문 + 첨부 경로 줄). true 를 돌려주면 초안을 비운다. 빈 글도 넘어온다(아라 되묻기의 빈 답). */
  onSubmit: (text: string) => boolean | Promise<boolean>
  /** `/` 목록을 읽을 에이전트. null 이면 목록이 없다(아라 API 엔진). */
  slashAgent: AgentId | null
  slashCwd: string
  /** 에이전트 기본 명령(TUI 명령)도 보일지 — 아라 숨은 세션은 사용자 명령·스킬만. */
  builtins?: boolean
  disabled: boolean
  placeholder: string
  /** 도는 중 — 보내기 버튼이 [중지]가 된다(아라). */
  busy?: boolean
  onStop?: () => void
  /** 키를 위로 올리지 않는다(아라: 터미널 단축키가 가로채지 않게). */
  isolateKeys?: boolean
  rows: number
  cls: { row: string; input: string; send: string }
  sendIcon: ReactNode
  stopIcon?: ReactNode
  sendLabel: string
}): JSX.Element {
  const [slash, setSlash] = useState<SlashItem[] | null>(null)
  const [slashSel, setSlashSel] = useState(0)
  const [slashOff, setSlashOff] = useState<string | null>(null)
  // 폴더·에이전트가 바뀌면 목록을 다시 읽는다(아라는 작업 폴더를 바꿀 수 있다).
  useEffect(() => setSlash(null), [slashAgent, slashCwd])
  const query = slashAgent ? slashQuery(draft.text) : null
  useEffect(() => {
    if (query === null || slash !== null || !slashAgent) return
    let alive = true
    void window.ev.agents
      .slash(slashAgent, slashCwd)
      .then((l) => alive && setSlash(builtins ? l : l.filter((x) => x.kind !== 'builtin')))
      .catch(() => alive && setSlash([]))
    return () => {
      alive = false
    }
  }, [query, slash, slashAgent, slashCwd, builtins])
  const picks = query !== null && slash && slashOff !== draft.text ? filterSlash(slash, query) : []
  const pickAt = Math.min(slashSel, Math.max(0, picks.length - 1))
  const text = composeChatText(draft.text, draft.files)

  const submit = async (): Promise<void> => {
    if (await onSubmit(text)) setDraft(() => ({ text: '', files: [] }))
  }

  return (
    <>
      {picks.length > 0 && (
        <ul className="aiws-chat-slash" role="listbox" data-aiws="chat-slash" aria-label={t('aiws.slash.title')}>
          {picks.map((x, i) => (
            <li
              key={x.name}
              role="option"
              aria-selected={i === pickAt}
              className={i === pickAt ? 'on' : ''}
              data-kind={x.kind}
              onMouseDown={(e) => {
                e.preventDefault()
                setDraft((d) => ({ ...d, text: `/${x.name} ` }))
              }}
            >
              <b>/{x.name}</b>
              <span>{x.kind === 'builtin' && slashAgent ? t(`aiws.slash.${slashAgent}.${x.name}`) : (x.description ?? t(`aiws.slash.kind.${x.kind}`))}</span>
            </li>
          ))}
        </ul>
      )}
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
      <div className={cls.row}>
        <textarea
          ref={inputRef}
          className={cls.input}
          data-aiws="chat-input"
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          value={draft.text}
          onChange={(e) => {
            const v = e.target.value
            setDraft((d) => ({ ...d, text: v }))
          }}
          onKeyDown={(e) => {
            if (isolateKeys) e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            // `/` 목록이 떠 있으면: 위아래 = 고르기, Tab·Enter = 채우기(이미 그 이름이면 Enter 는 보내기), Esc = 닫기.
            if (picks.length) {
              const cur = picks[pickAt]
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashSel((pickAt + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setSlashOff(draft.text)
                return
              }
              if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && draft.text !== `/${cur.name}`) {
                e.preventDefault()
                setSlashSel(0)
                setDraft((d) => ({ ...d, text: `/${cur.name} ` }))
                return
              }
            }
            // Enter = 보내기, Shift+Enter = 줄바꿈. 한글 조합 중 Enter 는 조합 끝내기다(위에서 걸렀다).
            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            void submit()
          }}
        />
        <button
          type="button"
          className={cls.send}
          data-aiws="chat-send"
          aria-label={busy ? t('ara.stop') : sendLabel}
          title={busy ? t('ara.stop') : sendLabel}
          disabled={busy ? false : disabled || !text.trim()}
          onClick={() => (busy ? onStop?.() : void submit())}
        >
          {busy ? stopIcon : sendIcon}
        </button>
      </div>
    </>
  )
}
