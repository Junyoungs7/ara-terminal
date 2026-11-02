// 3차 R1-B 마크다운 리뷰 주석 — 그린 글(리치 편집·미리 보기)에서 글을 골라 AI 에게 줄 메모를 단다.
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/MarkdownPreviewAnnotationComposer.tsx(작성 칸 — Enter 추가·Shift+Enter 줄바꿈·Esc 취소)·
// lib/markdown-review-notes.ts(MarkdownReviewNote = DiffComment & { source: 'markdown' }, 원문 줄 범위에 묶음).
// 저장·보내기는 M7 diff 줄 주석과 **같은 길**(diffStore 의 주석 · sendCommentsToAgent → 에이전트 탭 안전 입력). 형식은 Orca 마크다운 형식(shared/diffComments).
// 뺀 것: Ctrl+Shift+A 단축키(아라는 그 키가 'AI에게 질문'), 메모 하이라이트·옆줄(rail), 한 메모만 보내기 메뉴.
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { MessageSquarePlus, Send, X } from 'lucide-react'
import { t } from '../../i18n'
import { sendCommentsToAgent, useDiffStore } from './diffStore'
import { useAiwsStore } from './store'
import { useCodeStore, type CodeFile } from './codeStore'

/** 고른 글 → 원문 줄 범위(1부터, 포함). 못 정하면 null(메모 단추를 안 띄운다). */
export type ResolveSelection = (range: Range) => { start: number; end: number } | null

const relOf = (f: CodeFile): string => f.path.slice(f.root.replace(/[\\/]+$/, '').length).replace(/\\/g, '/').replace(/^\/+/, '')

type Pending = { start: number; end: number; text: string; top: number; left: number }

export function MarkdownReview({ file, hostRef, resolve }: { file: CodeFile; hostRef: RefObject<HTMLElement | null>; resolve: ResolveSelection }): JSX.Element {
  const rel = relOf(file)
  const all = useDiffStore((s) => s.comments[file.root])
  const notes = (all ?? []).filter((c) => c.source === 'markdown' && c.filePath === rel)
  const [pending, setPending] = useState<Pending | null>(null)
  const [composing, setComposing] = useState(false)
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const resolveRef = useRef(resolve)
  resolveRef.current = resolve
  const composingRef = useRef(false)
  composingRef.current = composing

  // 글을 고르고 마우스를 떼면 그 자리에 [리뷰 메모] 단추.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onUp = (): void => {
      if (composingRef.current) return
      const sel = window.getSelection()
      const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null
      const text = sel?.toString().trim() ?? ''
      if (!range || !text || !host.contains(range.commonAncestorContainer)) return setPending(null)
      const lines = resolveRef.current(range)
      if (!lines) return setPending(null)
      const r = range.getBoundingClientRect()
      const box = host.getBoundingClientRect()
      setPending({ ...lines, text, top: r.bottom - box.top + host.scrollTop, left: Math.max(0, r.left - box.left) })
    }
    host.addEventListener('mouseup', onUp)
    return () => host.removeEventListener('mouseup', onUp)
  }, [hostRef])

  const close = (): void => {
    setComposing(false)
    setPending(null)
    setBody('')
  }
  const submit = (): void => {
    const b = body.trim()
    if (!pending || !b) return
    useDiffStore.getState().addComment(file.root, { filePath: rel, startLine: pending.start, lineNumber: pending.end, body: b, source: 'markdown', selectedText: pending.text })
    close()
  }
  const send = async (): Promise<void> => {
    const wt = Object.values(useAiwsStore.getState().worktreesByRepo)
      .flat()
      .find((w) => w.id === file.worktreeId)
    if (!wt) return
    const r = await sendCommentsToAgent(wt, rel)
    setMsg(r.ok ? t('diff.send.done').replace('{n}', String(r.sent)) : r.message)
    // 보냈으면 에이전트 탭이 보이게(파일 탭을 내린다).
    if (r.ok) useCodeStore.getState().setActive(file.worktreeId, null)
  }
  const unsent = notes.filter((n) => !n.sentAt).length

  return (
    <>
      {pending && !composing && (
        <button
          type="button"
          className="md-note-add"
          data-doc="note-add"
          style={{ top: pending.top, left: pending.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setComposing(true)}
        >
          <MessageSquarePlus aria-hidden />
          {t('doc.note.add')}
        </button>
      )}
      {pending && composing && (
        <div className="md-note-composer" data-doc="note-composer" style={{ top: pending.top, left: pending.left }} onMouseUp={(e) => e.stopPropagation()}>
          <div className="md-note-label">{t('doc.note.selected')}</div>
          <textarea
            autoFocus
            rows={3}
            data-field="md-note"
            placeholder={t('doc.note.ph')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="md-note-foot">
            <button type="button" className="btn sec" onClick={close}>
              {t('doc.note.cancel')}
            </button>
            <button type="button" className="btn" data-doc="note-save" disabled={!body.trim()} onClick={submit}>
              {t('doc.note.save')}
            </button>
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <div className="md-notes" data-doc="notes">
          <div className="md-notes-head">
            <span>{t('doc.note.list').replace('{n}', String(notes.length))}</span>
            {msg && <span className="md-notes-msg">{msg}</span>}
            <button type="button" className="btn sec" data-doc="notes-send" disabled={unsent === 0} onClick={() => void send()}>
              <Send aria-hidden />
              {t('diff.send').replace('{n}', String(unsent))}
            </button>
          </div>
          {notes.map((n) => (
            <div key={n.id} className="md-note" data-doc="note" data-sent={n.sentAt ? '' : undefined}>
              <span className="md-note-loc">{n.startLine !== undefined && n.startLine !== n.lineNumber ? t('diff.comment.lines').replace('{a}', String(n.startLine)).replace('{b}', String(n.lineNumber)) : t('diff.comment.line').replace('{n}', String(n.lineNumber))}</span>
              {n.selectedText && <q className="md-note-quote">{n.selectedText.length > 60 ? n.selectedText.slice(0, 57) + '…' : n.selectedText}</q>}
              <span className="md-note-body">{n.body}</span>
              {n.sentAt && <span className="md-note-sent">{t('diff.comment.sent')}</span>}
              <button type="button" className="aiws-ic" aria-label={t('diff.comment.delete')} title={t('diff.comment.delete')} onClick={() => useDiffStore.getState().deleteComment(file.root, n.id)}>
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** 미리 보기 — 고른 글의 앞뒤 끝이 든 블록(data-l1·data-l2 = 원문 줄)으로 범위를 정한다. */
export function resolveByLineAttrs(range: Range): { start: number; end: number } | null {
  const blockOf = (n: Node): HTMLElement | null => (n instanceof HTMLElement ? n : n.parentElement)?.closest('[data-l1]') ?? null
  const a = blockOf(range.startContainer)
  const b = blockOf(range.endContainer)
  if (!a || !b) return null
  const start = Number(a.dataset.l1)
  const end = Math.max(start, Number(b.dataset.l2))
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}
