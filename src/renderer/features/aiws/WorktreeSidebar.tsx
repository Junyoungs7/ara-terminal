import { Suspense, lazy, useEffect, useMemo, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Eraser,
  EyeOff,
  Folder,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  ListTree,
  Loader2,
  Moon,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Search,
  Sun,
  Trash2,
  X
} from 'lucide-react'
import { lineageChildren, lineageDescendants, type Project, type ProjectGroup, type Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore, type PendingWorktreeCreation } from './store'
import { DELETE_KEY_HINT, buildSidebarRows, isDeleteWorkspaceKey, shortBranch } from './sidebarRows'
import { LOCAL_HOST, hostSections } from '../../store/hostSections'
import type { ConnectionProfile } from '@shared/types'
import type { GroupLayout } from '../../store/groups'
import { useAgentStore } from './agentStore'
import { aggregate, displayOf } from './agentStatusView'
import { AgentChildRows, AgentGlyph } from './AgentGlyph'
import { ContextMenu, type MenuItem } from '../../interactions/ContextMenu'
import { useDialog } from '../../components/Dialog'
import { pushNote } from '../../store/notify'
import { archiveWorktree, restoreWorktree, sleepWorktree, wakeWorktree, type SleepRefusal } from './sleep'
import { CheckpointDialog, ExternalWorktreesDialog, PreservedBranchesDialog, SharedPathsDialog } from './WorktreeDialogs'
import { SetupGuideModal, SetupGuideSidebarEntry } from './setupGuide/SetupGuide'
import { setSetupGuideHidden } from './setupGuide/useSetupGuide'

// 3차 WS-25·26 정리 화면 — 열 때만 불러온다(지연 로드).
const CleanupDialog = lazy(() => import('./CleanupDialog'))

type Menu = { x: number; y: number; items: MenuItem[]; pick: (id: string) => void }

/**
 * M2 라운드 2 WS-05 — AI 작업 공간 왼쪽 워크트리 목록(시안 SW-final-ai). Orca components/sidebar/WorktreeList·WorktreeCard·
 * PendingWorktreeRow·SidebarFilter·SidebarGroupByToggle(orcaRef 7a7f46f8a3)의 핵심만: 프로젝트 묶음·고정·이름 검색·묶기 전환·
 * 만드는 중 줄(진행·취소·실패 [다시]/[지우기]). M3 R2: 줄 앞 상태 글리프 = 그 작업 단위 에이전트 탭들 중 손댈 일이 큰 것(AI-11),
 * 그 아래 서브에이전트 자식 줄(AI-06).
 * M10(orcaRef fdfcfb3551): 프로젝트 그룹(WS-15 — 프로젝트 머리줄 우클릭/⋯ 의 "그룹으로 옮기기", 그룹 머리줄 접기·이름·지우기 —
 * Orca use-worktree-context-menu-commands·use-project-group-dialogs), 재우기·보관(WS-16 — 줄 우클릭·버튼, 보관함 토글),
 * 삭제 단축키(WS-17 — Orca workspace.delete, 늘 확인 대화상자를 거친다).
 * M10 R2: 체크포인트(WS-18 — 줄 우클릭 "메모·상태", 둘째 줄에 상태·메모 첫 줄), 아라 밖 워크트리(WS-19 — "숨은 워크트리 n개" 카드·프로젝트 메뉴),
 * 공유 경로(WS-20 — 프로젝트 메뉴), 남긴 브랜치 검토(WS-21 — 머리 아래 띠 → 검토 대화상자).
 */
export function WorktreeSidebar({ onNew, onRemove }: { onNew: (repoId?: string) => void; onRemove: (w: Worktree) => void }): JSX.Element {
  const s = useAiwsStore()
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const agentTabs = useAgentStore((a) => a.tabs)
  const statusById = useAgentStore((a) => a.statusById)
  const seenById = useAgentStore((a) => a.seenById)
  const dialog = useDialog()
  const [menu, setMenu] = useState<Menu | null>(null)
  const [cpFor, setCpFor] = useState<Worktree | null>(null)
  const [extFor, setExtFor] = useState<Project | null>(null)
  const [sharedFor, setSharedFor] = useState<Project | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  // 3차 WS-24 계보 — 모든 작업 단위로 푼다(낡은 연결·고리 제외). 메뉴의 "자손까지" 수와 지우기 순서에 쓴다.
  const lineage = useMemo(() => lineageChildren(Object.values(s.worktreesByRepo).flat()), [s.worktreesByRepo])
  const descendantsOf = (w: Worktree): Worktree[] => {
    const all = Object.values(useAiwsStore.getState().worktreesByRepo).flat()
    return lineageDescendants(lineageChildren(all), w.id).flatMap((id) => all.filter((x) => x.id === id))
  }
  // WS-24 자손이 있으면 "자손까지 지우기" — 한 번 확인하고 깊은 자손부터 지운다(Orca Delete with Descendants). 없으면 예전 길(AiSpace 확인).
  const removeWithLineage = (w: Worktree): void => {
    const desc = descendantsOf(w)
    if (desc.length === 0) return onRemove(w)
    void dialog
      .ask({
        title: t('aiws.lineage.deleteTitle'),
        message: t('aiws.lineage.deleteMsg').replace('{w}', w.displayName).replace('{n}', String(desc.length)),
        detail: desc.map((d) => ({ label: d.displayName, value: d.path })),
        tone: 'danger',
        confirmLabel: t('aiws.remove.confirm')
      })
      .then(async (r) => {
        if (r !== 'confirm') return
        const failed: string[] = []
        for (const x of [...desc, w]) {
          const res = await useAiwsStore.getState().removeWorktree(x.id)
          if (!res.ok) failed.push(`${x.displayName}: ${res.message}`)
        }
        if (failed.length > 0) note(t('aiws.lineage.deleteFailed').replace('{n}', String(failed.length)), failed.join('\n'))
      })
  }
  // WS-24 자손까지 재우기(Orca Sleep with Descendants) — 살아 있는 탭이 있는 것만 재운다.
  const sleepWithLineage = async (w: Worktree): Promise<void> => {
    for (const x of [w, ...descendantsOf(w)]) {
      if (x.sleep || !useAgentStore.getState().tabs.some((a) => a.worktreeId === x.id && !a.exited)) continue
      refused(await sleepWorktree(x.id))
    }
  }
  // 프로젝트를 목록에서 빼기 — 디스크의 저장소·워크트리는 그대로(Orca confirm-remove-folder · repos:remove).
  const onRemoveProject = (repo: Project): void => {
    void dialog
      .ask({ title: t('aiws.project.remove'), message: t('aiws.project.removeMsg').replace('{p}', repo.displayName).replace('{path}', repo.path), confirmLabel: t('aiws.project.removeConfirm') })
      .then((r) => {
        if (r === 'confirm') void useAiwsStore.getState().removeRepo(repo.id)
      })
  }

  const note = (title: string, body?: string): void => void pushNote({ kind: 'info', space: 'ai', title, ...(body ? { body } : {}) })
  const refused = (r: SleepRefusal | null): void => {
    if (r) note(t('aiws.sleep.refused.' + r))
  }
  const wake = async (w: Worktree): Promise<void> => {
    const missed = await wakeWorktree(w.id)
    if (missed > 0) note(t('aiws.sleep.missed').replace('{n}', String(missed)).replace('{w}', w.displayName), t('aiws.sleep.missed.body'))
  }
  // 줄을 고르면 가운데는 그 작업 단위로(대시보드·피드를 보고 있었어도). 잠든 것이면 깨운다(Orca: 다시 열면 깨어남). 보관함의 줄은 고르지 않는다.
  const pickWorktree = (w: Worktree): void => {
    if (w.isArchived) return
    s.setActiveWorktree(w.id)
    useAgentStore.getState().setView('worktree')
    if (w.sleep) void wake(w)
  }

  // WS-17 삭제 단축키 — 고른 작업 단위를 지운다(늘 확인 대화상자). 본 작업 폴더면 프로젝트를 목록에서 빼기(Orca confirm-remove-folder).
  // 창 캡처 단계 — 에이전트 터미널(xterm)보다 먼저(Orca allowInTerminal). KEYMAP 밖: 터미널 공간에선 뜻이 없다(Ctrl+P 와 같은 이유).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isDeleteWorkspaceKey(e)) return
      const st = useAiwsStore.getState()
      const w = st.activeWorktreeId ? Object.values(st.worktreesByRepo).flat().find((x) => x.id === st.activeWorktreeId) : undefined
      if (!w) return
      e.preventDefault()
      e.stopPropagation()
      const repo = st.repos.find((r) => r.id === w.repoId)
      if (!w.isMainWorktree) removeWithLineage(w)
      else if (repo) onRemoveProject(repo)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRemoveProject 는 dialog.ask 만 쓴다(매 렌더 새 함수지만 같은 일)
  }, [onRemove])

  const openMenu = (e: ReactMouseEvent, items: MenuItem[], pick: (id: string) => void): void => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // 우클릭이면 커서 자리, ⋯ 버튼이면 그 버튼 아래.
    const ctx = e.type === 'contextmenu'
    setMenu({ x: ctx ? e.clientX : r.left, y: ctx ? e.clientY : r.bottom, items, pick })
  }

  const newGroupFor = async (repo: Project): Promise<void> => {
    const name = await dialog.askText({
      title: t('aiws.group.newTitle'),
      message: t('aiws.group.newMsg').replace('{p}', repo.displayName),
      input: { placeholder: t('aiws.group.namePh') }
    })
    if (!name?.trim()) return
    const g = await s.createProjectGroup(name.trim())
    if (g) await s.moveProjectToGroup(repo.id, g.id)
  }
  const projectMenu = (e: ReactMouseEvent, repo: Project): void =>
    openMenu(
      e,
      [
        // WS-20 원격 프로젝트는 공유 경로를 막고 안내(원격 링크 만들기·끊기는 아직 없다 — .worktreeinclude 원격 복사와 같이 뺐다).
        ...(repo.kind === 'git'
          ? [
              { id: 'external', label: t('aiws.ext.menu') },
              { id: 'shared', label: t('aiws.shared.menu'), disabled: !!repo.host, ...(repo.host ? { hint: t('aiws.shared.remote') } : {}) }
            ]
          : []),
        {
          id: 'move',
          label: t('aiws.group.moveTo'),
          submenu: [...s.groups.map((g) => ({ id: 'to:' + g.id, label: g.name, disabled: repo.groupId === g.id })), { id: 'new', label: t('aiws.group.new') }]
        },
        ...(repo.groupId ? [{ id: 'ungroup', label: t('aiws.group.ungroup') }] : []),
        { id: 'remove-project', label: t('aiws.project.remove'), danger: true }
      ],
      (id) => {
        if (id === 'external') setExtFor(repo)
        else if (id === 'shared') setSharedFor(repo)
        else if (id === 'new') void newGroupFor(repo)
        else if (id === 'ungroup') void s.moveProjectToGroup(repo.id, null)
        else if (id === 'remove-project') onRemoveProject(repo)
        else if (id.startsWith('to:')) void s.moveProjectToGroup(repo.id, id.slice(3))
      }
    )
  const groupMenu = (e: ReactMouseEvent, g: ProjectGroup): void =>
    openMenu(
      e,
      [
        { id: 'rename', label: t('aiws.group.rename') },
        { id: 'delete', label: t('aiws.group.delete'), danger: true }
      ],
      (id) => {
        if (id === 'rename') {
          void dialog.askText({ title: t('aiws.group.rename'), message: g.name, input: { value: g.name, placeholder: t('aiws.group.namePh') } }).then((name) => {
            if (name?.trim()) void s.updateProjectGroup(g.id, { name: name.trim() })
          })
        } else if (id === 'delete') {
          void dialog
            .ask({ title: t('aiws.group.delete'), message: t('aiws.group.deleteMsg').replace('{g}', g.name), tone: 'danger', confirmLabel: t('aiws.group.delete') })
            .then((r) => {
              if (r === 'confirm') void s.deleteProjectGroup(g.id)
            })
        }
      }
    )
  const rowMenu = (e: ReactMouseEvent, w: Worktree, pinned: boolean): void => {
    const nDesc = lineageDescendants(lineage, w.id).length
    const repo = s.repos.find((r) => r.id === w.repoId)
    openMenu(
      e,
      w.isArchived
        ? [{ id: 'restore', label: t('aiws.archive.restore') }]
        : [
            { id: 'pin', label: pinned ? t('aiws.side.unpin') : t('aiws.side.pin') },
            { id: 'checkpoint', label: t('aiws.cp.menu') },
            // WS-24 하위 작업 — 로컬 git 프로젝트만(원격 생성은 부모를 기록하지 않는다).
            ...(repo?.kind === 'git' && !repo.host ? [{ id: 'child', label: t('aiws.lineage.newChild') }] : []),
            w.sleep ? { id: 'wake', label: t('aiws.sleep.wake') } : { id: 'sleep', label: t('aiws.sleep.sleep') },
            ...(nDesc > 0 ? [{ id: 'sleep-desc', label: t('aiws.lineage.sleepDesc').replace('{n}', String(nDesc)) }] : []),
            ...(w.isMainWorktree
              ? []
              : [
                  { id: 'archive', label: t('aiws.archive.archive') },
                  { id: 'remove', label: nDesc > 0 ? t('aiws.lineage.deleteDesc') : t('aiws.side.remove'), danger: true, hint: DELETE_KEY_HINT }
                ])
          ],
      (id) => {
        if (id === 'child') {
          s.setComposerParent(w.id)
          onNew(w.repoId)
        } else if (id === 'sleep-desc') void sleepWithLineage(w)
        else if (id === 'pin') s.togglePin(w.id)
        else if (id === 'checkpoint') setCpFor(w)
        else if (id === 'wake') void wake(w)
        else if (id === 'sleep') void sleepWorktree(w.id).then(refused)
        else if (id === 'archive') void archiveWorktree(w.id).then(refused)
        else if (id === 'restore') void restoreWorktree(w.id)
        else if (id === 'remove') removeWithLineage(w)
      }
    )
  }

  // M15 R2 WS-22 호스트별 묶음 — 서버 이름·순서는 터미널 연결 사이드바(프로필·그룹)에서. 저장소 목록이 바뀔 때 한 번 다시 읽는다(폴링 없음).
  const [conn, setConn] = useState<{ profiles: ConnectionProfile[]; groups: string[]; layout: GroupLayout }>({ profiles: [], groups: [], layout: {} })
  const remote = s.repos.some((r) => r.host)
  useEffect(() => {
    if (!remote) return
    let alive = true
    void Promise.all([window.ev.profile.list(), window.ev.workspace.load()])
      .then(([profiles, snap]) => {
        if (alive) setConn({ profiles, groups: snap.ui.groups ?? [], layout: { order: snap.ui.groupOrder, parents: snap.ui.groupParents } })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [remote, s.repos])
  const hosts = useMemo(
    () => (remote ? hostSections(new Set(s.repos.map((r) => r.host ?? LOCAL_HOST)), conn.profiles, conn.groups, conn.layout) : undefined),
    [remote, s.repos, conn]
  )

  const rows = useMemo(
    () =>
      buildSidebarRows({
        repos: s.repos,
        worktreesByRepo: s.worktreesByRepo,
        pending: Object.values(s.pendingWorktreeCreations),
        pinnedIds: s.pinnedIds,
        query: filterOpen ? query : '',
        groupBy: s.groupBy,
        groups: s.groups,
        showArchived: s.showArchived,
        hosts,
        collapsedHosts: s.collapsedHosts,
        collapsedLineage: s.collapsedLineage
      }),
    [s.repos, s.worktreesByRepo, s.pendingWorktreeCreations, s.pinnedIds, query, filterOpen, s.groupBy, s.groups, s.showArchived, hosts, s.collapsedHosts, s.collapsedLineage]
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
          <button
            type="button"
            className={'aiws-ic' + (s.showArchived ? ' on' : '')}
            data-aiws="archived"
            title={t('aiws.archive.box')}
            aria-pressed={s.showArchived}
            onClick={() => s.setShowArchived(!s.showArchived)}
          >
            <Archive />
          </button>
          <button type="button" className="aiws-ic" data-aiws="cleanup" title={t('aiws.cleanup.title')} disabled={s.repos.length === 0} onClick={() => setCleanupOpen(true)}>
            <Eraser />
          </button>
          <button type="button" className="aiws-ic" data-aiws="add-project" title={t('aiws.side.addProject')} onClick={() => void s.pickAndAddRepo()}>
            <FolderPlus />
          </button>
          <button type="button" className="aiws-ic" data-aiws="new" title={t('aiws.side.newWork')} disabled={s.repos.length === 0} onClick={() => onNew()}>
            <Plus />
          </button>
        </span>
      </div>
      {s.preservedBranches.length > 0 && (
        <div className="aiws-kept" data-aiws="kept-branches">
          <GitBranchPlus className="aiws-row-ic" aria-hidden />
          <span className="aiws-kept-txt">{t('aiws.branch.strip').replace('{n}', String(s.preservedBranches.length))}</span>
          <button type="button" className="btn sec" data-aiws="branch-review" onClick={() => s.setBranchReviewOpen(true)}>
            {t('aiws.branch.review')}
          </button>
          <button type="button" className="aiws-ic" data-aiws="branch-keep" title={t('aiws.branch.keepAll')} onClick={() => s.dismissPreservedBranches(s.preservedBranches)}>
            <X />
          </button>
        </div>
      )}
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
        {s.repos.length > 0 && rows.length === 0 && <div className="aiws-side-empty">{s.showArchived ? t('aiws.archive.empty') : t('aiws.side.noMatch')}</div>}
        {rows.map((r) => {
          if (r.kind === 'header' && r.group === 'host' && r.host) {
            const h = r.host
            const toggle = (): void => s.toggleHost(h.key)
            return (
              <div
                key={r.key}
                className="aiws-grp aiws-pgrp"
                data-group={r.key}
                role="button"
                tabIndex={0}
                aria-expanded={!r.collapsed}
                title={h.key === LOCAL_HOST ? undefined : h.key}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') toggle()
                }}
              >
                {r.collapsed ? <ChevronRight className="aiws-grp-ic" aria-hidden /> : <ChevronDown className="aiws-grp-ic" aria-hidden />}
                <span className="aiws-grp-name">
                  {h.key === LOCAL_HOST ? t('aiws.side.hostLocal') : h.group ? `${h.group} › ${h.label}` : h.label}
                </span>
                <b>{r.count}</b>
              </div>
            )
          }
          if (r.kind === 'header' && r.group === 'group' && r.projectGroup) {
            const g = r.projectGroup
            const toggle = (): void => void s.updateProjectGroup(g.id, { isCollapsed: !g.isCollapsed })
            return (
              <div
                key={r.key}
                className="aiws-grp aiws-pgrp"
                data-group={r.key}
                role="button"
                tabIndex={0}
                aria-expanded={!g.isCollapsed}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') toggle()
                }}
                onContextMenu={(e) => groupMenu(e, g)}
              >
                {g.isCollapsed ? <ChevronRight className="aiws-grp-ic" aria-hidden /> : <ChevronDown className="aiws-grp-ic" aria-hidden />}
                <span className="aiws-grp-name">{g.name}</span>
                <b>{r.count}</b>
                <button type="button" className="aiws-ic aiws-grp-act" data-aiws="group-menu" title={t('aiws.more')} onClick={(e) => groupMenu(e, g)}>
                  <MoreHorizontal />
                </button>
              </div>
            )
          }
          if (r.kind === 'header') {
            const repo = r.repo
            const label =
              r.group === 'pinned' ? t('aiws.side.pinned') : r.group === 'all' ? t('aiws.side.all') : r.group === 'archived' ? t('aiws.archive.box') : (repo?.displayName ?? '')
            return (
              <div key={r.key} className={'aiws-grp' + (r.depth ? ' d1' : '')} data-group={r.key} title={repo?.path} onContextMenu={repo ? (e) => projectMenu(e, repo) : undefined}>
                {r.group === 'pinned' && <Pin className="aiws-grp-ic" aria-hidden />}
                {r.group === 'archived' && <Archive className="aiws-grp-ic" aria-hidden />}
                <span className="aiws-grp-name">{label}</span>
                <b>{r.count}</b>
                {repo && (
                  <>
                    <button type="button" className="aiws-ic aiws-grp-act" data-aiws="project-menu" title={t('aiws.more')} onClick={(e) => projectMenu(e, repo)}>
                      <MoreHorizontal />
                    </button>
                    <button type="button" className="aiws-ic" data-aiws="new-in" title={t('aiws.side.newWork')} onClick={() => onNew(repo.id)}>
                      <Plus />
                    </button>
                  </>
                )}
              </div>
            )
          }
          if (r.kind === 'pending') return <PendingRow key={r.key} p={r.creation} />
          if (r.kind === 'hidden') {
            const repo = r.repo
            return (
              <button key={r.key} type="button" className="aiws-hidden-card" data-aiws="hidden-wt" data-repo={repo.id} onClick={() => setExtFor(repo)}>
                <EyeOff className="aiws-row-ic" aria-hidden />
                {t('aiws.ext.card').replace('{n}', String(r.count))}
              </button>
            )
          }
          const w = r.worktree
          const active = s.activeWorktreeId === w.id
          const st = s.statsById[w.id]
          const sleeping = !!w.sleep
          const live = agentTabs.filter((x) => x.worktreeId === w.id && !x.exited)
          const glyph = aggregate(live.map((x) => ({ display: displayOf(statusById[x.sessionId], seenById[x.sessionId] ?? true), estimated: statusById[x.sessionId]?.estimated ?? true })))
          const children = live.flatMap((x) => statusById[x.sessionId]?.children ?? [])
          const meta = sleeping
            ? t('aiws.sleep.asleep')
            : r.repo.kind === 'folder'
              ? t('aiws.wt.folder')
              : w.isMainWorktree
                ? t('aiws.wt.default')
                : !w.branch
                  ? t('aiws.wt.detached')
                  : st?.ok && st.ahead > 0
                    ? t('aiws.wt.ahead').replace('{n}', String(st.ahead))
                    : ''
          return (
            <div
              key={r.key}
              role="listitem"
              className={'aiws-row' + (active ? ' act' : '') + (sleeping ? ' sleeping' : '') + (r.depth ? ` lin${r.depth}` : '')}
              data-wt={w.id}
              data-depth={r.depth || undefined}
              data-pinned={r.pinned || undefined}
              data-sleeping={sleeping || undefined}
              data-archived={w.isArchived || undefined}
              tabIndex={0}
              aria-current={active || undefined}
              title={w.comment ? `${w.path}\n\n${w.comment}` : w.path}
              data-status={w.workspaceStatus}
              onClick={() => pickWorktree(w)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') pickWorktree(w)
              }}
              onContextMenu={(e) => rowMenu(e, w, r.pinned)}
            >
              <div className="aiws-row-l1">
                {/* 잠듦이면 달. 일함·답 기다림 = 상태 글리프(AI-11). FB-2.2.4 D8: 쉬는 중·상태 모름(복원 직후·훅 없는 CLI 는 state=null → 'unknown')이라도
                    세션이 살아 있으면 초록 점(터미널 사이드바 .sb-dot.connected 와 같은 뜻) — 예전엔 unknown 이 빈 고리라 '세션 없음'처럼 보였다. 세션이 없을 때만 빈 점. */}
                {sleeping ? (
                  <Moon className="aiws-row-ic" aria-hidden />
                ) : glyph && (glyph.display === 'working' || glyph.display === 'blocked' || glyph.display === 'question') ? (
                  <AgentGlyph display={glyph.display} estimated={glyph.estimated} />
                ) : glyph ? (
                  <span className="aiws-dot live" data-agent-state="alive" role="img" aria-label={t('aiws.st.alive')} title={t('aiws.st.alive')} />
                ) : (
                  <span className="aiws-dot" aria-hidden />
                )}
                {r.repo.kind === 'folder' ? <Folder className="aiws-row-ic" aria-hidden /> : <GitBranch className="aiws-row-ic" aria-hidden />}
                <span className="aiws-row-name">{w.displayName}</span>
                {r.childCount ? (
                  <button
                    type="button"
                    className="aiws-chip aiws-kids"
                    data-aiws="children"
                    aria-expanded={!r.childrenCollapsed}
                    onClick={(e) => {
                      e.stopPropagation()
                      s.toggleLineage(w.id)
                    }}
                  >
                    {r.childrenCollapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
                    {t('aiws.lineage.children').replace('{n}', String(r.childCount))}
                  </button>
                ) : null}
                <span className="aiws-row-acts">
                  {w.isArchived ? (
                    <button
                      type="button"
                      className="aiws-ic"
                      data-aiws="restore"
                      title={t('aiws.archive.restore')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void restoreWorktree(w.id)
                      }}
                    >
                      <ArchiveRestore />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="aiws-ic"
                      data-aiws={sleeping ? 'wake' : 'sleep'}
                      title={sleeping ? t('aiws.sleep.wake') : t('aiws.sleep.sleep')}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (sleeping) void wake(w)
                        else void sleepWorktree(w.id).then(refused)
                      }}
                    >
                      {sleeping ? <Sun /> : <Moon />}
                    </button>
                  )}
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
                      title={`${t('aiws.side.remove')} (${DELETE_KEY_HINT})`}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeWithLineage(w)
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
                {w.workspaceStatus && <span className="aiws-status">{t('aiws.status.' + w.workspaceStatus)}</span>}
                {w.sparseDirectories?.length ? (
                  <span className="aiws-status" data-aiws="sparse" title={w.sparseDirectories.join('\n')}>
                    {t('aiws.sparse.badge')}
                  </span>
                ) : null}
                {w.comment && <span className="aiws-row-cmt">{w.comment.split(/\r?\n/)[0]}</span>}
                {st?.ok && st.added + st.removed > 0 && (
                  <span className="aiws-diffn">
                    <span className="p">+{st.added}</span> <span className="m">−{st.removed}</span>
                  </span>
                )}
              </div>
              <AgentChildRows items={children} />
            </div>
          )
        })}
      </div>
      {/* p3-M21 셋업 가이드 진행 줄(Orca SetupGuideSidebarEntry) — 다 하거나 숨기면 사라진다. */}
      <SetupGuideSidebarEntry
        onOpen={() => setSetupOpen(true)}
        onMenu={(x, y) => setMenu({ x, y, items: [{ id: 'hide', label: t('setup.hide') }], pick: () => setSetupGuideHidden(true) })}
      />
      {setupOpen && <SetupGuideModal onClose={() => setSetupOpen(false)} />}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu?.items ?? []}
        onPick={(id) => {
          const m = menu
          setMenu(null)
          m?.pick(id)
        }}
        onClose={() => setMenu(null)}
      />
      {dialog.node}
      {cpFor && <CheckpointDialog worktree={cpFor} onClose={() => setCpFor(null)} />}
      {extFor && <ExternalWorktreesDialog repo={extFor} onClose={() => setExtFor(null)} />}
      {sharedFor && <SharedPathsDialog repo={sharedFor} onClose={() => setSharedFor(null)} />}
      {s.branchReviewOpen && s.preservedBranches.length > 0 && <PreservedBranchesDialog onClose={() => s.setBranchReviewOpen(false)} />}
      {cleanupOpen && (
        <Suspense fallback={null}>
          <CleanupDialog onClose={() => setCleanupOpen(false)} />
        </Suspense>
      )}
    </aside>
  )
}

/** 만드는 중 / 실패한 줄 — Orca PendingWorktreeRow. git 출력은 마지막 줄만(진행 막대 \r 포함). */
function PendingRow({ p }: { p: PendingWorktreeCreation }): JSX.Element {
  const s = useAiwsStore()
  const failed = p.phase === 'failed'
  const pct = p.checkout?.percent
  const phase = failed
    ? t('aiws.pending.failed')
    : p.phase === 'setup'
      ? t('aiws.pending.setup')
      : p.phase === 'copying'
        ? t('aiws.pending.copying')
        : p.phase === 'creating'
          ? t('aiws.pending.creating')
          : t('aiws.pending.start')
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
                  void s.createWorktree({
                    repoId: p.repoId,
                    name: p.name,
                    baseBranch: p.baseBranch,
                    nameWasGenerated: p.nameWasGenerated,
                    parentWorktreeId: p.parentWorktreeId,
                    sparseDirectories: p.sparseDirectories,
                    runSetup: p.runSetup
                  })
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
