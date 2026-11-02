// M10 R2 작업 단위 대화상자 셋 — 사이드바가 연다. 공용 Dialog(ask/askText)로는 목록·여러 칸을 못 담아 같은 .overlay/.modal 모양으로 따로 그린다.
// 출처: stablyai/orca @fdfcfb3551 (MIT)
//  · 체크포인트(WS-18) — components/sidebar/WorktreeMetaDialogDraft.tsx(메모 칸) + workspace-status-defaults.ts(상태 넷)
//  · 아라 밖 워크트리(WS-19) — components/sidebar/WorktreeVisibilityDialog.tsx·HiddenWorktreeRecoveryList.tsx·WorktreeVisibilitySourceList.tsx
//  · 남긴 브랜치 검토(WS-21) — components/sidebar/PreservedBranchBatchReviewDialog.tsx
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { EXTERNAL_SOURCES, WORKSPACE_STATUSES, WORKTREE_COMMENT_MAX, externalVisibilityOf, type Project, type WorkspaceStatus, type Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore, type PreservedBranchItem } from './store'

export function Modal({
  title,
  onClose,
  children,
  foot,
  danger,
  className
}: {
  title: string
  onClose: () => void
  children: ReactNode
  foot: ReactNode
  danger?: boolean
  /** 3차 정리 화면처럼 넓은 대화상자. */
  className?: string
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="overlay open dlg-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal sm aiws-dlg' + (danger ? ' danger' : '') + (className ? ' ' + className : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-hd">
          <h2>{title}</h2>
        </div>
        <div className="dlg-body">{children}</div>
        <div className="modal-ft">
          <span className="sp" />
          {foot}
        </div>
      </div>
    </div>
  )
}

/** WS-18 체크포인트 — 자유 메모 + 카드 상태(Orca `orca worktree set --comment --workspace-status`). 빈 메모·상태 없음 = 지움. */
export function CheckpointDialog({ worktree, onClose }: { worktree: Worktree; onClose: () => void }): JSX.Element {
  const [comment, setComment] = useState(worktree.comment ?? '')
  const [status, setStatus] = useState<WorkspaceStatus | ''>(worktree.workspaceStatus ?? '')
  const save = (): void => {
    void useAiwsStore.getState().updateWorktreeMeta(worktree.id, { comment, workspaceStatus: status || null })
    onClose()
  }
  return (
    <Modal
      title={t('aiws.cp.title').replace('{w}', worktree.displayName)}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn pri" data-aiws="cp-save" onClick={save}>
            {t('aiws.cp.save')}
          </button>
        </>
      }
    >
      <p className="dlg-msg">{t('aiws.cp.msg')}</p>
      <textarea
        className="dlg-input aiws-cp-text"
        data-aiws="cp-comment"
        autoFocus
        rows={5}
        maxLength={WORKTREE_COMMENT_MAX}
        placeholder={t('aiws.cp.ph')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="aiws-cp-status" role="radiogroup" aria-label={t('aiws.cp.status')}>
        {(['', ...WORKSPACE_STATUSES] as const).map((id) => (
          <button
            key={id || 'none'}
            type="button"
            role="radio"
            aria-checked={status === id}
            className={'aiws-chip' + (status === id ? ' on' : '')}
            data-status={id || 'none'}
            onClick={() => setStatus(id)}
          >
            {t('aiws.status.' + (id || 'none'))}
          </button>
        ))}
      </div>
    </Modal>
  )
}

/**
 * WS-19 아라 밖 워크트리 — 출처(Claude Code·GSD·그 밖)별 보이기와 하나씩 [보이기]/[숨기기](Orca Non-Orca worktrees 대화상자).
 * 하나씩은 "보인 경로" 목록에 넣고 빼기만 한다(Orca importedExternalWorktreePaths) — 출처 설정으로 보이는 것은 출처를 끄면 숨는다.
 */
export function ExternalWorktreesDialog({ repo, onClose }: { repo: Project; onClose: () => void }): JSX.Element {
  const s = useAiwsStore()
  const p = s.repos.find((r) => r.id === repo.id) ?? repo
  const list = (s.worktreesByRepo[p.id] ?? []).filter((w) => w.external)
  const shownPaths = p.shownExternalPaths ?? []
  const setShown = (w: Worktree, on: boolean): void =>
    void s.updateRepo(p.id, { shownExternalPaths: on ? [...shownPaths, w.path] : shownPaths.filter((x) => x !== w.path) })
  return (
    <Modal
      title={t('aiws.ext.title').replace('{p}', p.displayName)}
      onClose={onClose}
      foot={
        <button type="button" className="btn pri" onClick={onClose}>
          {t('aiws.ext.done')}
        </button>
      }
    >
      <p className="dlg-msg">{t('aiws.ext.msg')}</p>
      <div className="aiws-ext-src" data-aiws="ext-sources">
        {EXTERNAL_SOURCES.map((src) => {
          const on = externalVisibilityOf(p, src) === 'show'
          return (
            <label key={src} className="aiws-ext-src-row">
              <input
                type="checkbox"
                data-source={src}
                checked={on}
                onChange={(e) => void s.updateRepo(p.id, { externalVisibility: { ...p.externalVisibility, [src]: e.target.checked ? 'show' : 'hide' } })}
              />
              <span>{t('aiws.ext.src.' + src)}</span>
            </label>
          )
        })}
      </div>
      {list.length === 0 ? (
        <p className="dlg-msg aiws-ext-empty">{t('aiws.ext.none')}</p>
      ) : (
        <div className="aiws-ext-list" role="list">
          {list.map((w) => {
            const byPath = shownPaths.includes(w.path)
            return (
              <div key={w.id} className="aiws-ext-row" role="listitem" data-ext={w.path} data-hidden={w.hidden || undefined}>
                <span className="aiws-ext-name">{w.displayName}</span>
                <span className="aiws-ext-path" title={w.path}>
                  {t('aiws.ext.src.' + (w.external ?? 'other'))} · {w.path}
                </span>
                {w.hidden ? (
                  <button type="button" className="btn sec" data-aiws="ext-show" onClick={() => setShown(w, true)}>
                    {t('aiws.ext.show')}
                  </button>
                ) : byPath ? (
                  <button type="button" className="btn sec" data-aiws="ext-hide" onClick={() => setShown(w, false)}>
                    {t('aiws.ext.hide')}
                  </button>
                ) : (
                  <span className="aiws-ext-note">{t('aiws.ext.bySource')}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

/** WS-21 남긴 브랜치 검토 — 고른 것을 강제로 지운다(기본 전부 고름, Orca 와 같다). 안 고른 것은 저장소에 그대로. */
export function PreservedBranchesDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const items = useAiwsStore((s) => s.preservedBranches)
  const key = (b: PreservedBranchItem): string => `${b.repoId}\0${b.branchName}`
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(items.map(key)))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ item: PreservedBranchItem; message: string }[]>([])
  const chosen = items.filter((b) => picked.has(key(b)))
  const all = chosen.length === items.length && items.length > 0
  const run = async (): Promise<void> => {
    setBusy(true)
    const failed = await useAiwsStore.getState().forceDeletePreservedBranches(chosen)
    setBusy(false)
    setErrors(failed)
    if (failed.length === 0) onClose()
  }
  return (
    <Modal
      title={t('aiws.branch.reviewTitle')}
      danger
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn dgr" data-aiws="branch-force" disabled={busy || chosen.length === 0} onClick={() => void run()}>
            {t('aiws.branch.force').replace('{n}', String(chosen.length))}
          </button>
        </>
      }
    >
      <p className="dlg-msg">{t('aiws.branch.reviewMsg')}</p>
      <label className="aiws-ext-src-row">
        <input type="checkbox" checked={all} onChange={(e) => setPicked(new Set(e.target.checked ? items.map(key) : []))} />
        <span>
          {t('aiws.branch.selectAll')} · {t('aiws.branch.selected').replace('{n}', String(chosen.length)).replace('{m}', String(items.length))}
        </span>
      </label>
      <div className="aiws-ext-list" role="list">
        {items.map((b) => (
          <label key={key(b)} className="aiws-ext-row" role="listitem" data-branch={b.branchName}>
            <input
              type="checkbox"
              checked={picked.has(key(b))}
              onChange={(e) => {
                const next = new Set(picked)
                if (e.target.checked) next.add(key(b))
                else next.delete(key(b))
                setPicked(next)
              }}
            />
            <span className="aiws-ext-name">{b.branchName}</span>
            <span className="aiws-ext-path">
              {t('aiws.branch.mayUnmerged')} · {b.head.slice(0, 8)} · {b.worktreeName}
            </span>
          </label>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="dlg-detail" data-aiws="branch-errors">
          {errors.map((x) => (
            <div className="dlg-row" key={key(x.item)}>
              <span className="dlg-k">{x.item.branchName}</span>
              <span className="dlg-v">{x.message}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/**
 * WS-20 공유 경로(Orca Settings › Repository › Worktree Shared Paths) — 한 줄에 하나, 본 폴더 기준. 새 워크트리에 링크(폴더는 Windows 접합점)로 만든다.
 * 이미 만든 워크트리엔 안 붙인다(Orca 와 같다 — 만들 때만). 지울 때는 링크를 먼저 끊는다.
 */
export function SharedPathsDialog({ repo, onClose }: { repo: Project; onClose: () => void }): JSX.Element {
  const [text, setText] = useState((repo.sharedPaths ?? []).join('\n'))
  const save = (): void => {
    void useAiwsStore.getState().updateRepo(repo.id, { sharedPaths: text.split(/\r?\n/) })
    onClose()
  }
  return (
    <Modal
      title={t('aiws.shared.title').replace('{p}', repo.displayName)}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn pri" data-aiws="shared-save" onClick={save}>
            {t('aiws.cp.save')}
          </button>
        </>
      }
    >
      <p className="dlg-msg">{t('aiws.shared.msg')}</p>
      <textarea className="dlg-input aiws-cp-text" data-aiws="shared-paths" autoFocus rows={5} placeholder={t('aiws.shared.ph')} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}
