// M15 IN-03 AI 공간 첫 안내 — Orca 온보딩(components/onboarding: AgentStep 의 감지된 에이전트·설치 안내, IntegrationsStep)을 아라 몫만 옮겼다:
// ① 에이전트 CLI 설치·로그인 확인(감지 = agents.detect, 로그인 = 사용량 조회의 missing-credentials) ② Oriel 감지 ③ 관리형 서버 소개.
// 뺀 것: 테마·알림·Windows Terminal·언어 단계, 단계별 원격 측정, 체크리스트. AI 공간에 처음 들어올 때만 불러온다(AiSpace 의 lazy).
// [닫기] = 이번 실행만, [다시 보지 않기] = localStorage(설정이 아니라 잠깐의 기억 — 다른 aiws 기억과 같은 자리).
import { useEffect, useState, type JSX } from 'react'
import { AGENT_IDS, AGENTS, type AgentId, type DetectedAgent } from '@shared/agents'
import type { OrielStatus } from '@shared/oriel'
import type { UsageState } from '@shared/usage'
import { t } from '../../i18n'
import { openSettings } from '../../store/settingsNav'
import './onboarding.css'

/** AiSpace.tsx 의 ONBOARDING_KEY 와 같은 글(그쪽은 이 청크를 부르기 전에 읽어야 해서 따로 둔다). */
const ONBOARDING_KEY = 'aiws.onboarding.closed'

const INSTALL: Record<AgentId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  gemini: 'npm i -g @google/gemini-cli'
}

/** 로그인 여부 — 사용량 조회가 로그인 파일을 못 찾았으면 'no', 값이 왔으면 'yes', 그 밖(Gemini·아직 모름)은 null. */
function loginOf(id: AgentId, u: UsageState | null): 'yes' | 'no' | null {
  const p = id === 'claude' ? u?.claude : id === 'codex' ? u?.codex : null
  if (!p) return null
  if (p.status === 'ok') return 'yes'
  return p.failure === 'missing-credentials' ? 'no' : null
}

export function AiOnboarding({ onClose }: { onClose: () => void }): JSX.Element {
  const [agents, setAgents] = useState<DetectedAgent[] | null>(null)
  const [usage, setUsage] = useState<UsageState | null>(null)
  const [oriel, setOriel] = useState<OrielStatus | null>(null)
  useEffect(() => {
    void window.ev.agents.detect().then(setAgents).catch(() => setAgents([]))
    void window.ev.usage.get().then(setUsage).catch(() => {})
    void window.ev.oriel.status().then(setOriel).catch(() => {})
  }, [])
  const close = (forever: boolean): void => {
    if (forever)
      try {
        localStorage.setItem(ONBOARDING_KEY, '1')
      } catch {
        /* 저장 못 해도 이번 실행은 닫힌다 */
      }
    onClose()
  }
  return (
    <div className="aiws-onb" role="dialog" aria-label={t('aiws.onb.title')} data-aiws="onboarding">
      <div className="aiws-onb-card">
        <b className="aiws-onb-title">{t('aiws.onb.title')}</b>
        <span className="aiws-onb-desc">{t('aiws.onb.desc')}</span>

        <div className="aiws-onb-sec" data-onb="agents">
          <span className="aiws-onb-h">{t('aiws.onb.agents')}</span>
          {!agents && <span className="aiws-onb-note">{t('aiws.onb.checking')}</span>}
          {agents &&
            AGENT_IDS.map((id) => {
              const d = agents.find((a) => a.id === id)
              const login = loginOf(id, usage)
              return (
                <div className="aiws-onb-row" key={id} data-agent={id} data-installed={d?.installed ? '1' : '0'}>
                  <span className="aiws-onb-name">{AGENTS[id].label}</span>
                  {d?.installed ? (
                    <span className="aiws-onb-note">
                      {t('aiws.onb.installed') + (d.version ? ` ${d.version}` : '')}
                      {login && ` · ${t('aiws.onb.login.' + login)}`}
                    </span>
                  ) : (
                    <span className="aiws-onb-note">
                      {t('aiws.onb.missing')} <code>{INSTALL[id]}</code>
                    </span>
                  )}
                </div>
              )
            })}
          <button type="button" className="btn sec" data-onb="agentSettings" onClick={() => openSettings('agents')}>
            {t('aiws.onb.agentSettings')}
          </button>
        </div>

        <div className="aiws-onb-sec" data-onb="oriel" data-installed={oriel?.installed ? '1' : '0'}>
          <span className="aiws-onb-h">{t('aiws.onb.oriel')}</span>
          <span className="aiws-onb-note">{!oriel ? t('aiws.onb.checking') : oriel.installed ? t('aiws.onb.oriel.yes').replace('{v}', oriel.info.version) : t('aiws.onb.oriel.no')}</span>
        </div>

        <div className="aiws-onb-sec" data-onb="managed">
          <span className="aiws-onb-h">{t('aiws.onb.managed')}</span>
          <span className="aiws-onb-note">{t('aiws.onb.managed.desc')}</span>
          <button type="button" className="btn sec" data-onb="managedSettings" onClick={() => openSettings('managed')}>
            {t('aiws.onb.managedSettings')}
          </button>
        </div>

        <div className="aiws-onb-foot">
          <button type="button" className="btn sec" data-onb="never" onClick={() => close(true)}>
            {t('aiws.onb.never')}
          </button>
          <button type="button" className="btn sec" data-onb="close" onClick={() => close(false)}>
            {t('aiws.onb.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
