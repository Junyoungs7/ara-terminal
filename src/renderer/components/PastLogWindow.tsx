// 지난 세션 로그 독립 창 (2026-10-29 준영님 요청 — "내용은 창으로 띄워서 거기에 보여주게 해줘").
//
// 사이드바 [지난 세션](PastLogPanel)은 목록만 든다. 행을 누르면 main 이 이 창을 띄우거나(하나뿐)
// 떠 있는 창에 대상을 민다(pastlog:show). 읽기는 예전 패널과 같은 창 단위 읽기(sessionLog.readFile) —
// 렌더러는 로그 파일 **이름**만 안다(경로는 main 만).
import { useCallback, useEffect, useState } from 'react'
import type { PastLogTarget } from '@shared/pastLogWin'
import { TitleBar } from './TitleBar'
import { filterLogLines } from './LogPanel'
import { t } from '../i18n'

export function PastLogWindow(): JSX.Element {
  const [target, setTarget] = useState<PastLogTarget | null>(null)
  const [text, setText] = useState('')
  const [start, setStart] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const off = window.ev?.pastlog.onShow(setTarget)
    // 구독을 건 **다음에** 묻는다 — 그 사이에 온 push 를 hello 가 덮어도 같은 대상이다.
    void window.ev?.pastlog
      .hello()
      .then((r) => {
        if (r) setTarget(r)
      })
      .catch(() => {})
    return () => off?.()
  }, [])

  // 대상이 바뀔 때마다(같은 행을 다시 눌러도 새 객체다) 처음부터 다시 읽는다.
  useEffect(() => {
    if (!target) return
    let alive = true
    setQuery('')
    setBusy(true)
    void window.ev.sessionLog.readFile(target.file).then((res) => {
      if (!alive) return
      setBusy(false)
      if (!res.ok) {
        setError(res.message)
        setText('')
        setStart(0)
        return
      }
      setError(null)
      setText(res.text)
      setStart(res.start)
    })
    return () => {
      alive = false
    }
  }, [target])

  const loadOlder = useCallback(async () => {
    if (!target || start === 0) return
    setBusy(true)
    const res = await window.ev.sessionLog.readFile(target.file, start)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    setText((cur) => res.text + cur)
    setStart(res.start)
  }, [target, start])

  const when = target ? new Date(target.startedAt).toLocaleString() : ''
  useEffect(() => {
    document.title = target ? `${t('pastlog.title')} — ${target.serverKey}` : t('pastlog.title')
  }, [target])

  const lines = filterLogLines(text, query)

  return (
    <div className="app pastlogwin">
      <TitleBar title={target ? `${t('pastlog.title')} — ${target.serverKey}` : t('pastlog.title')} />
      <div className="plw-body">
        {target && (
          <div className="plw-head">
            <span className="plw-srv">{target.serverKey}</span>
            <span className="plw-when">{when}</span>
          </div>
        )}
        <div className="sb-search">
          <div className="field">
            <input
              type="text"
              value={query}
              placeholder={t('log.search.placeholder')}
              aria-label={t('log.search.placeholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setQuery('')
              }}
            />
          </div>
        </div>
        <div className="log-body">
          {error && <div className="sftp-err">{error}</div>}
          {!error && start > 0 && (
            <button type="button" className="log-more" disabled={busy} onClick={() => void loadOlder()}>
              {t('log.loadOlder')}
            </button>
          )}
          {query && <div className="log-hits">{t('log.hits').replace('{n}', String(lines.length))}</div>}
          <pre className="log-text">{lines.join('\n')}</pre>
        </div>
      </div>
    </div>
  )
}
