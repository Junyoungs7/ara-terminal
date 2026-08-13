// 우측 [로그] 패널 — 이 세션에서 오간 CLI 내역을 그대로 보여 주고 파일로 내려받는다.
// 껍데기는 MonitorPanel 과 같은 조합(.mon-head + 닫기), 검색 필드는 사이드바/포트 모니터가 쓰는
// .sb-search .field 를 그대로 재사용한다.
//
// 긴 로그를 어떻게 다루나(파일 분할 없이 — 나눠 두면 사용자가 어느 조각을 볼지 골라야 한다):
//   ① **뒤에서부터 창 단위**로 읽는다. 열면 최근 256KB 만 그린다 — 20MB 세션이어도 즉시 뜬다.
//      위로 올라가 [이전 불러오기]를 누르면 앞쪽 창을 이어 붙인다. 화면상으론 끊김 없는 하나의 로그다.
//   ② **찾기**로 줄을 좁힌다. 긴 로그에서 필요한 건 대개 "그 명령 근처"라 스크롤보다 검색이 빠르다.
//   ③ **내려받기는 창이 아니라 전체**를 준다 — 뷰어는 창, 아카이브는 파일.
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconClose, IconRefresh } from './icons'
import { t } from '../i18n'

type Props = {
  open: boolean
  onClose: () => void
  sessionId: string | null
  sessionTitle: string
}

// 패널 폭 — 너무 좁으면 로그 한 줄이 계속 접히고, 너무 넓으면 터미널을 잡아먹는다.
const DEFAULT_W = 340
const MIN_W = 260
const MAX_W = 720
export function clampLogWidth(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(w)))
}

/** 표시할 줄 고르기(순수 — 단위 테스트 대상). 빈 검색어면 전부. 대소문자 무시. */
export function filterLogLines(text: string, query: string): string[] {
  const lines = text.split('\n')
  const q = query.trim().toLowerCase()
  if (!q) return lines
  return lines.filter((l) => l.toLowerCase().includes(q))
}

export function LogPanel({ open, onClose, sessionId, sessionTitle }: Props): JSX.Element | null {
  const [text, setText] = useState('')
  const [source, setSource] = useState<'file' | 'buffer'>('buffer')
  const [start, setStart] = useState(0) // 0 이면 앞이 더 없다
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 폭은 이 패널이 스스로 기억한다(사이드바처럼 스냅샷까지 저장하진 않는다 — 세션 로그는 잠깐 보는 창이다).
  const [width, setWidth] = useState(DEFAULT_W)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 왼쪽 경계 드래그로 폭 조절. 오른쪽 고정 패널이라 **왼쪽으로 끌면 넓어진다**(부호가 반대).
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = e.currentTarget.parentElement?.getBoundingClientRect().width ?? DEFAULT_W
    const move = (ev: MouseEvent) => setWidth(clampLogWidth(startW + (startX - ev.clientX)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  // 최신 창을 다시 읽는다(열 때 · 세션 전환 · 새로고침). 읽고 나면 맨 아래로.
  const reload = useCallback(async () => {
    if (!sessionId) return
    setBusy(true)
    const res = await window.ev.sessionLog.read(sessionId)
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      setText('')
      return
    }
    setError(null)
    setText(res.text)
    setSource(res.source)
    setStart(res.start)
    requestAnimationFrame(() => {
      const el = bodyRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [sessionId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  // 앞쪽 창을 이어 붙인다. 스크롤 위치는 붙인 만큼 밀어 줘야 보던 줄이 그대로 남는다.
  const loadOlder = useCallback(async () => {
    if (!sessionId || start === 0) return
    const el = bodyRef.current
    const before = el?.scrollHeight ?? 0
    setBusy(true)
    const res = await window.ev.sessionLog.read(sessionId, start)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    setText((cur) => res.text + cur)
    setStart(res.start)
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before
    })
  }, [sessionId, start])

  if (!open) return null

  const lines = filterLogLines(text, query)
  return (
    <div className="log-panel" style={{ width, flexBasis: width }}>
      {/* 왼쪽 경계 = 리사이저(사이드바의 .sb-resizer 와 같은 조작감). */}
      <div className="lp-resizer" onMouseDown={startResize} />
      <div className="mon-head">
        <span className="mon-name">{t('log.title')}</span>
        <span className="log-src" title={t(source === 'file' ? 'log.src.file.title' : 'log.src.buffer.title')}>
          {t(source === 'file' ? 'log.src.file' : 'log.src.buffer')}
        </span>
        <div className="sb-tab-spacer" />
        <span className="sb-act" title={t('sftp.refresh')} onClick={() => void reload()}>
          <IconRefresh />
        </span>
        <span className="mon-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>
      <div className="sb-search">
        <div className="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
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
          {query && (
            <span className="sclear" title={t('conn.search.clear')} onClick={() => setQuery('')}>
              <IconClose />
            </span>
          )}
        </div>
      </div>
      <div className="log-body" ref={bodyRef}>
        {!sessionId && <div className="sftp-empty">{t('log.noSession')}</div>}
        {error && <div className="sftp-err">{error}</div>}
        {sessionId && !error && start > 0 && (
          <button type="button" className="log-more" disabled={busy} onClick={() => void loadOlder()}>
            {t('log.loadOlder')}
          </button>
        )}
        {sessionId && !error && text === '' && !busy && <div className="sftp-empty">{t('log.empty')}</div>}
        {query && <div className="log-hits">{t('log.hits').replace('{n}', String(lines.length))}</div>}
        <pre className="log-text">{lines.join('\n')}</pre>
      </div>
      <div className="log-foot">
        <span className="log-name" title={sessionTitle}>
          {sessionTitle}
        </span>
        <button
          type="button"
          className="log-dl"
          disabled={!sessionId}
          onClick={() => void window.ev.sessionLog.save(sessionId!).then((r) => !r.ok && !r.canceled && setError(r.message))}
        >
          {t('log.download')}
        </button>
      </div>
    </div>
  )
}
