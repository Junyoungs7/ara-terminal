import { useEffect, useState, type JSX } from 'react'
import type { BaseRef } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore } from './store'

/**
 * M2 라운드 2 WS-02·WS-04 — 새 작업 만들기. Orca NewWorkspaceComposerCard·new-workspace/ComposerBaseRefPicker
 * (orcaRef 7a7f46f8a3)의 순서만 따른다: 프로젝트 → 이름(브랜치) → 분기 지점(검색 가능한 브랜치/태그) → 워크트리로/없이 → 만들기.
 * 첫 지시 칸은 자리만(에이전트 실행은 M3). 뺀 것: 에이전트 고르기·이슈/PR 연결·설정 스크립트·고급 옵션.
 */
const REF_SEARCH_DEBOUNCE_MS = 150

export function NewWorkCard({ initialRepoId, onClose }: { initialRepoId?: string; onClose: () => void }): JSX.Element {
  const repos = useAiwsStore((s) => s.repos)
  const [repoId, setRepoId] = useState(initialRepoId ?? repos[0]?.id ?? '')
  const repo = repos.find((r) => r.id === repoId)
  const isGit = repo?.kind === 'git'
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'worktree' | 'none'>('worktree')
  const [base, setBase] = useState('')
  const [refQuery, setRefQuery] = useState('')
  const [refs, setRefs] = useState<BaseRef[]>([])

  useEffect(() => {
    if (!isGit) {
      setRefs([])
      return
    }
    let live = true
    const h = setTimeout(() => {
      void window.ev.repos.searchBaseRefs(repoId, refQuery).then((r) => live && setRefs(r))
    }, REF_SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(h)
    }
  }, [repoId, refQuery, isGit])

  const effectiveMode = isGit ? mode : 'none'
  const canCreate = !!repo && (effectiveMode === 'none' || name.trim() !== '')

  const create = (): void => {
    if (!repo || !canCreate) return
    const st = useAiwsStore.getState()
    if (effectiveMode === 'none') {
      st.openWithoutWorktree(repo.id)
      onClose()
      return
    }
    // 바로 닫는다 — 진행은 사이드바 줄이 보여 준다(WS-03). 다 만들어지면 그 워크트리를 고른다.
    onClose()
    void st.createWorktree({ repoId: repo.id, name: name.trim(), baseBranch: base || undefined }).then((r) => {
      if (r.ok) useAiwsStore.getState().setActiveWorktree(r.worktree.id)
    })
  }

  return (
    <div
      className="aiws-new"
      role="dialog"
      aria-label={t('aiws.new.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <h2 className="aiws-new-ttl">{t('aiws.new.title')}</h2>
      {repos.length === 0 ? (
        <p className="aiws-note">{t('aiws.new.noProject')}</p>
      ) : (
        <>
          <label className="aiws-field">
            <span>{t('aiws.new.project')}</span>
            <select className="aiws-input" data-aiws="new-project" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName}
                </option>
              ))}
            </select>
          </label>

          <div className="aiws-field" role="radiogroup" aria-label={t('aiws.new.mode')}>
            <span>{t('aiws.new.mode')}</span>
            <div className="aiws-modes">
              {(['worktree', 'none'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === m}
                  className={'aiws-mode' + (effectiveMode === m ? ' on' : '')}
                  data-mode={m}
                  disabled={m === 'worktree' && !isGit}
                  onClick={() => setMode(m)}
                >
                  <b>{m === 'worktree' ? t('aiws.new.modeWt') : t('aiws.new.modeNone')}</b>
                  <span>{m === 'worktree' ? t('aiws.new.modeWtDesc') : t('aiws.new.modeNoneDesc')}</span>
                </button>
              ))}
            </div>
            {!isGit && <p className="aiws-note">{t('aiws.new.folderOnly')}</p>}
          </div>

          {effectiveMode === 'worktree' && (
            <>
              <label className="aiws-field">
                <span>{t('aiws.new.name')}</span>
                <input
                  autoFocus
                  className="aiws-input"
                  data-aiws="new-name"
                  placeholder={t('aiws.new.namePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') create()
                  }}
                />
              </label>
              <div className="aiws-field">
                <span>
                  {t('aiws.new.base')} · <b className="aiws-mono" data-aiws="new-base-value">{base || t('aiws.new.baseHead')}</b>
                </span>
                <input
                  className="aiws-input"
                  data-aiws="new-base-search"
                  placeholder={t('aiws.new.baseSearch')}
                  value={refQuery}
                  onChange={(e) => setRefQuery(e.target.value)}
                />
                <div className="aiws-refs" role="listbox" aria-label={t('aiws.new.base')}>
                  <button type="button" role="option" aria-selected={base === ''} className={'aiws-ref' + (base === '' ? ' on' : '')} onClick={() => setBase('')}>
                    <span className="aiws-mono">HEAD</span>
                    <span className="aiws-ref-kind">{t('aiws.new.baseHead')}</span>
                  </button>
                  {refs.map((r) => (
                    <button
                      key={r.refName}
                      type="button"
                      role="option"
                      aria-selected={base === r.refName}
                      className={'aiws-ref' + (base === r.refName ? ' on' : '')}
                      data-ref={r.refName}
                      onClick={() => setBase(r.refName)}
                    >
                      <span className="aiws-mono">{r.refName}</span>
                      <span className="aiws-ref-kind">{t('aiws.ref.' + r.kind)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="aiws-field">
            <span>{t('aiws.new.prompt')}</span>
            {/* 에이전트 실행은 M3 — 칸만 세워 둔다. */}
            <textarea className="aiws-input" rows={3} disabled placeholder={t('aiws.new.promptPh')} />
          </label>
        </>
      )}
      <div className="aiws-new-foot">
        <button type="button" className="btn sec" data-aiws="new-cancel" onClick={onClose}>
          {t('aiws.new.cancel')}
        </button>
        <button type="button" className="btn pri" data-aiws="new-create" disabled={!canCreate} onClick={create}>
          {t('aiws.new.create')}
        </button>
      </div>
    </div>
  )
}
