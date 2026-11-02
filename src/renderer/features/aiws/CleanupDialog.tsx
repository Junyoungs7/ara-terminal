// 3차 WS-25·26 작업 단위 정리 화면 — 사이드바 [정리] 를 누를 때만 불러온다(지연 로드).
// 출처: stablyai/orca @ec112c6b01 (MIT) — Resource Manager › Clean up workspaces(docs model/worktrees.mdx "Resource Manager cleanup"),
// main/workspace-cleanup-scan-snapshot.ts(상태·최근 활동·크기·git 상태), components/workspace-space/WorkspaceSpacePage.tsx(크기 재기).
// 아라판: 모든 로컬 git 프로젝트의 연결 작업 단위를 한 목록에 — 검색·거르기(병합됨·오래됨·잠듦/보관)·정렬(오래된 순·크기·이름),
// 고른 것을 한 번 확인하고 지운다(지우기 규칙은 M10 R2 그대로: 링크 먼저 끊기 → git worktree remove → branch -d, 병합 안 된 브랜치는 검토로).
// **강제로 지우지 않는다** — 커밋 안 한 변경이 있으면 git 이 거절하고 그 사유를 이 화면에 보인다(하나씩 사이드바에서 강제로).
// 뺀 것: 본 작업 폴더·폴더 프로젝트·끊긴 SSH 서버 줄(Orca 는 넣는다 — 아라에선 "지우기"가 목록에서 빼기라 정리 화면 뜻과 다르다), 연결된 리뷰(PR) 칸.
import { useEffect, useMemo, useState, type JSX } from 'react'
import type { CleanupGitInfo, DiskUsage, Project, Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore } from './store'
import { useDialog } from '../../components/Dialog'
import { Modal } from './WorktreeDialogs'

/** "오래됨" 기준 — 마지막 커밋(없으면 만든 때)이 이보다 오래. ponytail: 30일 고정, 바꾸고 싶다는 말이 나오면 설정으로. */
export const STALE_DAYS = 30
const DAY_MS = 86_400_000

export type CleanupFilter = 'all' | 'merged' | 'stale' | 'idle'
export type CleanupSort = 'age' | 'size' | 'name'
export type CleanupRow = { w: Worktree; repo: Project; git?: CleanupGitInfo; size?: DiskUsage; activeAt: number | null }

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** 거르기·검색·정렬(순수 — 시험이 바로 부른다). 오래된 순 = 최근 활동이 가장 먼 것부터(모르는 것은 맨 뒤). */
export function filterCleanupRows(rows: readonly CleanupRow[], filter: CleanupFilter, query: string, sort: CleanupSort, now: number): CleanupRow[] {
  const q = query.trim().toLowerCase()
  const stale = (r: CleanupRow): boolean => r.activeAt !== null && now - r.activeAt > STALE_DAYS * DAY_MS
  const out = rows.filter((r) => {
    if (filter === 'merged' && !r.git?.merged) return false
    if (filter === 'stale' && !stale(r)) return false
    if (filter === 'idle' && !r.w.sleep && !r.w.isArchived) return false
    return !q || [r.w.displayName, r.w.branch, r.w.path, r.repo.displayName].some((x) => x.toLowerCase().includes(q))
  })
  const age = (r: CleanupRow): number => r.activeAt ?? Number.POSITIVE_INFINITY
  return out.sort((a, b) =>
    sort === 'size' ? (b.size?.bytes ?? -1) - (a.size?.bytes ?? -1) : sort === 'name' ? a.w.displayName.localeCompare(b.w.displayName, 'ko') : age(a) - age(b)
  )
}

export default function CleanupDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const repos = useAiwsStore((s) => s.repos)
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const local = useMemo(() => repos.filter((r) => r.kind === 'git' && !r.host), [repos])
  const [gitInfo, setGitInfo] = useState<Record<string, CleanupGitInfo>>({})
  const [scanning, setScanning] = useState(true)
  const [sizes, setSizes] = useState<Record<string, DiskUsage>>({})
  const [sizing, setSizing] = useState(false)
  const [filter, setFilter] = useState<CleanupFilter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CleanupSort>('age')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ name: string; message: string }[]>([])
  const dialog = useDialog()

  // 열 때 한 번 — 프로젝트마다 git 상태(main 이 넷씩 돈다).
  useEffect(() => {
    let alive = true
    void Promise.all(local.map((r) => window.ev.worktrees.cleanupScan(r.id).catch(() => [] as CleanupGitInfo[]))).then((lists) => {
      if (!alive) return
      setGitInfo(Object.fromEntries(lists.flat().map((g) => [g.path, g])))
      setScanning(false)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 열 때 한 번(지운 뒤엔 목록에서 빠지기만 한다)
  }, [])

  const rows = useMemo<CleanupRow[]>(
    () =>
      local.flatMap((repo) =>
        (byRepo[repo.id] ?? [])
          .filter((w) => !w.isMainWorktree && !w.hidden)
          .map((w) => {
            const git = gitInfo[w.path]
            const times = [git?.lastCommitAt, w.createdAt].filter((x): x is number => typeof x === 'number')
            return { w, repo, git, size: sizes[w.path], activeAt: times.length ? Math.max(...times) : null }
          })
      ),
    [local, byRepo, gitInfo, sizes]
  )
  const shown = filterCleanupRows(rows, filter, query, sort, Date.now())
  const chosen = rows.filter((r) => picked.has(r.w.id))
  const total = shown.reduce((a, r) => a + (r.size?.bytes ?? 0), 0)

  const measure = async (): Promise<void> => {
    setSizing(true)
    try {
      for (const repo of local) {
        const paths = rows.filter((r) => r.repo.id === repo.id).map((r) => r.w.path)
        if (paths.length === 0) continue
        const items = await window.ev.worktrees.diskUsage(repo.id, paths).catch(() => [] as DiskUsage[])
        setSizes((prev) => ({ ...prev, ...Object.fromEntries(items.map((u) => [u.path, u])) }))
      }
    } finally {
      setSizing(false)
    }
  }

  const remove = async (): Promise<void> => {
    const yes = await dialog.ask({
      title: t('aiws.cleanup.confirmTitle').replace('{n}', String(chosen.length)),
      message: t('aiws.cleanup.confirmMsg'),
      detail: chosen.map((r) => ({ label: r.w.displayName, value: r.w.path })),
      tone: 'danger',
      confirmLabel: t('aiws.remove.confirm')
    })
    if (yes !== 'confirm') return
    setBusy(true)
    const failed: { name: string; message: string }[] = []
    for (const r of chosen) {
      const res = await useAiwsStore.getState().removeWorktree(r.w.id)
      if (!res.ok) failed.push({ name: r.w.displayName, message: res.message })
    }
    setBusy(false)
    setErrors(failed)
    setPicked(new Set())
  }

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  const now = Date.now()

  return (
    <Modal
      title={t('aiws.cleanup.title')}
      className="aiws-cleanup"
      onClose={onClose}
      foot={
        <>
          <span className="aiws-cleanup-total" data-aiws="cleanup-total">
            {total > 0 ? t('aiws.cleanup.total').replace('{size}', fmtBytes(total)) : ''}
          </span>
          <button type="button" className="btn sec" data-aiws="cleanup-measure" disabled={sizing || rows.length === 0} onClick={() => void measure()}>
            {sizing ? t('aiws.cleanup.measuring') : t('aiws.cleanup.measure')}
          </button>
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.close')}
          </button>
          <button type="button" className="btn dgr" data-aiws="cleanup-remove" disabled={busy || chosen.length === 0} onClick={() => void remove()}>
            {t('aiws.cleanup.remove').replace('{n}', String(chosen.length))}
          </button>
        </>
      }
    >
      <p className="dlg-msg">{t('aiws.cleanup.msg')}</p>
      <div className="aiws-cleanup-bar">
        <input className="dlg-input" data-aiws="cleanup-search" placeholder={t('aiws.side.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="dlg-input" data-aiws="cleanup-sort" value={sort} onChange={(e) => setSort(e.target.value as CleanupSort)}>
          {(['age', 'size', 'name'] as const).map((k) => (
            <option key={k} value={k}>
              {t('aiws.cleanup.sort.' + k)}
            </option>
          ))}
        </select>
      </div>
      <div className="aiws-cp-status" role="radiogroup" aria-label={t('aiws.cleanup.filter')}>
        {(['all', 'merged', 'stale', 'idle'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={filter === k} className={'aiws-chip' + (filter === k ? ' on' : '')} data-filter={k} onClick={() => setFilter(k)}>
            {t('aiws.cleanup.f.' + k)}
          </button>
        ))}
      </div>
      {scanning ? (
        <p className="dlg-msg aiws-ext-empty">{t('aiws.cleanup.scanning')}</p>
      ) : shown.length === 0 ? (
        <p className="dlg-msg aiws-ext-empty">{t('aiws.cleanup.none')}</p>
      ) : (
        <div className="aiws-ext-list" role="list" data-aiws="cleanup-list">
          {shown.map((r) => {
            const days = r.activeAt === null ? null : Math.floor((now - r.activeAt) / DAY_MS)
            return (
              <label key={r.w.id} className="aiws-ext-row aiws-cleanup-row" role="listitem" data-wt={r.w.id}>
                <input type="checkbox" checked={picked.has(r.w.id)} onChange={(e) => toggle(r.w.id, e.target.checked)} />
                <span className="aiws-ext-name">{r.w.displayName}</span>
                <span className="aiws-cleanup-tags">
                  {r.git?.merged && <span className="aiws-status">{t('aiws.cleanup.tag.merged')}</span>}
                  {r.git && r.git.dirty > 0 && <span className="aiws-status aiws-warn">{t('aiws.cleanup.tag.dirty').replace('{n}', String(r.git.dirty))}</span>}
                  {r.w.sleep && <span className="aiws-status">{t('aiws.sleep.asleep')}</span>}
                  {r.w.isArchived && <span className="aiws-status">{t('aiws.cleanup.tag.archived')}</span>}
                  {r.size && (
                    <span className="aiws-status" title={r.size.top.map((x) => `${x.name} ${fmtBytes(x.bytes)}`).join('\n')}>
                      {fmtBytes(r.size.bytes)}
                      {r.size.truncated ? '+' : ''}
                    </span>
                  )}
                </span>
                <span className="aiws-ext-path" title={r.w.path}>
                  {r.repo.displayName} · {days === null ? t('aiws.cleanup.ageUnknown') : t('aiws.cleanup.age').replace('{n}', String(days))} · {r.w.path}
                </span>
              </label>
            )
          })}
        </div>
      )}
      {errors.length > 0 && (
        <div className="dlg-detail" data-aiws="cleanup-errors">
          {errors.map((x) => (
            <div className="dlg-row" key={x.name}>
              <span className="dlg-k">{x.name}</span>
              <span className="dlg-v">{x.message}</span>
            </div>
          ))}
        </div>
      )}
      {dialog.node}
    </Modal>
  )
}
