import { useEffect, useState, type JSX } from 'react'
import type { Worktree } from '@shared/worktrees'
import { Bot, GitBranch, LayoutGrid, Search, SlidersHorizontal, Sparkles, Zap } from 'lucide-react'
import { t } from '../../i18n'
import type { AiwsLocation } from '.'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { ensureAiwsLoaded, useAiwsStore } from './store'
import { WorktreeSidebar } from './WorktreeSidebar'
import { NewWorkCard } from './NewWorkCard'
import { shortBranch } from './sidebarRows'

type AskFn = (spec: DialogSpec) => Promise<DialogResult>

/**
 * M1 라운드 2 — AI 작업 공간의 **자리**(시안 SW-final-ai). 안쪽 배치는 Orca 를 따른다: 왼쪽 사이드바 위 내비
 * (Search · Automations · Agent Dashboard … — Orca `SidebarNav.tsx`) + 에이전트·워크트리 목록. 워크트리(M2)와 설정만
 * 살아 있고 나머지는 비활성이다(M3 에서 채운다). 설정은 터미널 레일의 [설정]과 같은 길(onSettings).
 *
 * 처음 AI 작업 공간을 열 때 `import()` 로 불러온다(features/aiws/index.ts — 진입 청크에 안 실린다).
 */
const NAV: readonly { id: string; Icon: () => JSX.Element }[] = [
  { id: 'worktree', Icon: () => <GitBranch /> },
  { id: 'agents', Icon: () => <Bot /> },
  { id: 'search', Icon: () => <Search /> },
  { id: 'automations', Icon: () => <Zap /> },
  { id: 'dashboard', Icon: () => <LayoutGrid /> }
]

export function AiRail({ settingsOpen, onSettings }: { settingsOpen: boolean; onSettings: () => void }): JSX.Element {
  return (
    <div className="ai-rail" role="toolbar" aria-label={t('aiws.rail.label')}>
      {NAV.map(({ id, Icon }) => (
        // 워크트리 목록은 M2 라운드 2 에 들어왔다 — 늘 펼쳐진 지금 화면이라 눌린 모양만. 나머지는 M3 이후.
        <button
          key={id}
          type="button"
          className={'ai-rail-item' + (id === 'worktree' && !settingsOpen ? ' active' : '')}
          data-aiws={id}
          disabled={id !== 'worktree'}
          aria-pressed={id === 'worktree' ? !settingsOpen : undefined}
          title={id === 'worktree' ? t('aiws.nav.' + id) : `${t('aiws.nav.' + id)} · ${t('aiws.soon')}`}
          aria-label={t('aiws.nav.' + id)}
        >
          <Icon />
        </button>
      ))}
      <div className="ai-rail-spacer" />
      <button
        type="button"
        className={'ai-rail-item' + (settingsOpen ? ' active' : '')}
        data-aiws="settings"
        aria-pressed={settingsOpen}
        title={t('settings.open')}
        onClick={onSettings}
      >
        <SlidersHorizontal />
      </button>
    </div>
  )
}

/**
 * AI 작업 공간 본문 — 왼쪽 워크트리 목록(WS-05) + 가운데(새 작업 카드 WS-02 / 고른 작업 단위 / 빈 상태).
 * 고른 워크트리는 onLocation 으로 Shell 에 알린다 — 타이틀바 `프로젝트 / 워크트리 / 브랜치`, 상태바 "main 에서 n 커밋 앞".
 * (Shell 은 진입 청크라 이 청크의 상태 저장소를 직접 읽지 않는다.)
 */
export function AiHome({ ask, onLocation }: { ask: AskFn; onLocation: (loc: AiwsLocation | null) => void }): JSX.Element {
  // M2: 프로젝트·워크트리 상태를 처음 열 때 불러온다.
  useEffect(() => void ensureAiwsLoaded(), [])
  const [composer, setComposer] = useState<{ repoId?: string } | null>(null)
  const repos = useAiwsStore((s) => s.repos)
  const activeId = useAiwsStore((s) => s.activeWorktreeId)
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const stats = useAiwsStore((s) => (activeId ? s.statsById[activeId] : undefined))
  const active = activeId ? Object.values(byRepo).flat().find((w) => w.id === activeId) : undefined
  const repo = active ? repos.find((r) => r.id === active.repoId) : undefined

  const crumbServer = repo?.displayName ?? null
  const crumbPath = active ? [active.displayName, shortBranch(active)].filter((x, i, a) => x && a.indexOf(x) === i).join(' / ') : null
  const status = stats?.ok ? t('aiws.status.ahead').replace('{base}', stats.base).replace('{n}', String(stats.ahead)) : null
  useEffect(() => {
    onLocation(crumbServer ? { crumb: { server: crumbServer, path: crumbPath }, status } : null)
  }, [crumbServer, crumbPath, status, onLocation])
  // 공간을 떠나면(언마운트) 타이틀바·상태바를 비운다.
  useEffect(() => () => onLocation(null), [onLocation])

  const remove = async (w: Worktree): Promise<void> => {
    const branch = shortBranch(w) || '-'
    const yes = await ask({
      title: t('aiws.remove.title'),
      message: t('aiws.remove.msg').replace('{path}', w.path).replace('{branch}', branch),
      tone: 'danger',
      confirmLabel: t('aiws.remove.confirm')
    })
    if (yes !== 'confirm') return
    const r = await useAiwsStore.getState().removeWorktree(w.id)
    if (r.ok) return
    // 커밋 안 한 변경·잠금 — git 의 말을 그대로 보여 주고, 버리고 지울지 한 번 더 묻는다.
    const force = await ask({
      title: t('aiws.remove.forceTitle'),
      message: t('aiws.remove.forceMsg'),
      detail: [{ label: 'git', value: r.message }],
      tone: 'danger',
      confirmLabel: t('aiws.remove.force')
    })
    if (force === 'confirm') await useAiwsStore.getState().removeWorktree(w.id, true)
  }

  return (
    <div className="aiws-home" role="region" aria-label={t('space.ai')}>
      <WorktreeSidebar onNew={(repoId) => setComposer({ repoId })} onRemove={(w) => void remove(w)} />
      <div className="aiws-center">
        {composer ? (
          <NewWorkCard initialRepoId={composer.repoId} onClose={() => setComposer(null)} />
        ) : active ? (
          <div className="aiws-empty" data-aiws="selected">
            <GitBranch className="aiws-home-ic" aria-hidden />
            <b>{active.displayName}</b>
            <span className="aiws-mono">{active.path}</span>
            <span>{t('aiws.sel.desc')}</span>
          </div>
        ) : (
          <div className="aiws-empty">
            <Sparkles className="aiws-home-ic" aria-hidden />
            <b>{t('aiws.home.title')}</b>
            <span>{t('aiws.home.desc')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
