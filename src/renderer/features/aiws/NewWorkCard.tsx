import { useEffect, useState, type JSX } from 'react'
import type { BaseRef } from '@shared/worktrees'
import { t } from '../../i18n'
import { useAiwsStore } from './store'
import { AGENT_IDS, AGENTS, type AgentId } from '@shared/agents'
import { RUN_ON_LOCAL, projectsOn, runOnStep, type RunOnHost, type RunOnTarget } from '@shared/runOn'
import { pickInitialAgent, useAgentStore } from './agentStore'
import { useDialog } from '../../components/Dialog'
import { askManagedConsent } from '../managed/consent'

/**
 * M2 라운드 2 WS-02·WS-04 — 새 작업 만들기. Orca NewWorkspaceComposerCard·new-workspace/ComposerBaseRefPicker
 * (orcaRef 7a7f46f8a3)의 순서만 따른다: 프로젝트 → 이름(브랜치) → 분기 지점(검색 가능한 브랜치/태그) → 워크트리로/없이 → 만들기.
 * M3: 에이전트 + 첫 지시 — 만든 뒤 그 작업 단위에서 띄운다. 뺀 것: 이슈/PR 연결·설정 스크립트·고급 옵션.
 * M8 DM-05: 맨 위 **실행 위치**(Orca host-picker — 로컬 / 관리형 서버). 서버를 고르면 그 서버의 원격 저장소만 보이고, 동의 안 된 서버는 동의 화면부터.
 * 원격 저장소는 경로를 쳐서 더한다(`~/…` 가능). 워크트리로/없이·분기 지점·에이전트는 로컬과 같은 칸 — 실행은 그 서버의 orcad 에서.
 */
const REF_SEARCH_DEBOUNCE_MS = 150

export function NewWorkCard({ initialRepoId, onClose }: { initialRepoId?: string; onClose: () => void }): JSX.Element {
  const repos = useAiwsStore((s) => s.repos)
  const [where, setWhere] = useState<RunOnTarget>(() => repos.find((r) => r.id === initialRepoId)?.host ?? RUN_ON_LOCAL)
  const shownRepos = projectsOn(repos, where)
  const [repoId, setRepoId] = useState(initialRepoId ?? shownRepos[0]?.id ?? '')
  const repo = shownRepos.find((r) => r.id === repoId)
  const remote = where !== RUN_ON_LOCAL
  const [hosts, setHosts] = useState<RunOnHost[]>([])
  useEffect(() => {
    void window.ev.managed
      .hosts()
      .then(setHosts)
      .catch(() => {})
  }, [])
  const dialog = useDialog()
  const [whereBusy, setWhereBusy] = useState(false)
  const [whereMsg, setWhereMsg] = useState<string | null>(null)
  const [remotePath, setRemotePath] = useState('')
  // 동의 안 된 서버 → 동의 화면(설정 › 관리형 서버와 같은 화면). [취소]면 원래 자리에 머문다.
  const pickWhere = async (target: RunOnTarget): Promise<void> => {
    setWhereMsg(null)
    if (runOnStep(target, hosts) === 'consent') {
      setWhereBusy(true)
      try {
        const r = await askManagedConsent(dialog.ask, target)
        if (r !== 'installed') return setWhereMsg(typeof r === 'object' ? r.error : null)
        setHosts(await window.ev.managed.hosts())
      } catch (e) {
        return setWhereMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setWhereBusy(false)
      }
    }
    setWhere(target)
    setRepoId(projectsOn(useAiwsStore.getState().repos, target)[0]?.id ?? '')
  }
  const addRemote = async (): Promise<void> => {
    if (!remotePath.trim()) return
    setWhereBusy(true)
    setWhereMsg(null)
    const r = await useAiwsStore.getState().addRemoteRepo(where, remotePath.trim())
    setWhereBusy(false)
    if (typeof r === 'string') return setWhereMsg(t('aiws.new.remoteFail').replace('{msg}', r))
    setRemotePath('')
    setRepoId(r.id)
  }
  const isGit = repo?.kind === 'git'
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'worktree' | 'none'>('worktree')
  const [base, setBase] = useState('')
  const [refQuery, setRefQuery] = useState('')
  const [refs, setRefs] = useState<BaseRef[]>([])

  useEffect(() => {
    if (!isGit) {
      setRefs([])
      return
    }
    let live = true
    const h = setTimeout(() => {
      void window.ev.repos.searchBaseRefs(repoId, refQuery).then((r) => live && setRefs(r))
    }, REF_SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(h)
    }
  }, [repoId, refQuery, isGit])

  const effectiveMode = isGit ? mode : 'none'
  const canCreate = !!repo && (effectiveMode === 'none' || name.trim() !== '')

  // M3: 에이전트 + 첫 지시 — 만들고 나면 그 작업 단위에서 바로 띄운다(Orca 새 작업 카드의 에이전트 고르기).
  const detected = useAgentStore((s) => s.detected)
  const agentSettings = useAgentStore((s) => s.settings)
  useEffect(() => {
    if (!detected) void useAgentStore.getState().loadAgents()
  }, [detected])
  // 원격은 서버에 무엇이 깔렸는지 모른다(로컬 감지는 이 PC 의 것) — 켜 둔 에이전트를 모두 보이고, 없으면 원격 셸이 말해 준다.
  const usable = remote
    ? AGENT_IDS.filter((id) => agentSettings?.agents[id].enabled !== false).map((id) => ({ id }))
    : (detected ?? []).filter((d) => d.installed && agentSettings?.agents[d.id].enabled !== false)
  const [agentPick, setAgentPick] = useState<AgentId | '' | null>(null)
  const agent = agentPick ?? (remote ? (agentSettings?.defaultAgent ?? usable[0]?.id ?? '') : (pickInitialAgent(agentSettings, detected) ?? ''))
  const [prompt, setPrompt] = useState('')
  const launch = (worktreeId: string, cwd: string): void => {
    if (agent) void useAgentStore.getState().launchAgent({ agent, worktreeId, cwd, prompt })
  }

  const create = (): void => {
    if (!repo || !canCreate) return
    const st = useAiwsStore.getState()
    if (effectiveMode === 'none') {
      const id = st.openWithoutWorktree(repo.id)
      onClose()
      if (id) launch(id, repo.path)
      return
    }
    // 바로 닫는다 — 진행은 사이드바 줄이 보여 준다(WS-03). 다 만들어지면 그 워크트리를 고르고 에이전트를 띄운다.
    onClose()
    void st.createWorktree({ repoId: repo.id, name: name.trim(), baseBranch: base || undefined }).then((r) => {
      if (!r.ok) return
      useAiwsStore.getState().setActiveWorktree(r.worktree.id)
      launch(r.worktree.id, r.worktree.path)
    })
  }

  return (
    <div
      className="aiws-new"
      role="dialog"
      aria-label={t('aiws.new.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <h2 className="aiws-new-ttl">{t('aiws.new.title')}</h2>
      <label className="aiws-field">
        <span>{t('aiws.new.runOn')}</span>
        <select className="aiws-input" data-aiws="new-runon" value={where} disabled={whereBusy} onChange={(e) => void pickWhere(e.target.value)}>
          <option value={RUN_ON_LOCAL}>{t('aiws.new.runOnLocal')}</option>
          {hosts.map((h) => (
            <option key={h.hostKey} value={h.hostKey}>
              {`${h.label} · ${h.hostKey}${h.consented ? '' : ` · ${t('aiws.new.runOnNeedsInstall')}`}`}
            </option>
          ))}
        </select>
      </label>
      {remote && (
        <div className="aiws-field">
          <span>{t('aiws.new.remoteRepo')}</span>
          <div className="aiws-modes">
            <input
              className="aiws-input aiws-mono"
              data-aiws="new-remote-path"
              placeholder={t('aiws.new.remoteRepoPh')}
              value={remotePath}
              disabled={whereBusy}
              onChange={(e) => setRemotePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addRemote()
              }}
            />
            <button type="button" className="btn sec" data-aiws="new-remote-add" disabled={whereBusy || !remotePath.trim()} onClick={() => void addRemote()}>
              {t('aiws.new.remoteAdd')}
            </button>
          </div>
        </div>
      )}
      {whereBusy && <p className="aiws-note">{t('aiws.new.runOnBusy')}</p>}
      {whereMsg && (
        <p className="aiws-note aiws-err" data-aiws="new-runon-msg">
          {whereMsg}
        </p>
      )}
      {shownRepos.length === 0 ? (
        !remote && <p className="aiws-note">{t('aiws.new.noProject')}</p>
      ) : (
        <>
          <label className="aiws-field">
            <span>{t('aiws.new.project')}</span>
            <select className="aiws-input" data-aiws="new-project" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              {shownRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName}
                </option>
              ))}
            </select>
          </label>

          <div className="aiws-field" role="radiogroup" aria-label={t('aiws.new.mode')}>
            <span>{t('aiws.new.mode')}</span>
            <div className="aiws-modes">
              {(['worktree', 'none'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === m}
                  className={'aiws-mode' + (effectiveMode === m ? ' on' : '')}
                  data-mode={m}
                  disabled={m === 'worktree' && !isGit}
                  onClick={() => setMode(m)}
                >
                  <b>{m === 'worktree' ? t('aiws.new.modeWt') : t('aiws.new.modeNone')}</b>
                  <span>{m === 'worktree' ? t('aiws.new.modeWtDesc') : t('aiws.new.modeNoneDesc')}</span>
                </button>
              ))}
            </div>
            {!isGit && <p className="aiws-note">{t('aiws.new.folderOnly')}</p>}
          </div>

          {effectiveMode === 'worktree' && (
            <>
              <label className="aiws-field">
                <span>{t('aiws.new.name')}</span>
                <input
                  autoFocus
                  className="aiws-input"
                  data-aiws="new-name"
                  placeholder={t('aiws.new.namePh')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') create()
                  }}
                />
              </label>
              <div className="aiws-field">
                <span>
                  {t('aiws.new.base')} · <b className="aiws-mono" data-aiws="new-base-value">{base || t('aiws.new.baseHead')}</b>
                </span>
                <input
                  className="aiws-input"
                  data-aiws="new-base-search"
                  placeholder={t('aiws.new.baseSearch')}
                  value={refQuery}
                  onChange={(e) => setRefQuery(e.target.value)}
                />
                <div className="aiws-refs" role="listbox" aria-label={t('aiws.new.base')}>
                  <button type="button" role="option" aria-selected={base === ''} className={'aiws-ref' + (base === '' ? ' on' : '')} onClick={() => setBase('')}>
                    <span className="aiws-mono">HEAD</span>
                    <span className="aiws-ref-kind">{t('aiws.new.baseHead')}</span>
                  </button>
                  {refs.map((r) => (
                    <button
                      key={r.refName}
                      type="button"
                      role="option"
                      aria-selected={base === r.refName}
                      className={'aiws-ref' + (base === r.refName ? ' on' : '')}
                      data-ref={r.refName}
                      onClick={() => setBase(r.refName)}
                    >
                      <span className="aiws-mono">{r.refName}</span>
                      <span className="aiws-ref-kind">{t('aiws.ref.' + r.kind)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="aiws-field">
            <span>{t('aiws.new.agent')}</span>
            <select className="aiws-input" data-aiws="new-agent" value={agent} onChange={(e) => setAgentPick(e.target.value as AgentId | '')}>
              {usable.map((d) => (
                <option key={d.id} value={d.id}>
                  {AGENTS[d.id].label}
                </option>
              ))}
              <option value="">{t('aiws.new.noAgent')}</option>
            </select>
          </label>
          <label className="aiws-field">
            <span>{t('aiws.new.prompt')}</span>
            <textarea
              className="aiws-input"
              data-aiws="new-prompt"
              rows={3}
              disabled={!agent}
              placeholder={t('aiws.agent.promptPh')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="aiws-new-foot">
        <button type="button" className="btn sec" data-aiws="new-cancel" onClick={onClose}>
          {t('aiws.new.cancel')}
        </button>
        <button type="button" className="btn pri" data-aiws="new-create" disabled={!canCreate} onClick={create}>
          {t('aiws.new.create')}
        </button>
      </div>
      {dialog.node}
    </div>
  )
}
