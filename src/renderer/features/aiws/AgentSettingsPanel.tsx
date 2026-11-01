import { useEffect, useState, type JSX } from 'react'
import { AGENT_IDS, AGENTS, envToLines, memoryCapOf, parseEnvLines, permissionChoicesFor, planAgentLaunch, type AgentId, type AgentPrefs, type AgentSettings } from '@shared/agents'
import type { LaunchShell } from '@shared/aiCli'
import { t } from '../../i18n'
import { useAgentStore } from './agentStore'
import { Row, Toggle } from '../../components/SettingsPage'
import { useDialog } from '../../components/Dialog'

/**
 * M3 설정 › AI 작업 공간 › 에이전트 — Orca AgentDetectionCatalog(감지 목록·켜고 끄기) + AgentLaunchSettingsSection·AgentPermissionModeMenu
 * (에이전트별 인자·환경·권한 모드)·명령 바꾸기(orcaRef 7a7f46f8a3)의 1차. 실행될 한 줄을 그대로 보여 준다 — 권한을 끄는 플래그를 감추지 않는다.
 * 설정 화면(진입 청크)이 lazy 로 불러온다(features/aiws/index.ts).
 */
export function AgentSettingsPanel(): JSX.Element {
  const settings = useAgentStore((s) => s.settings)
  const detected = useAgentStore((s) => s.detected)
  const detecting = useAgentStore((s) => s.detecting)
  const [sel, setSel] = useState<AgentId>('claude')
  const [shell, setShell] = useState<LaunchShell>('posix')
  const [killed, setKilled] = useState<number | null>(null)
  const dialog = useDialog()
  useEffect(() => {
    if (!detected) void useAgentStore.getState().loadAgents()
    void window.ev?.app.launchShell().then((s) => s && setShell(s))
  }, [detected])
  if (!settings) return <div className="set-note">{t('aiws.agent.detecting')}</div>

  const save = (next: AgentSettings): void => void useAgentStore.getState().saveSettings(next)
  const setAgent = (id: AgentId, patch: Partial<AgentPrefs>): void => save({ ...settings, agents: { ...settings.agents, [id]: { ...settings.agents[id], ...patch } } })
  const prefs = settings.agents[sel]
  const plan = planAgentLaunch({ agent: sel, settings, prompt: t('aiws.agent.previewPrompt'), shell })

  return (
    <div data-sec="agents.launch">
      <div className="set-sec-t" data-item="agents.detect">
        {t('settings.agents.detect')}
      </div>
      {AGENT_IDS.map((id) => {
        const d = detected?.find((x) => x.id === id)
        return (
          <Row key={id} label={AGENTS[id].label} desc={d?.installed ? `${d.version ?? t('aiws.agent.versionUnknown')} · ${d.path}` : detected ? t('aiws.agent.notInstalled') : t('aiws.agent.detecting')} item={`agents.${id}`}>
            <Toggle on={settings.agents[id].enabled} label={AGENTS[id].label} onChange={(enabled) => setAgent(id, { enabled })} />
          </Row>
        )
      })}
      <Row label={t('settings.agents.redetect')} desc={t('settings.agents.redetect.desc')}>
        <button type="button" className="btn" disabled={detecting} data-aiws="agents-redetect" onClick={() => void useAgentStore.getState().loadAgents(true)}>
          {t('aiws.agent.redetect')}
        </button>
      </Row>
      <Row label={t('settings.agents.default')} item="agents.default">
        <div className="seg-ctl" data-field="agents.default">
          {AGENT_IDS.map((id) => (
            <button type="button" key={id} className={settings.defaultAgent === id ? 'on' : ''} onClick={() => save({ ...settings, defaultAgent: id })}>
              {AGENTS[id].label}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('settings.agents.rc')} desc={t('settings.agents.rc.desc')} item="agents.rc">
        <Toggle on={settings.claudeRemoteControl} label={t('settings.agents.rc')} onChange={(claudeRemoteControl) => save({ ...settings, claudeRemoteControl })} />
      </Row>

      {/* M4 DM-01 — 에이전트는 로컬 데몬에서 돌아 앱을 닫아도 산다. 끄는 길 둘(Orca Quit Completely). */}
      <div className="set-sec-t" data-item="agents.daemon">
        {t('settings.agents.daemon')}
      </div>
      <div className="set-note">{t('settings.agents.daemon.desc')}</div>
      <Row label={t('settings.agents.killBackground')} desc={killed === null ? t('settings.agents.killBackground.desc') : t('settings.agents.killBackground.done').replace('{n}', String(killed))} item="agents.killBackground">
        <button type="button" className="btn" data-aiws="agents-kill-background" onClick={() => void window.ev.agents.killBackground().then((r) => setKilled(r.killed))}>
          {t('settings.agents.killBackground')}
        </button>
      </Row>
      <Row label={t('settings.agents.quitCompletely')} desc={t('settings.agents.quitCompletely.desc')} item="agents.quitCompletely">
        <button
          type="button"
          className="btn"
          data-aiws="agents-quit-completely"
          onClick={() =>
            void dialog
              .ask({ title: t('settings.agents.quitCompletely'), message: t('settings.agents.quitCompletely.confirm'), tone: 'danger', confirmLabel: t('settings.agents.quitCompletely') })
              .then((r) => void (r === 'confirm' && window.ev.agents.quitCompletely()))
          }
        >
          {t('settings.agents.quitCompletely')}
        </button>
      </Row>
      {dialog.node}

      {/* M4 R3 자원 상한 — 적용은 로컬 데몬이(우선순위는 다음 실행부터, 메모리 알림은 바로). 하드 상한이 아니다 — 넘어도 끄지 않는다. */}
      <div className="set-sec-t" data-item="agents.resources">
        {t('settings.agents.resources')}
      </div>
      <Row label={t('settings.agents.lowPriority')} desc={t('settings.agents.lowPriority.desc')} item="agents.lowPriority">
        <Toggle on={settings.lowPriority} label={t('settings.agents.lowPriority')} onChange={(lowPriority) => save({ ...settings, lowPriority })} />
      </Row>
      <Row label={t('settings.agents.memoryCap')} desc={t('settings.agents.memoryCap.desc')} item="agents.memoryCap">
        <input
          key={`m-${settings.memoryCapMb}`}
          className="aiws-input aiws-mono"
          data-field="agents.memoryCap"
          type="number"
          min={0}
          step={256}
          placeholder={t('resources.limit.off')}
          defaultValue={settings.memoryCapMb || ''}
          onBlur={(e) => memoryCapOf(e.target.value) !== settings.memoryCapMb && save({ ...settings, memoryCapMb: memoryCapOf(e.target.value) })}
        />
      </Row>

      <div className="set-sec-t" data-item="agents.launch">
        {t('settings.agents.launch')}
      </div>
      <Row label={t('settings.agents.pick')}>
        <div className="seg-ctl" data-field="agents.pick">
          {AGENT_IDS.map((id) => (
            <button type="button" key={id} className={sel === id ? 'on' : ''} onClick={() => setSel(id)}>
              {AGENTS[id].label}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('settings.agents.permission')} desc={t('settings.agents.permission.desc')} item="agents.permission">
        <div className="seg-ctl" data-field="agents.permission">
          {permissionChoicesFor(sel).map((c) => (
            <button type="button" key={c} data-value={c} className={prefs.permission === c ? 'on' : ''} onClick={() => setAgent(sel, { permission: c })}>
              {t('settings.agents.perm.' + c)}
            </button>
          ))}
        </div>
      </Row>
      {/* 글 칸은 key 로 에이전트마다 새로 그린다(고른 에이전트가 바뀌면 칸 값도 바뀌게) — 저장은 칸을 떠날 때. */}
      <Row label={t('settings.agents.args')} desc={t('settings.agents.args.desc')} item="agents.args">
        <input key={`a-${sel}`} className="aiws-input aiws-mono" data-field="agents.args" defaultValue={prefs.args} onBlur={(e) => e.target.value !== prefs.args && setAgent(sel, { args: e.target.value })} />
      </Row>
      <Row label={t('settings.agents.env')} desc={t('settings.agents.env.desc')} item="agents.env">
        <textarea
          key={`e-${sel}`}
          className="aiws-input aiws-mono"
          data-field="agents.env"
          rows={3}
          defaultValue={envToLines(prefs.env)}
          onBlur={(e) => setAgent(sel, { env: parseEnvLines(e.target.value).env })}
        />
      </Row>
      <Row label={t('settings.agents.command')} desc={t('settings.agents.command.desc').replace('{bin}', AGENTS[sel].bin)} item="agents.command">
        <input
          key={`c-${sel}`}
          className="aiws-input aiws-mono"
          data-field="agents.command"
          placeholder={AGENTS[sel].bin}
          defaultValue={prefs.command}
          onBlur={(e) => e.target.value !== prefs.command && setAgent(sel, { command: e.target.value })}
        />
      </Row>
      <Row label={t('settings.agents.preview')} desc={plan.ok && plan.permissionShadowed ? t('settings.agents.shadowed') : undefined} item="agents.preview">
        <code className="aiws-mono" data-field="agents.preview">
          {plan.ok ? plan.line : plan.error}
        </code>
      </Row>
    </div>
  )
}
