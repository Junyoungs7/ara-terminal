// 작업 프로필 팝업 — 저장해 둔 "서버 + 시작 폴더"를 고르면 그리로 접속한다.
// 트리에 새 행을 만들지 않는 것이 이 화면의 존재 이유다(준영님 안): 한 서버에 작업 위치가 여러 개여도
// 사이드바 계층은 그대로고, 로컬 폴더도 같은 목록에 나란히 둘 수 있다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { PenLine, Star, X } from 'lucide-react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import { matchWorkProfile } from '../store/workProfiles'
import { IconClose, inlineIcon } from './icons'
import { t } from '../i18n'

type Props = {
  open: boolean
  list: WorkProfile[]
  profiles: ConnectionProfile[]
  onClose: () => void
  onPick: (w: WorkProfile) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
}

export function WorkProfileModal({ open, list, profiles, onClose, onPick, onRename, onDelete }: Props): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const nameOf = useMemo(() => {
    const byId = new Map(profiles.map((p) => [p.id, p]))
    return (w: WorkProfile) => (w.profileId ? (byId.get(w.profileId)?.name ?? '?') : t('conn.group.local'))
  }, [profiles])
  const hostOf = useMemo(() => {
    const byId = new Map(profiles.map((p) => [p.id, p]))
    return (w: WorkProfile) => (w.profileId ? (byId.get(w.profileId)?.host ?? '') : '')
  }, [profiles])

  const shown = list.filter((w) => matchWorkProfile(w, nameOf(w), query))

  useEffect(() => {
    if (open) {
      setQuery('')
      setIdx(0)
      // 목록이 길어지면 타이핑이 스크롤보다 빠르다 — 열자마자 검색에 커서를 둔다.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const onKey = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Escape') return onClose()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setIdx((i) => (shown.length ? (i + d + shown.length) % shown.length : 0))
    } else if (e.key === 'Enter' && shown[idx]) {
      e.preventDefault()
      onPick(shown[idx])
    }
  }

  return (
    <div className="overlay open dlg-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wp-modal" role="dialog" aria-modal="true" aria-label={t('work.title')} onKeyDown={onKey}>
        <div className="modal-hd">
          <b>{t('work.title')}</b>
          <span className="wp-sub">{t('work.subtitle')}</span>
          <span className="sb-tab-spacer" />
          <span className="mon-close" title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </span>
        </div>
        <div className="sb-search wp-search">
          <div className="field">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={t('work.search')}
              aria-label={t('work.search')}
              onChange={(e) => {
                setQuery(e.target.value)
                setIdx(0)
              }}
            />
          </div>
        </div>
        <div className="wp-list">
          {list.length === 0 && <div className="sftp-empty">{t('work.empty')}</div>}
          {list.length > 0 && shown.length === 0 && <div className="sftp-empty">{t('conn.search.noMatch')}</div>}
          {shown.map((w, i) => (
            <div
              key={w.id}
              className={'wp-row' + (i === idx ? ' cur' : '')}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onPick(w)}
              title={`${w.path}${hostOf(w) ? ' · ' + hostOf(w) : ''}`}
            >
              <span className="wp-star">
                <Star size={12} style={inlineIcon} />
              </span>
              {/* 두 줄: [이름 … 서버] / [경로]. 서버·호스트를 오른쪽에 두 줄로 쌓았더니 이름·경로와
                  세로로 엇갈려 읽기 어려웠다(준영님 제보) — 서버는 이름과 같은 줄 끝에 칩으로 붙이고
                  호스트는 툴팁으로 내린다(목록에서 매번 필요한 정보가 아니다). */}
              <span className="wp-main">
                <span className="wp-l1">
                  <span className="wp-name">{w.name}</span>
                  <span className="wp-srv" title={hostOf(w)}>
                    {nameOf(w)}
                  </span>
                </span>
                <span className="wp-path">{w.path}</span>
              </span>
              {/* 이름 변경·삭제는 행에서 바로. 목록이 곧 관리 화면이라 별도 설정 페이지를 만들지 않는다. */}
              <span className="wp-act">
                <span
                  className="cc-b"
                  title={t('work.rename')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRename(w.id)
                  }}
                >
                  {/* `.wp-act .cc-b` 에는 `.rowact .cc-b svg` 같은 크기 규칙이 없다 —
                      트리 행 액션과 같아 보이도록 그쪽과 같은 11px 로 맞춘다.
                      Pencil 이 아니라 PenLine 인 이유: icons.tsx 의 IconPencil(탐색기 [이름 바꾸기])이
                      "밑줄 + 연필"이다. 같은 뜻에 다른 그림을 두지 않는다. */}
                  <PenLine size={11} style={inlineIcon} />
                </span>
                <span
                  className="cc-b danger"
                  title={t('work.delete')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(w.id)
                  }}
                >
                  <X size={11} style={inlineIcon} />
                </span>
              </span>
            </div>
          ))}
        </div>
        <div className="modal-ft">
          <span className="wp-hint">{t('work.hint')}</span>
          <span className="sb-tab-spacer" />
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.close')}
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={!shown[idx]}
            onClick={() => shown[idx] && onPick(shown[idx])}
          >
            {t('work.connect')}
          </button>
        </div>
      </div>
    </div>
  )
}
