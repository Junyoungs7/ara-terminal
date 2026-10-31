import { useEffect, type JSX } from 'react'
import { Bot, GitBranch, LayoutGrid, Search, SlidersHorizontal, Sparkles, Zap } from 'lucide-react'
import { t } from '../../i18n'
import { ensureAiwsLoaded } from './store'

/**
 * M1 라운드 2 — AI 작업 공간의 **자리**(시안 SW-final-ai). 안쪽 배치는 Orca 를 따른다: 왼쪽 사이드바 위 내비
 * (Search · Automations · Agent Dashboard … — Orca `SidebarNav.tsx`) + 에이전트·워크트리 목록. 지금은 아이콘만
 * 세우고 전부 비활성이다(M3 에서 채운다). 설정만 살아 있다 — 터미널 레일의 [설정]과 같은 길(onSettings).
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
        <button
          key={id}
          type="button"
          className="ai-rail-item"
          data-aiws={id}
          disabled
          title={`${t('aiws.nav.' + id)} · ${t('aiws.soon')}`}
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

/** 가운데 빈 상태 — 설정 › "곧 들어옵니다" 와 같은 톤. */
export function AiHome(): JSX.Element {
  // M2: 프로젝트·워크트리 상태를 처음 열 때 불러온다(화면은 라운드 2).
  useEffect(() => void ensureAiwsLoaded(), [])
  return (
    <div className="aiws-home" role="region" aria-label={t('space.ai')}>
      <Sparkles className="aiws-home-ic" aria-hidden />
      <b>{t('aiws.home.title')}</b>
      <span>{t('aiws.home.desc')}</span>
    </div>
  )
}
