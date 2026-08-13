// 편집기 창(노트) — 파일 하나를 열어 보고 바로 고쳐 저장한다. 메인 창이 아니라 별도 창에서
// 단독으로 뜬다(main/editor/EditorWindows.ts 가 #editor 해시로 이 컴포넌트를 띄운다).
//
// 일부러 안 넣은 것: 문법 강조·탭 여러 개·되돌리기 스택. textarea 의 기본 편집(되돌리기 포함)과
// Ctrl+S 만으로 "설정 파일 한 줄 고치기"는 끝난다 — 그 이상은 에디터를 만드는 일이다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

type Target = { sessionId: string | null; path: string; server: string }

// 해시(#editor?path=...&server=...&session=...) → 대상. 창을 만든 main 이 넣어 준 값이다.
export function parseEditorHash(hash: string): Target | null {
  const q = hash.indexOf('?')
  if (!hash.startsWith('#editor') || q < 0) return null
  const p = new URLSearchParams(hash.slice(q + 1))
  const path = p.get('path')
  if (!path) return null
  return { path, server: p.get('server') ?? '', sessionId: p.get('session') }
}

/** 창 제목: "서버 - 파일명"(수정 중이면 앞에 ●). 파일명만 쓰면 창이 여러 개일 때 구분이 안 된다. */
export function editorTitle(target: Target, dirty: boolean): string {
  const name = target.path.split(/[\\/]/).filter(Boolean).pop() || target.path
  const head = target.server ? `${target.server} - ${name}` : name
  return dirty ? `● ${head}` : head
}

type Status = { kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }

export function EditorWindow({ target }: { target: Target }): JSX.Element {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('') // 마지막으로 저장된 내용 — 이것과 다르면 수정 중이다
  const [eol, setEol] = useState<'lf' | 'crlf'>('lf')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [fatal, setFatal] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = !loading && text !== saved

  useEffect(() => {
    let alive = true
    void (async () => {
      const res = await window.ev.editor.read(target.sessionId, target.path)
      if (!alive) return
      if (!res.ok) {
        setFatal(res.message)
        setLoading(false)
        return
      }
      setText(res.text)
      setSaved(res.text)
      setEol(res.eol)
      setLoading(false)
      areaRef.current?.focus()
    })()
    return () => {
      alive = false
    }
  }, [target.sessionId, target.path])

  useEffect(() => {
    document.title = editorTitle(target, dirty)
  }, [target, dirty])

  const save = useCallback(async () => {
    if (loading || fatal) return
    const snapshot = text
    setStatus({ kind: 'saving' })
    const res = await window.ev.editor.write(target.sessionId, target.path, snapshot, eol)
    if (!res.ok) {
      setStatus({ kind: 'error', message: res.message })
      return
    }
    // 저장하는 동안 더 친 글자가 있으면 그건 아직 안 저장된 것이다 — snapshot 을 기준으로 잡는다.
    setSaved(snapshot)
    setStatus({ kind: 'saved' })
  }, [loading, fatal, text, eol, target])

  // Ctrl+S(⌘S) 저장. textarea 안에서 눌러도 잡히도록 창 전체에 건다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // 저장 안 한 채로 창을 닫으려 하면 붙잡는다 — 네이티브 확인창이 뜬다(창 닫기는 OS 가 소유한다).
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return (
    <div className="editor-win">
      <div className="ed-hd">
        <span className="ed-path" title={target.path}>
          {target.path}
        </span>
        <span className="ed-state">
          {status.kind === 'saving'
            ? t('editor.saving')
            : status.kind === 'error'
              ? status.message
              : dirty
                ? t('editor.dirty')
                : status.kind === 'saved'
                  ? t('editor.saved')
                  : ''}
        </span>
        <button type="button" className="ed-save" disabled={!dirty || status.kind === 'saving'} onClick={() => void save()}>
          {t('editor.save')}
        </button>
      </div>
      {fatal ? (
        <div className="ed-fatal">{fatal}</div>
      ) : (
        <textarea
          ref={areaRef}
          className="ed-area"
          spellCheck={false}
          value={loading ? t('editor.loading') : text}
          readOnly={loading}
          onChange={(e) => setText(e.target.value)}
        />
      )}
    </div>
  )
}
