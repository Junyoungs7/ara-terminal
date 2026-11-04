// p3-M21 셋업 가이드(시작하기) 화면 — Orca FeatureWallSetupChecklist·SetupGuideModal·SetupGuideSidebarEntry·SettingsSetupGuidePane·SetupGuideProgressRing(orcaRef ec112c6b01).
// 자리 세 곳(준영님 안 2): 사이드바 진행 줄(우클릭 = 숨기기) → 모달, 설정 › AI 작업 공간 맨 위 '시작하기' 섹션. 셋이 같은 판정(useSetupGuideProgress)을 본다.
// 첫 안내(AiOnboarding)와 겹치는 단계(기본 에이전트·Oriel)는 같은 감지를 쓰고, 상세는 설정으로 보낸다(설치 안내 UI 를 두 벌 두지 않는다).
import { useEffect, useState, type JSX } from 'react'
import { Check, X } from 'lucide-react'
import { t } from '../../../i18n'
import { openSettings } from '../../../store/settingsNav'
import type { SettingsSection } from '@shared/settingsIndex'
import { useAiwsStore } from '../store'
import { firstIncompleteStep, sectionOfStep, SETUP_STEP_IDS, showSidebarEntry, type SetupGuideProgress, type SetupStepId } from './steps'
import { setSetupGuideHidden, useSetupGuideHidden, useSetupGuideProgress } from './useSetupGuide'
import { OrielInstallButton } from '../OrielInstall'
import './setupGuide.css'

/** 단계의 [바로 가기] — 설정 딥링크 또는 동작. 없는 단계는 설명만. */
const GO: Partial<Record<SetupStepId, [SettingsSection, string] | (() => void)>> = {
  'default-agent': ['agents', 'agents.default'],
  notifications: ['notify', 'notify.agents'],
  'agent-capabilities': ['skills', 'cli.install'],
  'task-sources': ['integrations', 'gitlab.enable'],
  'add-two-repos': () => void useAiwsStore.getState().pickAndAddRepo(),
  browser: ['agents', 'agents.oriel']
}

export function ProgressRing({ done, total }: { done: number; total: number }): JSX.Element {
  return <span className="sg-ring" style={{ ['--p' as string]: total ? done / total : 0 }} role="img" aria-label={`${done}/${total}`} />
}

/** 왼쪽 단계 목록 + 오른쪽 상세. 처음엔 안 끝난 첫 단계(Orca), 사람이 고르면 그 단계를 지킨다. */
export function SetupChecklist({ progress, onGo }: { progress: SetupGuideProgress; onGo?: () => void }): JSX.Element {
  const [picked, setPicked] = useState<SetupStepId | null>(null)
  const active = picked ?? firstIncompleteStep(progress.stepDone)
  const go = GO[active]
  const row = (id: SetupStepId): JSX.Element => (
    <li key={id}>
      <button type="button" className={'sg-step' + (id === active ? ' on' : '') + (progress.stepDone[id] ? ' done' : '')} data-setup-step={id} data-done={progress.stepDone[id] || undefined} onClick={() => setPicked(id)}>
        <span className="sg-check" aria-hidden>
          {progress.stepDone[id] && <Check />}
        </span>
        <span>{t(`setup.step.${id}`)}</span>
      </button>
    </li>
  )
  return (
    <div className="sg-body" data-aiws="setup-checklist">
      <ol className="sg-steps">
        <li className="sg-sec">{t('setup.sec.setup')}</li>
        {SETUP_STEP_IDS.filter((id) => sectionOfStep(id) === 'setup').map(row)}
        <li className="sg-sec">{t('setup.sec.parallel')}</li>
        {SETUP_STEP_IDS.filter((id) => sectionOfStep(id) === 'parallel').map(row)}
      </ol>
      <div className="sg-detail" data-setup-detail={active}>
        <h2 className="sg-h">{t(`setup.step.${active}`)}</h2>
        <p className="sg-desc">{t(`setup.step.${active}.desc`)}</p>
        {progress.stepDone[active] ? (
          <span className="sg-ok">{t('setup.done')}</span>
        ) : (
          go && (
            <button
              type="button"
              className="btn pri"
              data-aiws="setup-go"
              onClick={() => {
                if (typeof go === 'function') go()
                else {
                  onGo?.()
                  openSettings(go[0], go[1])
                }
              }}
            >
              {t(`setup.step.${active}.go`)}
            </button>
          )
        )}
        {active === 'browser' && !progress.stepDone.browser && <OrielInstallButton />}
      </div>
    </div>
  )
}

/** 모달 — 사이드바 줄을 누르면(AiSpace 가 지연 마운트). */
export function SetupGuideModal({ onClose }: { onClose: () => void }): JSX.Element {
  const progress = useSetupGuideProgress()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sg-modal" role="dialog" aria-label={t('setup.title')} data-aiws="setup-modal">
        <header className="sg-head">
          <ProgressRing done={progress.doneCount} total={progress.total} />
          <b className="sg-title">{t('setup.title')}</b>
          <span className="sg-sub">{t('setup.sub')}</span>
          <span className="sg-grow" />
          <button
            type="button"
            className="btn sec"
            data-aiws="setup-hide"
            onClick={() => {
              setSetupGuideHidden(true)
              onClose()
            }}
          >
            {t('setup.hide')}
          </button>
          <button type="button" className="aiws-ic" aria-label={t('setup.close')} onClick={onClose}>
            <X />
          </button>
        </header>
        <SetupChecklist progress={progress} onGo={onClose} />
      </div>
    </div>
  )
}

/** 사이드바 맨 아래 '시작하기 n/8'. 다 하거나 숨기면 사라진다. 우클릭 = 숨기기(Orca Hide from sidebar). */
export function SetupGuideSidebarEntry({ onOpen, onMenu }: { onOpen: () => void; onMenu: (x: number, y: number) => void }): JSX.Element | null {
  const progress = useSetupGuideProgress()
  const hidden = useSetupGuideHidden()
  if (!showSidebarEntry(progress, hidden)) return null
  return (
    <button
      type="button"
      className="sg-entry"
      data-aiws="setup-entry"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <ProgressRing done={progress.doneCount} total={progress.total} />
      <span className="sg-grow">{t('setup.title')}</span>
      <span className="sg-count">
        {progress.doneCount}/{progress.total}
      </span>
    </button>
  )
}

/** 설정 › AI 작업 공간 › 시작하기(Orca SettingsSetupGuidePane). 숨겼으면 [사이드바에 다시 보이기]. */
export function SetupGuideSettings(): JSX.Element {
  const progress = useSetupGuideProgress()
  const hidden = useSetupGuideHidden()
  return (
    <div className="sg-settings" data-item="setupGuide.list">
      <div className="sg-head">
        <ProgressRing done={progress.doneCount} total={progress.total} />
        <span className="sg-sub">{t('setup.settings.desc')}</span>
        <span className="sg-grow" />
        {hidden && (
          <button type="button" className="btn sec" data-aiws="setup-unhide" onClick={() => setSetupGuideHidden(false)}>
            {t('setup.unhide')}
          </button>
        )}
      </div>
      <SetupChecklist progress={progress} />
    </div>
  )
}
