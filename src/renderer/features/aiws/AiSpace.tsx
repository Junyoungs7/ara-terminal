import { useEffect, useState, type JSX } from 'react'
import type { Worktree } from '@shared/worktrees'
import { Bot, GitBranch, History, LayoutGrid, Search, SlidersHorizontal, Sparkles, Zap } from 'lucide-react'
import { t } from '../../i18n'
import type { AiwsLocation } from '.'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { ensureAiwsLoaded, useAiwsStore } from './store'
import { WorktreeSidebar } from './WorktreeSidebar'
import { NewWorkCard } from './NewWorkCard'
import { AgentWorkspace } from './AgentPane'
import { ActivityFeed, AgentDashboard } from './AgentDashboard'
import { VaultPanel } from './VaultPanel'
import { useAgentStore, type AiwsView } from './agentStore'
import { shortBranch } from './sidebarRows'
import { QuickOpen } from './QuickOpen'
import { SearchPanel } from './SearchPanel'
import { isMac } from '@shared/keymap'
import { EXPLORER_STATE_EVENT, EXPLORER_TOGGLE_EVENT } from '@shared/codeFiles'
import { OPEN_DIFF_EVENT, type DiffMode } from '@shared/gitDiff'
import { openDiff } from './diffStore'
import { SCM_STATE_EVENT, SCM_TOGGLE_EVENT } from '@shared/scm'
import { ScmPanel } from './ScmPanel'
import { ExplorerPanel } from './ExplorerPanel'
import { WorktreeJump } from './WorktreeJump'

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
  { id: 'sessions', Icon: () => <History /> },
  { id: 'search', Icon: () => <Search /> },
  { id: 'automations', Icon: () => <Zap /> },
  { id: 'dashboard', Icon: () => <LayoutGrid /> }
]

/** 레일 → 가운데 화면. 에이전트(Orca Agents 피드) = 활동 피드(AI-09), 지난 세션 = AI-07(M4), 대시보드 = AI-08.
 *  검색(M6 R2 WS-09) = 왼쪽 목록 자리가 전체 검색으로(가운데는 작업 단위 그대로). 자동화는 아직. */
const RAIL_VIEW: Partial<Record<string, AiwsView>> = { worktree: 'worktree', agents: 'activity', sessions: 'sessions', search: 'search', dashboard: 'dashboard' }

export function AiRail({ settingsOpen, onSettings }: { settingsOpen: boolean; onSettings: () => void }): JSX.Element {
  const view = useAgentStore((s) => s.view)
  return (
    <div className="ai-rail" role="toolbar" aria-label={t('aiws.rail.label')}>
      {NAV.map(({ id, Icon }) => (
        // 워크트리(M2)·에이전트 활동 피드·대시보드(M3 R3)·검색(M6 R2)이 산다 — 고르면 가운데(검색은 왼쪽)가 바뀐다. 자동화는 아직.
        <button
          key={id}
          type="button"
          className={'ai-rail-item' + (RAIL_VIEW[id] === view && !settingsOpen ? ' active' : '')}
          data-aiws={id}
          disabled={!RAIL_VIEW[id]}
          aria-pressed={RAIL_VIEW[id] ? RAIL_VIEW[id] === view && !settingsOpen : undefined}
          title={RAIL_VIEW[id] ? t('aiws.nav.' + id) : `${t('aiws.nav.' + id)} · ${t('aiws.soon')}`}
          aria-label={t('aiws.nav.' + id)}
          onClick={() => {
            const v = RAIL_VIEW[id]
            if (v) useAgentStore.getState().setView(v)
          }}
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
  const view = useAgentStore((s) => s.view)
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
  // M7 WS-10 diff 탭 열기 — 진입 청크·R2 소스 제어 패널이 창 이벤트로(detail = { filePath?, mode? }). 공유 API = agent_talk/m7-shared-api.md.
  useEffect(() => {
    const h = (e: Event): void => {
      const d = (e as CustomEvent<{ filePath?: string; mode?: DiffMode } | undefined>).detail
      if (!openDiff(typeof d?.filePath === 'string' ? d.filePath : undefined, d?.mode === 'staged' || d?.mode === 'branch' ? d.mode : 'unstaged')) return
      setComposer(null)
      useAgentStore.getState().setView('worktree')
    }
    window.addEventListener(OPEN_DIFF_EVENT, h)
    return () => window.removeEventListener(OPEN_DIFF_EVENT, h)
  }, [])

  // M6 R2 WS-06 빠른 열기 = Ctrl+P(맥 Cmd+P) — **AI 작업 공간에서만**(이 컴포넌트는 그 공간에서만 붙는다). Orca 의 Go to File 키.
  // KEYMAP 에 넣지 않는다: 넣으면 isAppShortcut 이 터미널 공간의 xterm 에서도 이 키를 삼켜 셸의 Ctrl+P(리드라인 이전 명령)가 죽는다.
  // 창 캡처 단계에서 받아 에이전트 터미널·Monaco 보다 먼저 가져간다(Orca 도 전역). 한글 입력 상태면 e.key 가 'ㅔ' 라 e.code 로 본다.
  const [quick, setQuick] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyP' || e.shiftKey || e.altKey || !(isMac() ? e.metaKey : e.ctrlKey)) return
      e.preventDefault()
      e.stopPropagation()
      setQuick((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  /** 빠른 열기·검색으로 연 파일이 보이게 — 새 작업 카드를 닫고, 대시보드 등이면 작업 단위로(검색은 왼쪽이라 그대로 둔다). */
  const showFile = (): void => {
    setComposer(null)
    const v = useAgentStore.getState().view
    if (v !== 'worktree' && v !== 'search') useAgentStore.getState().setView('worktree')
  }

  // M7 R2 WS-12 오른쪽 [소스 제어] · M12 CV-01 [탐색기] 패널 — RightBar(진입 청크)가 창 이벤트로 켜고 끈다. 오른쪽 자리는 하나(Orca 오른쪽 사이드바 탭) —
  // 하나를 열면 다른 것은 닫힌다. 열림은 여기가 쥐고 알린다(눌림 표시).
  const [right, setRight] = useState<'scm' | 'explorer' | null>(null)
  useEffect(() => {
    const s = (): void => setRight((v) => (v === 'scm' ? null : 'scm'))
    const x = (): void => setRight((v) => (v === 'explorer' ? null : 'explorer'))
    window.addEventListener(SCM_TOGGLE_EVENT, s)
    window.addEventListener(EXPLORER_TOGGLE_EVENT, x)
    return () => {
      window.removeEventListener(SCM_TOGGLE_EVENT, s)
      window.removeEventListener(EXPLORER_TOGGLE_EVENT, x)
    }
  }, [])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SCM_STATE_EVENT, { detail: right === 'scm' }))
    window.dispatchEvent(new CustomEvent(EXPLORER_STATE_EVENT, { detail: right === 'explorer' }))
  }, [right])
  useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent(SCM_STATE_EVENT, { detail: false }))
      window.dispatchEvent(new CustomEvent(EXPLORER_STATE_EVENT, { detail: false }))
    },
    []
  )

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
      {view !== 'search' && (
        <WorktreeSidebar
          onNew={(repoId) => {
            setComposer({ repoId })
            useAgentStore.getState().setView('worktree')
          }}
          onRemove={(w) => void remove(w)}
        />
      )}
      {/* 검색은 숨겨도 붙여 둔다 — 결과·검색어가 레일을 오가도 남는다. */}
      <SearchPanel hidden={view !== 'search'} onOpened={showFile} />
      {quick && <QuickOpen onClose={() => setQuick(false)} onOpened={showFile} />}
      <div className="aiws-center">
        {view === 'dashboard' ? (
          <AgentDashboard />
        ) : view === 'activity' ? (
          <ActivityFeed />
        ) : view === 'sessions' ? (
          <VaultPanel />
        ) : composer ? (
          <NewWorkCard initialRepoId={composer.repoId} onClose={() => setComposer(null)} />
        ) : active ? (
          // M3: 고른 작업 단위의 에이전트 탭 줄(없으면 피커).
          <AgentWorkspace key={active.id} worktree={active} ask={ask} />
        ) : (
          <div className="aiws-empty">
            <Sparkles className="aiws-home-ic" aria-hidden />
            <b>{t('aiws.home.title')}</b>
            <span>{t('aiws.home.desc')}</span>
          </div>
        )}
      </div>
      {right === 'scm' && <ScmPanel ask={ask} />}
      {right === 'explorer' && <ExplorerPanel onOpened={showFile} />}
      <WorktreeJump onJumped={() => setComposer(null)} />
    </div>
  )
}
