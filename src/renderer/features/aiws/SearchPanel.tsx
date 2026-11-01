// M6 R2 WS-09 — 워크트리 전체 검색(레일 [검색]). Orca right-sidebar/SearchQueryRow·SearchFilters·SearchResultsPane·SearchResultItems·
// search-match-open(orcaRef fdfcfb3551)의 1차 판. 왼쪽 목록 자리에 서고 가운데는 작업 단위 그대로라, 결과를 누르면 파일이 가운데에 열리고 결과는 남는다.
// 결과는 main 이 rg --json 을 읽으며 100ms 마다 묶어 보낸다(code:searchBatch) — 2000개·15초에서 멈추고(Orca 값), 새로 치면 앞 검색을 끊는다.
import { useEffect, useRef, useState, type JSX } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, X } from 'lucide-react'
import { SEARCH_MAX_RESULTS, type SearchFile, type SearchMatch } from '@shared/codeSearch'
import { t } from '../../i18n'
import { openFile } from './codeStore'
import { hostOfWorktree, useAiwsStore } from './store'

/** 칠 때 기다리는 시간 — 글자마다 rg 를 띄우지 않게. */
const DEBOUNCE_MS = 250

type Status = { state: 'idle' } | { state: 'running' } | { state: 'done'; total: number; truncated: boolean } | { state: 'error'; message: string }

function Line({ m }: { m: SearchMatch }): JSX.Element {
  const parts: JSX.Element[] = []
  let at = 0
  m.ranges.forEach(([s, e], i) => {
    if (s < at) return
    parts.push(<span key={'t' + i}>{m.text.slice(at, s)}</span>, <mark key={'m' + i}>{m.text.slice(s, e)}</mark>)
    at = e
  })
  parts.push(<span key="end">{m.text.slice(at)}</span>)
  return <>{parts}</>
}

export function SearchPanel({ hidden, onOpened }: { hidden: boolean; onOpened: () => void }): JSX.Element {
  const wt = useAiwsStore((s) => (s.activeWorktreeId ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === s.activeWorktreeId) : undefined))
  // M8 R5 원격 작업 단위 — 검색은 그 서버에서(main 이 SSH 로 rg, 없으면 git grep). 상한·취소·진행 표시는 로컬과 같다.
  const host = wt ? hostOfWorktree(wt.id) : undefined
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCase] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [files, setFiles] = useState<SearchFile[]>([])
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [openErr, setOpenErr] = useState<string | null>(null)
  const current = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!hidden) inputRef.current?.focus()
  }, [hidden])

  // 묶음을 이어 붙인다 — 지금 검색(id)의 것만. 같은 파일이 여러 묶음에 나뉘어 온다.
  useEffect(
    () =>
      window.ev.code.onSearchBatch(({ id, files: batch }) => {
        if (id !== current.current) return
        setFiles((prev) => {
          const next = [...prev]
          for (const f of batch) {
            const i = next.findIndex((x) => x.path === f.path)
            if (i === -1) next.push(f)
            else next[i] = { path: f.path, matches: [...next[i].matches, ...f.matches] }
          }
          return next
        })
      }),
    []
  )

  const cancel = (): void => {
    if (current.current) void window.ev.code.searchCancel(current.current)
  }

  // 검색어·옵션·작업 단위가 바뀌면 앞 검색을 끊고 잠깐 기다렸다 새로.
  useEffect(() => {
    cancel()
    current.current = null
    setFiles([])
    setFolded({})
    setOpenErr(null)
    if (!wt || !query) return setStatus({ state: 'idle' })
    const root = wt.path
    const timer = setTimeout(() => {
      const id = `${Date.now()}-${Math.random()}`
      current.current = id
      setStatus({ state: 'running' })
      void window.ev.code.search(id, root, { query, regex, caseSensitive, include, exclude }, host).then((r) => {
        if (current.current !== id) return
        setStatus(r.ok ? (r.cancelled ? { state: 'idle' } : { state: 'done', total: r.total, truncated: r.truncated }) : { state: 'error', message: r.message })
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [wt, host, query, regex, caseSensitive, include, exclude])
  // 패널이 사라지면(공간을 떠남) 도는 검색을 끊는다.
  useEffect(() => cancel, [])

  const open = async (path: string, line: number): Promise<void> => {
    const r = await openFile(path, line)
    if (!r.ok) return setOpenErr(r.message)
    setOpenErr(null)
    onOpened()
  }

  const count = files.reduce((n, f) => n + f.matches.length, 0)
  const summary =
    status.state === 'running'
      ? t('search.running').replace('{n}', String(count))
      : status.state === 'error'
        ? status.message
        : status.state === 'done'
          ? status.total === 0
            ? t('search.none')
            : t('search.summary').replace('{n}', String(status.total)).replace('{files}', String(files.length)) +
              (status.truncated ? ' · ' + t('search.truncated').replace('{max}', String(SEARCH_MAX_RESULTS)) : '')
          : null

  return (
    <div className="aiws-search" hidden={hidden} role="search" aria-label={t('aiws.nav.search')}>
      <div className="aiws-side-head">
        <span className="aiws-side-ttl">{t('aiws.nav.search')}</span>
        {wt && <span className="srch-wt">{wt.displayName}</span>}
      </div>
      <div className="srch-form">
        <div className="srch-q">
          <input
            ref={inputRef}
            type="text"
            className="aiws-input"
            data-field="search.query"
            spellCheck={false}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && status.state === 'running') cancel()
            }}
          />
          <button type="button" className={'aiws-ic' + (caseSensitive ? ' on' : '')} data-search="case" aria-pressed={caseSensitive} title={t('search.case')} aria-label={t('search.case')} onClick={() => setCase((v) => !v)}>
            <CaseSensitive />
          </button>
          <button type="button" className={'aiws-ic' + (regex ? ' on' : '')} data-search="regex" aria-pressed={regex} title={t('search.regex')} aria-label={t('search.regex')} onClick={() => setRegex((v) => !v)}>
            <Regex />
          </button>
        </div>
        <input type="text" className="aiws-input" data-field="search.include" spellCheck={false} placeholder={t('search.include')} aria-label={t('search.include')} value={include} onChange={(e) => setInclude(e.target.value)} />
        <input type="text" className="aiws-input" data-field="search.exclude" spellCheck={false} placeholder={t('search.exclude')} aria-label={t('search.exclude')} value={exclude} onChange={(e) => setExclude(e.target.value)} />
      </div>
      {(summary || openErr || !wt) && (
        <div className={'srch-status' + (status.state === 'error' || openErr ? ' err' : '')} data-search="status">
          <span>{openErr ?? (wt ? summary : t('code.err.noWorktree'))}</span>
          {status.state === 'running' && (
            <button type="button" className="aiws-ic" data-search="cancel" title={t('search.cancel')} aria-label={t('search.cancel')} onClick={cancel}>
              <X />
            </button>
          )}
        </div>
      )}
      <div className="srch-results" role="tree">
        {files.map((f) => {
          const cut = f.path.lastIndexOf('/')
          const isFolded = folded[f.path]
          return (
            <div key={f.path} className="srch-file" data-search-file={f.path} role="treeitem" aria-expanded={!isFolded}>
              <button type="button" className="srch-file-head" onClick={() => setFolded((s) => ({ ...s, [f.path]: !isFolded }))}>
                {isFolded ? <ChevronRight /> : <ChevronDown />}
                <span className="srch-name">{f.path.slice(cut + 1)}</span>
                {cut > 0 && <span className="srch-dir">{f.path.slice(0, cut)}</span>}
                <span className="srch-n">{f.matches.length}</span>
              </button>
              {!isFolded &&
                f.matches.map((m, i) => (
                  <button key={i} type="button" className="srch-hit" data-line={m.line} onClick={() => void open(f.path, m.line)}>
                    <span className="srch-ln">{m.line}</span>
                    <span className="srch-text">
                      <Line m={m} />
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
