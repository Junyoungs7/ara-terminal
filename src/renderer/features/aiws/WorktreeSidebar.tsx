import { useMemo, useState, type JSX } from 'react'
import { Folder, FolderPlus, GitBranch, ListTree, Loader2, Pin, PinOff, Plus, RotateCw, Search, Trash2, X } from 'lucide-react'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore, type PendingWorktreeCreation } from './store'
import { buildSidebarRows, shortBranch } from './sidebarRows'

/**
 * M2 라운드 2 WS-05 — AI 작업 공간 왼쪽 워크트리 목록(시안 SW-final-ai). Orca components/sidebar/WorktreeList·WorktreeCard·
 * PendingWorktreeRow·SidebarFilter·SidebarGroupByToggle(orcaRef 7a7f46f8a3)의 핵심만: 프로젝트 묶음·고정·이름 검색·묶기 전환·
 * 만드는 중 줄(진행·취소·실패 [다시]/[지우기]). 상태 점은 자리만(에이전트 상태는 M3).
 */
export function WorktreeSidebar({ onNew, onRemove }: { onNew: (repoId?: string) => void; onRemove: (w: Worktree) => void }): JSX.Element {
  const s = useAiwsStore()
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rows = useMemo(
    () =>
      buildSidebarRows({
        repos: s.repos,
        worktreesByRepo: s.worktreesByRepo,
        pending: Object.values(s.pendingWorktreeCreations),
        pinnedIds: s.pinnedIds,
        query: filterOpen ? query : '',
        groupBy: s.groupBy
      }),
    [s.repos, s.worktreesByRepo, s.pendingWorktreeCreations, s.pinnedIds, query, filterOpen, s.groupBy]
  )

  return (
    <aside className="aiws-side" aria-label={t('aiws.side.title')}>
      <div className="aiws-side-head">
        <span className="aiws-side-ttl">{t('aiws.side.title')}</span>
        <span className="aiws-side-tools">
          <button
            type="button"
            className={'aiws-ic' + (filterOpen ? ' on' : '')}
            data-aiws="filter"
            title={t('aiws.side.filter')}
            aria-pressed={filterOpen}
            onClick={() => setFilterOpen((o) => !o)}
          >
            <Search />
          </button>
          <button
            type="button"
            className={'aiws-ic' + (s.groupBy === 'none' ? ' on' : '')}
            data-aiws="group"
            title={s.groupBy === 'repo' ? t('aiws.side.groupNone') : t('aiws.side.groupRepo')}
            aria-pressed={s.groupBy === 'none'}
            onClick={() => s.setGroupBy(s.groupBy === 'repo' ? 'none' : 'repo')}
          >
            <ListTree />
          </button>
          <button type="button" className="aiws-ic" data-aiws="add-project" title={t('aiws.side.addProject')} onClick={() => void s.pickAndAddRepo()}>
            <FolderPlus />
          </button>
          <button type="button" className="aiws-ic" data-aiws="new" title={t('aiws.side.newWork')} disabled={s.repos.length === 0} onClick={() => onNew()}>
            <Plus />
          </button>
        </span>
      </div>
      {filterOpen && (
        <div className="aiws-filter">
          <input
            autoFocus
            className="aiws-input"
            data-aiws="filter-input"
            placeholder={t('aiws.side.filter')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setQuery('')
                setFilterOpen(false)
              }
            }}
          />
        </div>
      )}
      <div className="aiws-list" role="list">
        {s.repos.length === 0 && (
          <div className="aiws-side-empty">
            <span>{t('aiws.side.empty')}</span>
            <button type="button" className="btn sec" data-aiws="add-project-empty" onClick={() => void s.pickAndAddRepo()}>
              <FolderPlus />
              {t('aiws.side.addProject')}
            </button>
          </div>
        )}
        {s.repos.length > 0 && rows.length === 0 && <div className="aiws-side-empty">{t('aiws.side.noMatch')}</div>}
        {rows.map((r) => {
          if (r.kind === 'header') {
            const label = r.group === 'pinned' ? t('aiws.side.pinned') : r.group === 'all' ? t('aiws.side.all') : (r.repo?.displayName ?? '')
            return (
              <div key={r.key} className="aiws-grp" data-group={r.key} title={r.repo?.path}>
                {r.group === 'pinned' && <Pin className="aiws-grp-ic" aria-hidden />}
                <span className="aiws-grp-name">{label}</span>
                <b>{r.count}</b>
                {r.repo && (
                  <button type="button" className="aiws-ic aiws-grp-act" data-aiws="new-in" title={t('aiws.side.newWork')} onClick={() => onNew(r.repo?.id)}>
                    <Plus />
                  </button>
                )}
              </div>
            )
          }
          if (r.kind === 'pending') return <PendingRow key={r.key} p={r.creation} />
          const w = r.worktree
          const active = s.activeWorktreeId === w.id
          const st = s.statsById[w.id]
          const meta = r.repo.kind === 'folder' ? t('aiws.wt.folder') : w.isMainWorktree ? t('aiws.wt.default') : !w.branch ? t('aiws.wt.detached') : st?.ok && st.ahead > 0 ? t('aiws.wt.ahead').replace('{n}', String(st.ahead)) : ''
          return (
            <div
              key={r.key}
              role="listitem"
              className={'aiws-row' + (active ? ' act' : '')}
              data-wt={w.id}
              data-pinned={r.pinned || undefined}
              tabIndex={0}
              aria-current={active || undefined}
              title={w.path}
              onClick={() => s.setActiveWorktree(w.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') s.setActiveWorktree(w.id)
              }}
            >
              <div className="aiws-row-l1">
                {/* 상태 점 자리 — 에이전트 상태는 M3. 지금은 고른 줄만 밝힌다. */}
                <span className="aiws-dot" aria-hidden />
                {r.repo.kind === 'folder' ? <Folder className="aiws-row-ic" aria-hidden /> : <GitBranch className="aiws-row-ic" aria-hidden />}
                <span className="aiws-row-name">{w.displayName}</span>
                <span className="aiws-row-acts">
                  <button
                    type="button"
                    className="aiws-ic"
                    data-aiws={r.pinned ? 'unpin' : 'pin'}
                    title={r.pinned ? t('aiws.side.unpin') : t('aiws.side.pin')}
                    onClick={(e) => {
                      e.stopPropagation()
                      s.togglePin(w.id)
                    }}
                  >
                    {r.pinned ? <PinOff /> : <Pin />}
                  </button>
                  {!w.isMainWorktree && (
                    <button
                      type="button"
                      className="aiws-ic"
                      data-aiws="remove"
                      title={t('aiws.side.remove')}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(w)
                      }}
                    >
                      <Trash2 />
                    </button>
                  )}
                </span>
              </div>
              <div className="aiws-row-l2">
                {r.showProject && <span className="aiws-row-proj">{r.repo.displayName}</span>}
                {w.branch && shortBranch(w) !== w.displayName && <span className="aiws-mono">{shortBranch(w)}</span>}
                {meta && <span>{meta}</span>}
                {st?.ok && st.added + st.removed > 0 && (
                  <span className="aiws-diffn">
                    <span className="p">+{st.added}</span> <span className="m">−{st.removed}</span>
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

/** 만드는 중 / 실패한 줄 — Orca PendingWorktreeRow. git 출력은 마지막 줄만(진행 막대 \r 포함). */
function PendingRow({ p }: { p: PendingWorktreeCreation }): JSX.Element {
  const s = useAiwsStore()
  const failed = p.phase === 'failed'
  const pct = p.checkout?.percent
  const phase = failed ? t('aiws.pending.failed') : p.phase === 'copying' ? t('aiws.pending.copying') : p.phase === 'creating' ? t('aiws.pending.creating') : t('aiws.pending.start')
  const lastLine = p.output.split(/[\r\n]+/).filter((l) => l.trim()).pop() ?? ''
  return (
    <div className={'aiws-row aiws-pending' + (failed ? ' failed' : '')} role="listitem" data-creation={p.creationId} data-phase={p.phase}>
      <div className="aiws-row-l1">
        {failed ? <X className="aiws-row-ic" aria-hidden /> : <Loader2 className="aiws-row-ic aiws-spin" aria-hidden />}
        <span className="aiws-row-name">{p.name || p.branch}</span>
        <span className="aiws-row-acts on">
          {failed ? (
            <>
              <button
                type="button"
                className="aiws-ic"
                data-aiws="retry"
                title={t('aiws.pending.retry')}
                onClick={() => {
                  s.removePendingWorktreeCreation(p.creationId)
                  void s.createWorktree({ repoId: p.repoId, name: p.name, baseBranch: p.baseBranch })
                }}
              >
                <RotateCw />
              </button>
              <button type="button" className="aiws-ic" data-aiws="dismiss" title={t('aiws.pending.dismiss')} onClick={() => s.removePendingWorktreeCreation(p.creationId)}>
                <Trash2 />
              </button>
            </>
          ) : (
            <button type="button" className="aiws-ic" data-aiws="cancel" title={t('aiws.pending.cancel')} onClick={() => void s.cancelWorktreeCreation(p.creationId)}>
              <X />
            </button>
          )}
        </span>
      </div>
      <div className="aiws-row-l2">
        <span>{phase}</span>
        {pct !== undefined && !failed && <span className="aiws-mono">{pct}%</span>}
      </div>
      {failed && p.error ? (
        <div className="aiws-pending-err" title={p.error}>
          {p.error}
        </div>
      ) : (
        lastLine && <div className="aiws-pending-out">{lastLine}</div>
      )}
    </div>
  )
}
