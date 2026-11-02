import { useEffect, useMemo, useState, type JSX } from 'react'
import type { BaseRef, OrcaYamlPreview, SparsePreset } from '@shared/worktrees'
import { pushNote } from '../../store/notify'
import { t } from '../../i18n'
import { useAiwsStore } from './store'
import { AGENT_IDS, AGENTS, type AgentId } from '@shared/agents'
import { RUN_ON_LOCAL, projectsOn, runOnStep, type RunOnHost, type RunOnTarget } from '@shared/runOn'
import { pickInitialAgent, useAgentStore } from './agentStore'
import { useDialog } from '../../components/Dialog'
import { askManagedConsent } from '../managed/consent'
import { getSuggestedCreatureName, getWorkspaceSeedName } from '@shared/worktreeNames'

/**
 * M2 라운드 2 WS-02·WS-04 — 새 작업 만들기. Orca NewWorkspaceComposerCard·new-workspace/ComposerBaseRefPicker
 * (orcaRef 7a7f46f8a3)의 순서만 따른다: 프로젝트 → 이름(브랜치) → 분기 지점(검색 가능한 브랜치/태그) → 워크트리로/없이 → 만들기.
 * M3: 에이전트 + 첫 지시 — 만든 뒤 그 작업 단위에서 띄운다. 뺀 것: 이슈/PR 연결·설정 스크립트·고급 옵션.
 * M8 DM-05: 맨 위 **실행 위치**(Orca host-picker — 로컬 / 관리형 서버). 서버를 고르면 그 서버의 원격 저장소만 보이고, 동의 안 된 서버는 동의 화면부터.
 * 원격 저장소는 경로를 쳐서 더한다(`~/…` 가능). 워크트리로/없이·분기 지점·에이전트는 로컬과 같은 칸 — 실행은 그 서버의 orcad 에서.
 * M10 WS-14 이름 칸은 비워도 된다(Orca "Automatic name") — 첫 지시의 영문 조각, 없으면 바다 생물 이름(shared/worktreeNames.ts).
 * 3차(orcaRef ec112c6b01 — NewWorkspaceComposerAdvancedSection·ComposerParentWorktreePicker·sparse/SparsePresetChooser):
 *  · WS-24 부모 작업 단위(선택) — 사이드바 "하위 작업 만들기"면 미리 들어 있다.
 *  · WS-27 sparse checkout 프리셋(선택) — 프로젝트별 폴더 목록, 카드 안에서 만들고 지운다.
 *  · WS-23 orca.yaml — 본 폴더에 setup/archive 스크립트가 있으면 "스크립트 쓰기" 칸. 처음 보는 내용이면 만들 때 글 그대로 보여 주고 승인을 받는다.
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
  const local = !remote && isGit
  // WS-24 부모 — 사이드바 "하위 작업 만들기"가 남긴 값을 읽고 비운다. 카드가 이미 열려 있을 때 눌러도 받는다(그 프로젝트·로컬로 옮김).
  const [parentId, setParentId] = useState('')
  const pendingParent = useAiwsStore((s) => s.composerParentId)
  useEffect(() => {
    if (!pendingParent) return
    useAiwsStore.getState().setComposerParent(null)
    setWhere(RUN_ON_LOCAL)
    setRepoId(pendingParent.split('::')[0])
    setParentId(pendingParent)
  }, [pendingParent])
  const repoWorktrees = useAiwsStore((s) => s.worktreesByRepo[repoId])
  const parentChoices = useMemo(() => (repoWorktrees ?? []).filter((w) => !w.isArchived && !w.hidden), [repoWorktrees])
  // WS-27 sparse 프리셋.
  const [presets, setPresets] = useState<SparsePreset[]>([])
  const [presetId, setPresetId] = useState('')
  const [presetEdit, setPresetEdit] = useState<{ name: string; dirs: string } | null>(null)
  const [presetErr, setPresetErr] = useState<string | null>(null)
  // WS-23 orca.yaml.
  const [yaml, setYaml] = useState<OrcaYamlPreview>({ found: false })
  const [useScripts, setUseScripts] = useState(true)
  useEffect(() => {
    setPresetId('')
    setPresetEdit(null)
    setParentId((p) => (p.startsWith(repoId + '::') ? p : ''))
    setYaml({ found: false })
    if (!local) return setPresets([])
    let live = true
    void window.ev.sparsePresets.list(repoId).then((p) => live && setPresets(p))
    void window.ev.repos.orcaYaml(repoId).then((y) => live && setYaml(y))
    return () => {
      live = false
    }
  }, [repoId, local])
  const savePreset = async (): Promise<void> => {
    if (!presetEdit) return
    const r = await window.ev.sparsePresets.save(repoId, { name: presetEdit.name, directories: presetEdit.dirs.split(/\r?\n/) })
    if ('error' in r) return setPresetErr(t('aiws.sparse.err.' + (r.error === 'name' || r.error === 'directories' ? r.error : 'path')))
    setPresets((p) => [...p.filter((x) => x.id !== r.id), r])
    setPresetId(r.id)
    setPresetEdit(null)
    setPresetErr(null)
  }
  const removePreset = async (): Promise<void> => {
    if (!presetId) return
    await window.ev.sparsePresets.remove(repoId, presetId)
    setPresets((p) => p.filter((x) => x.id !== presetId))
    setPresetId('')
  }

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
  const canCreate = !!repo
  // WS-14 자동 이름 — 모든 프로젝트의 워크트리 폴더 이름 + 이 프로젝트의 지운 자동 이름을 피한다. 카드를 여는 동안 고정(무작위가 깜빡이지 않게).
  const byRepo = useAiwsStore((s) => s.worktreesByRepo)
  const creature = useMemo(() => getSuggestedCreatureName(byRepo, Math.random, repo?.retiredNames), [byRepo, repo?.retiredNames])

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

  /** WS-23 처음 보는 setup/archive 스크립트면 글 그대로 보여 주고 승인을 받는다(Orca 공유 명령 승인). 거절하면 스크립트 없이 만든다. */
  const approveScripts = async (): Promise<boolean> => {
    const scripts = [yaml.setup, yaml.archive].filter((x): x is NonNullable<typeof x> => !!x)
    if (!useScripts || scripts.length === 0) return false
    const fresh = scripts.filter((x) => !x.trusted)
    if (fresh.length === 0) return true
    const yes = await dialog.ask({
      title: t('aiws.yaml.approveTitle'),
      message: t('aiws.yaml.approveMsg').replace('{p}', repo?.displayName ?? ''),
      detail: [
        ...(yaml.setup && !yaml.setup.trusted ? [{ label: 'scripts.setup', value: yaml.setup.script }] : []),
        ...(yaml.archive && !yaml.archive.trusted ? [{ label: 'scripts.archive', value: yaml.archive.script }] : [])
      ],
      confirmLabel: t('aiws.yaml.approve')
    })
    if (yes !== 'confirm') return false
    return window.ev.repos.trustOrcaScripts(repoId, fresh.map((x) => x.hash))
  }

  const create = async (): Promise<void> => {
    if (!repo || !canCreate) return
    const st = useAiwsStore.getState()
    if (effectiveMode === 'none') {
      const id = st.openWithoutWorktree(repo.id)
      onClose()
      if (id) launch(id, repo.path)
      return
    }
    const runSetup = local && !!yaml.setup && (await approveScripts())
    const sparse = presets.find((p) => p.id === presetId)?.directories
    // 바로 닫는다 — 진행은 사이드바 줄이 보여 준다(WS-03). 다 만들어지면 그 워크트리를 고르고 에이전트를 띄운다.
    onClose()
    const seed = getWorkspaceSeedName({ explicitName: name, prompt: agent ? prompt : '', fallbackName: creature })
    const nameWasGenerated = !name.trim() && seed === creature
    void st
      .createWorktree({
        repoId: repo.id,
        name: seed,
        baseBranch: base || undefined,
        nameWasGenerated,
        ...(local && parentId ? { parentWorktreeId: parentId } : {}),
        ...(local && sparse ? { sparseDirectories: sparse } : {}),
        ...(runSetup ? { runSetup } : {})
      })
      .then((r) => {
        if (!r.ok) return
        useAiwsStore.getState().setActiveWorktree(r.worktree.id)
        launch(r.worktree.id, r.worktree.path)
      })
  }
  // archive 만 있는 orca.yaml 도 승인 길이 있어야 한다 — 만들 때 "스크립트 쓰기"가 켜져 있으면 같이 묻는다.
  const createClick = (): void => {
    if (local && !yaml.setup && yaml.archive && !yaml.archive.trusted && useScripts) {
      void approveScripts().then((ok) => {
        if (!ok) pushNote({ kind: 'info', space: 'ai', title: t('aiws.yaml.archiveSkipped') })
        void create()
      })
      return
    }
    void create()
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
                  placeholder={t('aiws.new.nameAuto').replace('{name}', getWorkspaceSeedName({ explicitName: '', prompt: agent ? prompt : '', fallbackName: creature }))}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createClick()
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
              {local && (
                <label className="aiws-field">
                  <span>{t('aiws.lineage.parent')}</span>
                  <select className="aiws-input" data-aiws="new-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                    <option value="">{t('aiws.lineage.noParent')}</option>
                    {parentChoices.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {local && (
                <div className="aiws-field">
                  <span>{t('aiws.sparse.label')}</span>
                  <div className="aiws-modes">
                    <select className="aiws-input" data-aiws="new-sparse" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                      <option value="">{t('aiws.sparse.none')}</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {`${p.name} · ${p.directories.length}`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn sec"
                      data-aiws="sparse-new"
                      onClick={() => {
                        const cur = presets.find((p) => p.id === presetId)
                        setPresetEdit({ name: cur?.name ?? '', dirs: cur?.directories.join('\n') ?? '' })
                      }}
                    >
                      {presetId ? t('aiws.sparse.edit') : t('aiws.sparse.new')}
                    </button>
                    {presetId && (
                      <button type="button" className="btn sec" data-aiws="sparse-remove" onClick={() => void removePreset()}>
                        {t('aiws.sparse.remove')}
                      </button>
                    )}
                  </div>
                  {presetEdit && (
                    <div className="aiws-sparse-edit">
                      <input
                        className="aiws-input"
                        data-aiws="sparse-name"
                        placeholder={t('aiws.sparse.namePh')}
                        value={presetEdit.name}
                        onChange={(e) => setPresetEdit({ ...presetEdit, name: e.target.value })}
                      />
                      <textarea
                        className="aiws-input aiws-mono"
                        data-aiws="sparse-dirs"
                        rows={3}
                        placeholder={t('aiws.sparse.dirsPh')}
                        value={presetEdit.dirs}
                        onChange={(e) => setPresetEdit({ ...presetEdit, dirs: e.target.value })}
                      />
                      {presetErr && <p className="aiws-note aiws-err">{presetErr}</p>}
                      <div className="aiws-modes">
                        <button type="button" className="btn sec" onClick={() => setPresetEdit(null)}>
                          {t('dlg.cancel')}
                        </button>
                        <button type="button" className="btn pri" data-aiws="sparse-save" onClick={() => void savePreset()}>
                          {t('aiws.cp.save')}
                        </button>
                      </div>
                    </div>
                  )}
                  <p className="aiws-note">{t('aiws.sparse.note')}</p>
                </div>
              )}
              {local && yaml.found && (
                <div className="aiws-field" data-aiws="new-yaml">
                  <span>orca.yaml</span>
                  {yaml.invalid ? (
                    <p className="aiws-note aiws-err">{t('aiws.yaml.invalid')}</p>
                  ) : (
                    <>
                      {(yaml.setup || yaml.archive) && (
                        <label className="aiws-ext-src-row">
                          <input type="checkbox" data-aiws="new-yaml-scripts" checked={useScripts} onChange={(e) => setUseScripts(e.target.checked)} />
                          <span>
                            {t('aiws.yaml.use')}
                            {` (${[yaml.setup && 'setup', yaml.archive && 'archive'].filter(Boolean).join(' · ')})`}
                            {[yaml.setup, yaml.archive].some((x) => x && !x.trusted) ? ` — ${t('aiws.yaml.needsApproval')}` : ''}
                          </span>
                        </label>
                      )}
                      {yaml.sharedDirectories?.length ? <p className="aiws-note">{t('aiws.yaml.shared').replace('{dirs}', yaml.sharedDirectories.join(', '))}</p> : null}
                    </>
                  )}
                </div>
              )}
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
        <button type="button" className="btn pri" data-aiws="new-create" disabled={!canCreate} onClick={createClick}>
          {t('aiws.new.create')}
        </button>
      </div>
      {dialog.node}
    </div>
  )
}
