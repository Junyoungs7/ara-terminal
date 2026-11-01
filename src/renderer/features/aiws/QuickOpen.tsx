// M6 R2 WS-06 — 파일 빠른 열기(Ctrl+P, AI 작업 공간에서만). Orca QuickOpen.tsx·use-quick-open-interaction.ts(orcaRef fdfcfb3551)의 1차 판:
// 열 때 고른 작업 단위의 파일 목록을 rg --files 로 받고(.gitignore 존중), 칠 때마다 퍼지 순위(최근 연 파일 먼저), Enter → openFile.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileText, Search } from 'lucide-react'
import { rankQuickOpen } from '@shared/codeSearch'
import { t } from '../../i18n'
import { openFile, useCodeStore } from './codeStore'
import { hostOfWorktree, useAiwsStore } from './store'

type Listing = { files: string[]; truncated: boolean } | { error: string } | null

export function QuickOpen({ onClose, onOpened }: { onClose: () => void; onOpened: () => void }): JSX.Element {
  const wt = useAiwsStore((s) => (s.activeWorktreeId ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === s.activeWorktreeId) : undefined))
  const recent = useCodeStore((s) => (wt ? s.recentByWorktree[wt.id] : undefined))
  const [listing, setListing] = useState<Listing>(null)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])
  // 열 때마다 새로 받는다(Orca 와 같다 — 에이전트가 파일을 만들고 지우므로 묵은 목록을 들고 있지 않는다).
  // M8 R5 원격 작업 단위 — 목록은 그 서버에서(main 이 SSH 로 rg, 없으면 git ls-files). 받는 동안 '불러오는 중'.
  useEffect(() => {
    if (!wt) return
    let live = true
    void window.ev.code.listFiles(wt.path, hostOfWorktree(wt.id)).then((r) => {
      if (live) setListing(r.ok ? { files: r.files, truncated: r.truncated } : { error: r.message })
    })
    return () => void (live = false)
  }, [wt])

  const files = listing && 'files' in listing ? listing.files : null
  const shown = useMemo(() => (files ? rankQuickOpen(q, files, recent ?? []) : []), [q, files, recent])
  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.qo-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const pick = async (path: string | undefined): Promise<void> => {
    if (!path) return
    const r = await openFile(path)
    if (!r.ok) return setErr(r.message)
    onOpened()
    onClose()
  }

  const note = !wt
    ? t('code.err.noWorktree')
    : listing === null
      ? t('qo.loading')
      : 'error' in listing
        ? listing.error
        : (err ?? (shown.length === 0 ? t('qo.empty') : null))

  return (
    <>
      <div
        className="qo-scrim"
        onMouseDown={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="qo-drop"
        role="dialog"
        aria-label={t('qo.title')}
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault()
        }}
      >
        <div className="qo-head">
          <Search aria-hidden />
          <input
            ref={inputRef}
            type="text"
            data-field="quickopen"
            aria-label={t('qo.title')}
            spellCheck={false}
            placeholder={wt ? t('qo.placeholder').replace('{name}', wt.displayName) : t('qo.title')}
            value={q}
            onBlur={onClose}
            onChange={(e) => {
              setQ(e.target.value)
              setErr(null)
            }}
            onKeyDown={(e) => {
              // 에디터·터미널 단축키가 여기서 발동하지 않게 끊는다. 여는 키(Ctrl+P)로 닫는 것도 여기서.
              e.stopPropagation()
              if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.code === 'KeyP')) {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = shown.length
                if (n) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                void pick(shown[cursor])
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="qo-list" ref={listRef}>
          {note && <div className="qo-empty">{note}</div>}
          {shown.map((p, i) => {
            const cut = p.lastIndexOf('/')
            return (
              <div
                key={p}
                className={'qo-item' + (i === cursor ? ' on' : '')}
                data-path={p}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void pick(p)}
              >
                <FileText aria-hidden />
                <span className="qo-name">{p.slice(cut + 1)}</span>
                {cut > 0 && <span className="qo-dir">{p.slice(0, cut)}</span>}
              </div>
            )
          })}
        </div>
        {files && listing && 'truncated' in listing && listing.truncated && <div className="qo-foot">{t('qo.truncated').replace('{n}', String(files.length))}</div>}
      </div>
    </>
  )
}
