import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { MessageSquarePlus, RefreshCw, Send, Trash2 } from 'lucide-react'
import type { GitDiffResult } from '@shared/gitDiff'
import type { DiffComment } from '@shared/diffComments'
import { languageOf } from '@shared/codeFiles'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { monaco } from './monacoSetup'
import { changeCount, sendCommentsToAgent, useDiffStore, type DiffSel } from './diffStore'
import { hostOfWorktree } from './store'
import { editorFont } from './editorOptions'

/**
 * M7 R1 WS-10·11 — 가운데 **"변경 비교 · n" 탭**의 본문. AgentPane 이 lazy 로 부른다(monacoSetup 을 같이 끌고 온다 — diff 탭을 안 열면 안 불린다).
 * 왼쪽 = 변경 목록(작업 중 / 분기 기준), 오른쪽 = 고른 파일의 Monaco diff(나란히/한 줄) + 줄 주석 + [에이전트에게 보내기].
 * Orca components/editor/DiffViewer·DiffSectionItem·diff-comments/(orcaRef fdfcfb3551)의 1차 판. 뺀 것: 여러 파일 이어 보기(combined diff)·
 * 줄 사이 카드(view zone)·드래그 범위·이미지 미리보기·검토 완료 표시 — 주석은 줄 강조 + 아래 목록, 범위는 에디터 선택으로.
 */

const LANGS = monaco.languages.getLanguages()
const STATUS_LETTER: Record<string, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' }
type Row = DiffSel & { key: string; letter: string; area?: string }

export default function DiffView({ worktree, hidden }: { worktree: Worktree; hidden: boolean }): JSX.Element {
  const d = useDiffStore((s) => s.byWorktree[worktree.id])
  const inline = useDiffStore((s) => s.inline)
  const allComments = useDiffStore((s) => s.comments[worktree.path])
  const comments = useMemo(() => allComments ?? [], [allComments])
  const sel = d?.selected ?? null
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [draft, setDraft] = useState<{ startLine: number; lineNumber: number; body: string; editId?: string } | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const edRef = useRef<ReturnType<typeof monaco.editor.createDiffEditor> | null>(null)
  const decoRef = useRef<ReturnType<ReturnType<ReturnType<typeof monaco.editor.createDiffEditor>['getModifiedEditor']>['createDecorationsCollection']> | null>(null)

  // 목록 줄 — 작업 중이면 영역(스테이지됨/안 됨/추적 안 됨)마다 한 줄(같은 파일이 둘이면 두 줄, 보는 쪽이 다르다).
  const rows: Row[] = useMemo(() => {
    if (d?.list === 'working' && d.working?.ok)
      return d.working.entries.map((e) => ({ key: `${e.area}:${e.path}`, path: e.path, oldPath: e.oldPath, mode: e.area === 'staged' ? 'staged' : 'unstaged', letter: STATUS_LETTER[e.status] ?? 'M', area: e.area }))
    if (d?.list === 'branch' && d.branch?.ok) return d.branch.entries.map((e) => ({ key: e.path, path: e.path, oldPath: e.oldPath, mode: 'branch', letter: STATUS_LETTER[e.status] ?? 'M' }))
    return []
  }, [d])
  const result = d?.list === 'branch' ? d.branch : d?.working
  const mergeBase = d?.branch?.ok ? d.branch.mergeBase : undefined

  // 아무것도 안 골랐으면 첫 파일(Orca 도 diff 를 열면 첫 파일을 보인다).
  useEffect(() => {
    if (!sel && rows[0]) useDiffStore.getState().select(worktree.id, { path: rows[0].path, oldPath: rows[0].oldPath, mode: rows[0].mode })
  }, [sel, rows, worktree.id])

  // Monaco diff 에디터는 탭이 살아 있는 동안 하나. 모델은 고른 파일이 바뀔 때마다 새로(옛것은 버린다).
  useEffect(() => {
    if (!host.current) return
    const css = getComputedStyle(document.documentElement)
    const ed = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      glyphMargin: true,
      renderSideBySide: !useDiffStore.getState().inline,
      // Monaco 기본값은 폭 900px 이하면 [나란히]를 몰래 한 줄 보기로 바꾼다 — 사용자가 고른 보기를 그대로 지킨다.
      useInlineViewWhenSpaceIsLimited: false,
      theme: 'ara',
      // M12 R2: 에디터와 같은 글꼴(설정 › 편집기 [글꼴], 비면 터미널 글꼴 — Orca).
      ...editorFont(css)
    })
    edRef.current = ed
    decoRef.current = ed.getModifiedEditor().createDecorationsCollection()
    return () => {
      const m = ed.getModel()
      ed.dispose()
      m?.original.dispose()
      m?.modified.dispose()
      edRef.current = null
    }
  }, [])
  useEffect(() => edRef.current?.updateOptions({ renderSideBySide: !inline }), [inline])

  // **연 파일만** 계산한다 — 목록은 이름만, 양쪽 글은 고를 때 main 에 묻는다.
  useEffect(() => {
    setDiff(null)
    setDraft(null)
    if (!sel) return
    let alive = true
    void window.ev.gitInspect.diff({ worktreePath: worktree.path, filePath: sel.path, oldPath: sel.oldPath, mode: sel.mode, mergeBase, host: hostOfWorktree(worktree.id) }).then((r) => alive && setDiff(r))
    return () => {
      alive = false
    }
  }, [sel, worktree.path, mergeBase])
  useEffect(() => {
    const ed = edRef.current
    if (!ed || !sel || !diff?.ok || diff.kind !== 'text') return
    const lang = languageOf(sel.path, LANGS)
    const old = ed.getModel()
    ed.setModel({ original: monaco.editor.createModel(diff.original, lang), modified: monaco.editor.createModel(diff.modified, lang) })
    old?.original.dispose()
    old?.modified.dispose()
  }, [diff, sel])

  const fileComments = useMemo(() => (sel ? comments.filter((c) => c.filePath === sel.path) : []), [comments, sel])
  // 주석 단 줄을 바뀐 쪽(오른쪽) 에디터에 칠한다 — 마우스를 올리면 의견이 보인다.
  useEffect(() => {
    decoRef.current?.set(
      fileComments
        .filter((c) => c.lineNumber > 0)
        .map((c) => ({
          range: new monaco.Range(c.startLine ?? c.lineNumber, 1, c.lineNumber, 1),
          options: { isWholeLine: true, className: 'diff-cmt-line', glyphMarginClassName: 'diff-cmt-glyph', hoverMessage: { value: c.body } }
        }))
    )
  }, [fileComments, diff])

  const startComment = (): void => {
    const s = diff?.ok && diff.kind === 'text' ? edRef.current?.getModifiedEditor().getSelection() : null
    // 줄 끝까지 끌어 다음 줄 1열에서 멈춘 선택은 그 줄을 빼고 센다(VS Code 와 같다).
    const end = s ? (s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber) : 0
    setDraft({ startLine: s ? s.startLineNumber : 0, lineNumber: end, body: '' })
  }
  const saveDraft = (): void => {
    if (!draft || !sel || !draft.body.trim()) return
    const st = useDiffStore.getState()
    if (draft.editId) st.editComment(worktree.path, draft.editId, draft.body.trim())
    else
      st.addComment(worktree.path, {
        filePath: sel.path,
        lineNumber: draft.lineNumber,
        ...(draft.startLine && draft.startLine !== draft.lineNumber ? { startLine: draft.startLine } : {}),
        body: draft.body.trim(),
        scope: sel.mode
      })
    setDraft(null)
  }
  const unsent = comments.filter((c) => !c.sentAt).length
  const send = async (): Promise<void> => {
    const r = await sendCommentsToAgent(worktree)
    setNote(r.ok ? { ok: true, text: t('diff.send.done').replace('{n}', String(r.sent)) } : { ok: false, text: r.message })
  }
  const n = changeCount(d)

  return (
    <div className="diff-view" data-diff="view" hidden={hidden}>
      <aside className="diff-list" aria-label={t('diff.list')}>
        <div className="diff-list-head">
          <div className="diff-seg" role="radiogroup" aria-label={t('diff.list')}>
            {(['working', 'branch'] as const).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={d?.list === l} className={'diff-seg-btn' + (d?.list === l ? ' on' : '')} data-diff-list={l} onClick={() => useDiffStore.getState().setList(worktree, l)}>
                {t('diff.list.' + l)}
              </button>
            ))}
          </div>
          <button type="button" className="aiws-ic" data-diff="refresh" aria-label={t('diff.refresh')} title={t('diff.refresh')} onClick={() => void useDiffStore.getState().refresh(worktree)}>
            <RefreshCw />
          </button>
        </div>
        {d?.list === 'branch' && d.branch?.ok && (
          <p className="diff-meta aiws-mono" data-diff="base">
            {t('diff.base').replace('{base}', d.branch.baseRef).replace('{mb}', d.branch.mergeBase.slice(0, 8))}
          </p>
        )}
        {d?.loading && !result && <p className="aiws-note">{t('diff.loading')}</p>}
        {result && !result.ok && (
          <p className="aiws-note aiws-err" role="alert">
            {result.message}
          </p>
        )}
        {result?.ok && n === 0 && <p className="aiws-note" data-diff="empty">{t('diff.empty')}</p>}
        {result?.ok && result.truncated && <p className="aiws-note">{t('diff.truncated')}</p>}
        <div className="diff-rows" role="listbox" aria-label={t('diff.list')}>
          {rows.map((r) => {
            const on = !!sel && sel.path === r.path && sel.mode === r.mode
            const cnt = comments.filter((c) => c.filePath === r.path && !c.sentAt).length
            const cut = r.path.lastIndexOf('/')
            return (
              <button
                key={r.key}
                type="button"
                role="option"
                aria-selected={on}
                className={'diff-row' + (on ? ' on' : '')}
                data-diff-file={r.path}
                data-area={r.area}
                title={r.oldPath ? `${r.oldPath} → ${r.path}` : r.path}
                onClick={() => useDiffStore.getState().select(worktree.id, { path: r.path, oldPath: r.oldPath, mode: r.mode })}
              >
                <span className={'diff-letter s-' + r.letter}>{r.letter}</span>
                <span className="diff-name">{r.path.slice(cut + 1)}</span>
                <span className="diff-dir">{cut > 0 ? r.path.slice(0, cut) : ''}</span>
                {r.area === 'staged' && <span className="diff-area">{t('diff.staged')}</span>}
                {cnt > 0 && <span className="diff-cnt">{cnt}</span>}
              </button>
            )
          })}
        </div>
      </aside>
      <section className="diff-main">
        <div className="code-bar diff-bar">
          <span className="aiws-mono" data-diff="path">
            {sel ? `${sel.oldPath ? sel.oldPath + ' → ' : ''}${sel.path}` : ''}
          </span>
          <div className="diff-seg" role="radiogroup" aria-label={t('diff.layout')}>
            {[false, true].map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={inline === v} className={'diff-seg-btn' + (inline === v ? ' on' : '')} data-diff-layout={v ? 'inline' : 'split'} onClick={() => useDiffStore.getState().setInline(v)}>
                {t(v ? 'diff.inline' : 'diff.split')}
              </button>
            ))}
          </div>
          <button type="button" className="btn sec" data-diff="add-comment" disabled={!sel || !diff?.ok} onClick={startComment}>
            <MessageSquarePlus aria-hidden />
            {t('diff.comment.add')}
          </button>
          <button type="button" className="btn pri" data-diff="send" disabled={unsent === 0} onClick={() => void send()}>
            <Send aria-hidden />
            {t('diff.send').replace('{n}', String(unsent))}
          </button>
        </div>
        {note && (
          <div className={'code-bar' + (note.ok ? '' : ' warn')} role={note.ok ? 'status' : 'alert'} data-diff="send-note">
            <span>{note.text}</span>
            <button type="button" className="btn sec" onClick={() => setNote(null)}>
              {t('diff.dismiss')}
            </button>
          </div>
        )}
        {draft && (
          <div className="diff-draft" data-diff="draft">
            <span className="aiws-mono diff-meta">{lineLabel(draft)}</span>
            <textarea
              className="aiws-input"
              data-diff="comment-input"
              rows={3}
              autoFocus
              placeholder={t('diff.comment.ph')}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveDraft()
                if (e.key === 'Escape') setDraft(null)
              }}
            />
            <div className="diff-draft-foot">
              <button type="button" className="btn sec" onClick={() => setDraft(null)}>
                {t('aiws.new.cancel')}
              </button>
              <button type="button" className="btn pri" data-diff="comment-save" disabled={!draft.body.trim()} onClick={saveDraft}>
                {t('diff.comment.save')}
              </button>
            </div>
          </div>
        )}
        {sel && !diff && <p className="aiws-note">{t('diff.loading')}</p>}
        {diff && !diff.ok && (
          <p className="aiws-note aiws-err" role="alert">
            {diff.message}
          </p>
        )}
        {diff?.ok && diff.kind !== 'text' && (
          <p className="aiws-note" data-diff={diff.kind}>
            {t('diff.' + diff.kind)}
          </p>
        )}
        <div className="diff-monaco" ref={host} hidden={!diff?.ok || diff.kind !== 'text'} />
        {fileComments.length > 0 && (
          <ul className="diff-cmts" aria-label={t('diff.comments')}>
            {fileComments.map((c) => (
              <li key={c.id} className="diff-cmt" data-diff="comment" data-sent={c.sentAt ? 'true' : undefined}>
                <button type="button" className="diff-cmt-loc aiws-mono" onClick={() => c.lineNumber > 0 && edRef.current?.getModifiedEditor().revealLineInCenter(c.lineNumber)}>
                  {lineLabel(c)}
                </button>
                <span className="diff-cmt-body">{c.body}</span>
                {c.sentAt && <span className="diff-area">{t('diff.comment.sent')}</span>}
                <button type="button" className="btn sec" onClick={() => setDraft({ startLine: c.startLine ?? c.lineNumber, lineNumber: c.lineNumber, body: c.body, editId: c.id })}>
                  {t('diff.comment.edit')}
                </button>
                <button type="button" className="aiws-ic" aria-label={t('diff.comment.delete')} title={t('diff.comment.delete')} onClick={() => useDiffStore.getState().deleteComment(worktree.path, c.id)}>
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function lineLabel(c: Pick<DiffComment, 'lineNumber' | 'startLine'>): string {
  if (c.lineNumber === 0) return t('diff.comment.file')
  return c.startLine && c.startLine !== c.lineNumber ? t('diff.comment.lines').replace('{a}', String(c.startLine)).replace('{b}', String(c.lineNumber)) : t('diff.comment.line').replace('{n}', String(c.lineNumber))
}
