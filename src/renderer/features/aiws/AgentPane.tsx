import { useEffect, useState, type JSX } from 'react'
import { FileText, Plus, X } from 'lucide-react'
import { AGENT_IDS, AGENTS, type AgentId } from '@shared/agents'
import type { Worktree } from '@shared/worktrees'
import { t } from '../../i18n'
import { TerminalPane } from '../../terminal/TerminalPane'
import { pickInitialAgent, useAgentStore } from './agentStore'

/**
 * M3 AI-01 피커 — Orca AgentLaunchPickerMenu·AgentCombobox(orcaRef 7a7f46f8a3)의 1차: 설치된 에이전트를 고르고 첫 지시를 적어 한 번에 실행.
 * 설치 안 된 것은 보이되 못 고른다(설정 › 에이전트에서 끈 것은 안 보인다). 뺀 것: 모델·추론 강도 고르기(채팅 M5)·검색·최근 순서.
 */
export function AgentPicker({ worktree, onLaunched, onCancel }: { worktree: Worktree; onLaunched?: () => void; onCancel?: () => void }): JSX.Element {
  const detected = useAgentStore((s) => s.detected)
  const settings = useAgentStore((s) => s.settings)
  const detecting = useAgentStore((s) => s.detecting)
  const [agent, setAgent] = useState<AgentId | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!detected) void useAgentStore.getState().loadAgents()
  }, [detected])
  const chosen = agent ?? pickInitialAgent(settings, detected)
  const shown = AGENT_IDS.filter((id) => settings?.agents[id].enabled !== false)

  const launch = async (): Promise<void> => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    const r = await useAgentStore.getState().launchAgent({ agent: chosen, worktreeId: worktree.id, cwd: worktree.path, prompt })
    setBusy(false)
    if (!r.ok) setError(r.error)
    else onLaunched?.()
  }

  return (
    <div className="aiws-new" role="dialog" aria-label={t('aiws.agent.pick')} data-aiws="agent-picker" onKeyDown={(e) => e.key === 'Escape' && onCancel?.()}>
      <h2 className="aiws-new-ttl">{t('aiws.agent.pick')}</h2>
      <span className="aiws-mono aiws-note">{worktree.path}</span>
      {!detected ? (
        <p className="aiws-note">{t('aiws.agent.detecting')}</p>
      ) : (
        <div className="aiws-agents" role="radiogroup" aria-label={t('aiws.agent.pick')}>
          {shown.map((id) => {
            const d = detected.find((x) => x.id === id)
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={chosen === id}
                className={'aiws-mode' + (chosen === id ? ' on' : '')}
                data-agent={id}
                disabled={!d?.installed}
                onClick={() => setAgent(id)}
              >
                <b>{AGENTS[id].label}</b>
                <span>{d?.installed ? (d.version ?? t('aiws.agent.versionUnknown')) : t('aiws.agent.notInstalled')}</span>
              </button>
            )
          })}
        </div>
      )}
      {detected && !detected.some((d) => d.installed) && <p className="aiws-note">{t('aiws.agent.none')}</p>}
      <label className="aiws-field">
        <span>{t('aiws.new.prompt')}</span>
        <textarea
          className="aiws-input"
          data-aiws="agent-prompt"
          rows={4}
          placeholder={t('aiws.agent.promptPh')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void launch()
          }}
        />
      </label>
      {error && (
        <p className="aiws-note aiws-err" role="alert">
          {error}
        </p>
      )}
      <div className="aiws-new-foot">
        <button type="button" className="btn sec" disabled={detecting} onClick={() => void useAgentStore.getState().loadAgents(true)}>
          {t('aiws.agent.redetect')}
        </button>
        {onCancel && (
          <button type="button" className="btn sec" onClick={onCancel}>
            {t('aiws.new.cancel')}
          </button>
        )}
        <button type="button" className="btn pri" data-aiws="agent-launch" disabled={!chosen || busy} onClick={() => void launch()}>
          {t('aiws.agent.launch')}
        </button>
      </div>
    </div>
  )
}

/**
 * M3 AI-03 가운데 — 고른 작업 단위의 **에이전트 터미널 탭 줄**(시안 SW-final: 에이전트 탭 + 파일 탭 자리) + 그 탭의 터미널.
 * 터미널은 아라의 TerminalPane 그대로(로컬 PTY). 탭을 바꿔도 다른 탭의 xterm 은 붙은 채 숨긴다(스크롤백 유지).
 * 탭이 없거나 [+] 를 누르면 피커.
 */
export function AgentWorkspace({ worktree }: { worktree: Worktree }): JSX.Element {
  const allTabs = useAgentStore((s) => s.tabs)
  const activeId = useAgentStore((s) => s.activeTabByWorktree[worktree.id])
  const tabs = allTabs.filter((x) => x.worktreeId === worktree.id)
  const [picking, setPicking] = useState(false)
  if (tabs.length === 0 || picking) {
    return <AgentPicker worktree={worktree} onLaunched={() => setPicking(false)} onCancel={tabs.length ? () => setPicking(false) : undefined} />
  }
  const active = tabs.find((x) => x.sessionId === activeId) ?? tabs[tabs.length - 1]
  return (
    <div className="aiws-agentws" data-aiws="agent-ws">
      <div className="aiws-tabs" role="tablist" aria-label={t('aiws.agent.tabs')}>
        {tabs.map((x) => (
          <div
            key={x.sessionId}
            role="tab"
            tabIndex={0}
            aria-selected={x === active}
            className={'aiws-tab' + (x === active ? ' on' : '')}
            data-agent-tab={x.agent}
            data-state={x.exited ? 'exited' : 'running'}
            title={x.line}
            onClick={() => useAgentStore.getState().setActiveTab(worktree.id, x.sessionId)}
          >
            <span className={'aiws-tab-dot' + (x.exited ? ' off' : '')} aria-hidden />
            <span>{AGENTS[x.agent].label}</span>
            <span className="aiws-tab-state">{x.exited ? t('aiws.agent.exited') : t('aiws.agent.running')}</span>
            <button
              type="button"
              className="aiws-ic"
              aria-label={t('aiws.agent.close')}
              onClick={(e) => {
                e.stopPropagation()
                useAgentStore.getState().closeTab(x.sessionId)
              }}
            >
              <X />
            </button>
          </div>
        ))}
        {/* 파일 탭 자리(시안) — 코드 보기는 M6. */}
        <button type="button" className="aiws-tab" disabled title={`${t('aiws.agent.files')} · ${t('aiws.soon')}`}>
          <FileText className="aiws-tab-ic" aria-hidden />
          <span>{t('aiws.agent.files')}</span>
        </button>
        <button type="button" className="aiws-ic" data-aiws="agent-add" aria-label={t('aiws.agent.add')} title={t('aiws.agent.add')} onClick={() => setPicking(true)}>
          <Plus />
        </button>
      </div>
      {tabs.map((x) => (
        <div key={x.sessionId} className="aiws-term" hidden={x !== active}>
          <TerminalPane sessionId={x.sessionId} active={x === active} local serverKey="localhost" aiCli={x.agent} />
        </div>
      ))}
    </div>
  )
}
