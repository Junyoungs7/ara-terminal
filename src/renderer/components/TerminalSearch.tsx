import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { clearSearch, findInTerm, focusTerm } from '../terminal/termRegistry'

// R3.2 터미널 내 검색 바 — 패널 그리드 위에 뜨는 인라인 오버레이(별도 모달 아님).
// 검색 자체는 @xterm/addon-search 가 하고 여기는 입력·이동·상태 표시만 맡는다.
// 대상은 "포커스 패널의 세션" 하나다: 검색 중 패널을 옮기면 그 패널을 다시 검색한다.

type Props = {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

export function TerminalSearch({ open, sessionId, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [miss, setMiss] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const find = useCallback(
    (back: boolean) => {
      if (!sessionId || !query) {
        setMiss(false)
        return
      }
      setMiss(!findInTerm(sessionId, query, back))
    },
    [sessionId, query]
  )

  // 열릴 때 입력으로 포커스(바로 타이핑). 이미 쓴 검색어는 남겨 두고 전체 선택해 덮어쓰기 쉽게.
  useEffect(() => {
    if (!open) return
    const el = inputRef.current
    el?.focus()
    el?.select()
  }, [open])

  // 타이핑하는 동안 앞에서부터 증분 검색(첫 매치로 스크롤).
  useEffect(() => {
    if (open) find(false)
    // find 는 query·sessionId 파생이라 query 변경마다 재실행된다.
  }, [open, find])

  const close = useCallback(() => {
    if (sessionId) {
      clearSearch(sessionId)
      focusTerm(sessionId)
    }
    onClose()
  }, [sessionId, onClose])

  if (!open) return null

  return (
    <div className="term-search">
      <svg className="ts-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        className={'ts-input' + (miss ? ' miss' : '')}
        value={query}
        placeholder={t('term.search.placeholder')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            find(e.shiftKey)
          }
        }}
      />
      {miss && <span className="ts-miss">{t('term.search.noMatch')}</span>}
      <button type="button" className="ts-btn" title={t('term.search.prev')} onClick={() => find(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 14l6-6 6 6" />
        </svg>
      </button>
      <button type="button" className="ts-btn" title={t('term.search.next')} onClick={() => find(false)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 10l6 6 6-6" />
        </svg>
      </button>
      <button type="button" className="ts-btn" title={t('term.search.close')} onClick={close}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
