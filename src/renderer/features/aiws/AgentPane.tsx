import { lazy, Suspense, useEffect, useState, type JSX } from 'react'
import { FileText, MessageSquare, Plus, SquareTerminal, X } from 'lucide-react'
import { AGENT_IDS, AGENTS, permissionChoicesFor, type AgentId, type AgentPermissionChoice } from '@shared/agents'
import { effortLabel, type ModelCatalog } from '@shared/agentOptions'
import type { Worktree } from '@shared/worktrees'
import { isMac, KEYMAP, matchBinding } from '@shared/keymap'
import { t } from '../../i18n'
import { TerminalPane } from '../../terminal/TerminalPane'
import { pickInitialAgent, useAgentStore } from './agentStore'
import { displayOf } from './agentStatusView'
import { AgentGlyph } from './AgentGlyph'
import { AgentChatView } from './AgentChatView'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { PLATFORM, useCodeStore, type CodeFile } from './codeStore'
import { areWorktreePathsEqual } from '@shared/worktrees'

// M6 WS-07: Monaco 는 이 청크가 아니라 CodeEditor 청크에 산다 — 파일 탭이 처음 생길 때만 불린다.
const CodeEditor = lazy(() => import('./CodeEditor'))
type AskFn = (spec: DialogSpec) => Promise<DialogResult>

/**
 * M3 AI-01 피커 — Orca AgentLaunchPickerMenu·AgentCombobox(orcaRef 7a7f46f8a3)의 1차: 설치된 에이전트를 고르고 첫 지시를 적어 한 번에 실행.
 * 설치 안 된 것은 보이되 못 고른다(설정 › 에이전트에서 끈 것은 안 보인다). 뺀 것: 검색·최근 순서.
 * M5 R2: 시작 전 초안 옵션(Orca draft session options) — 모델·추론 강도(AI-15, 설치된 CLI 가 알려 준 목록 — 지금은 Claude)·이번 탭 권한(AI-18)은
 * 첫 실행 인자로(--model·--effort·권한 플래그). 비워 두면 CLI 기본값·설정 › 에이전트의 권한.
 */
export function AgentPicker({ worktree, onLaunched, onCancel }: { worktree: Worktree; onLaunched?: () => void; onCancel?: () => void }): JSX.Element {
  const detected = useAgentStore((s) => s.detected)
  const settings = useAgentStore((s) => s.settings)
  const detecting = useAgentStore((s) => s.detecting)
  const [agent, setAgent] = useState<AgentId | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState<AgentPermissionChoice | ''>('')
  useEffect(() => {
    if (!detected) void useAgentStore.getState().loadAgents()
  }, [detected])
  const chosen = agent ?? pickInitialAgent(settings, detected)
  const shown = AGENT_IDS.filter((id) => settings?.agents[id].enabled !== false)
  // 모델 목록은 main 이 설치된 CLI 에 처음 한 번 묻고 기억한다(Claude 만 — 다른 에이전트는 칸을 안 그린다).
  useEffect(() => {
    setCatalog(null)
    setModel('')
    setEffort('')
    setPermission('')
    if (chosen !== 'claude' || !detected?.find((d) => d.id === chosen)?.installed) return
    let alive = true
    void window.ev.agents.models(chosen).then((c) => alive && setCatalog(c))
    return () => {
      alive = false
    }
  }, [chosen, detected])
  const models = catalog && 'models' in catalog ? catalog.models : []
  const efforts = (models.find((m) => m.id === model) ?? models.find((m) => m.isDefault))?.efforts ?? []

  const launch = async (): Promise<void> => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    const options = { ...(model ? { model } : {}), ...(effort && efforts.includes(effort) ? { effort } : {}), ...(permission ? { permission } : {}) }
    const r = await useAgentStore.getState().launchAgent({ agent: chosen, worktreeId: worktree.id, cwd: worktree.path, prompt, options })
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
      {chosen && (
        <div className="aiws-chat-opts" data-aiws="launch-options">
          {models.length > 0 && (
            <label className="aiws-pill">
              <span>{t('aiws.opt.model')}</span>
              <select data-aiws="opt-model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{t('aiws.opt.cliDefault')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id} title={m.description}>
                    {m.label}
                    {m.isDefault ? ` · ${t('aiws.opt.default')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {efforts.length > 0 && (
            <label className="aiws-pill">
              <span>{t('aiws.opt.effort')}</span>
              <select data-aiws="opt-effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">{t('aiws.opt.cliDefault')}</option>
                {efforts.map((v) => (
                  <option key={v} value={v}>
                    {effortLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="aiws-pill" title={t('aiws.opt.permission.title')}>
            <span>{t('aiws.opt.permission')}</span>
            <select data-aiws="opt-permission" value={permission} onChange={(e) => setPermission(e.target.value as AgentPermissionChoice | '')}>
              <option value="">{`${t('aiws.opt.fromSettings')} · ${t('settings.agents.perm.' + (settings?.agents[chosen].permission ?? 'own'))}`}</option>
              {permissionChoicesFor(chosen).map((c) => (
                <option key={c} value={c}>
                  {t('settings.agents.perm.' + c)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
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

const chatKey = KEYMAP.find((k) => k.action === 'agent.chatToggle')
const CHAT_KEY = chatKey ? (isMac() ? chatKey.mac : chatKey.win) : ''

/**
 * M3 AI-03 가운데 — 고른 작업 단위의 **에이전트 터미널 탭 줄**(시안 SW-final: 에이전트 탭 + 파일 탭 자리) + 그 탭의 터미널.
 * 터미널은 아라의 TerminalPane 그대로(로컬 PTY). 탭을 바꿔도 다른 탭의 xterm 은 붙은 채 숨긴다(스크롤백 유지).
 * 탭이 없거나 [+] 를 누르면 피커.
 */
export function AgentWorkspace({ worktree, ask }: { worktree: Worktree; ask: AskFn }): JSX.Element {
  const allTabs = useAgentStore((s) => s.tabs)
  const activeId = useAgentStore((s) => s.activeTabByWorktree[worktree.id])
  const tabs = allTabs.filter((x) => x.worktreeId === worktree.id)
  const statusById = useAgentStore((s) => s.statusById)
  const seenById = useAgentStore((s) => s.seenById)
  const chatOn = useAgentStore((s) => s.chatOn)
  const [picking, setPicking] = useState(false)
  // M6 파일 탭 — 이 작업 단위에서 연 파일과 지금 보이는 파일(있으면 에이전트 탭 대신 에디터가 보인다).
  const allFiles = useCodeStore((s) => s.files)
  const files = allFiles.filter((f) => f.worktreeId === worktree.id)
  const activeFilePath = useCodeStore((s) => s.activeByWorktree[worktree.id] ?? null)
  const shownFile = activeFilePath ? files.find((f) => areWorktreePathsEqual(f.path, activeFilePath, PLATFORM)) : undefined
  const shownTab = tabs.length === 0 || picking || shownFile ? null : (tabs.find((x) => x.sessionId === activeId) ?? tabs[tabs.length - 1])
  const shownId = shownTab?.sessionId ?? null
  const chatAgent = shownTab ? shownTab.sessionId : null
  // 지금 보이는 탭 = 본 것(herdr seen). 공간을 떠나면(언마운트) 아무것도 안 보고 있다.
  useEffect(() => {
    useAgentStore.getState().setViewing(shownId)
    return () => useAgentStore.getState().setViewing(null)
  }, [shownId])
  // M3 S1(제거 A8): 옛 터미널 AI 키 — Ctrl+Shift+L = 피커, Alt+1·2·3 = 그 에이전트를 이 워크트리에서 바로(첫 지시 없이).
  // 못 띄우면(설치 안 됨·꺼 둠) 피커를 열어 이유를 보게 한다. 이 화면이 떠 있을 때만 받는다(터미널 공간에선 무동작).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // M5 AI-13 채팅 ↔ 터미널(같은 세션). 채팅을 볼 수 있는 에이전트 탭이 보일 때만.
      if (matchBinding(e, 'agent.chatToggle')) {
        if (!chatAgent) return
        e.preventDefault()
        useAgentStore.getState().toggleChat(chatAgent)
        return
      }
      if (matchBinding(e, 'agent.start')) {
        e.preventDefault()
        setPicking(true)
        return
      }
      const agent = AGENT_IDS.find((id) => matchBinding(e, `agent.start.${id}`))
      if (!agent) return
      e.preventDefault()
      void useAgentStore
        .getState()
        .launchAgent({ agent, worktreeId: worktree.id, cwd: worktree.path })
        .then((r) => !r.ok && setPicking(true))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [worktree.id, worktree.path, chatAgent])
  if ((tabs.length === 0 && files.length === 0) || picking) {
    return (
      <AgentPicker
        worktree={worktree}
        onLaunched={() => {
          setPicking(false)
          useCodeStore.getState().setActive(worktree.id, null)
        }}
        onCancel={tabs.length || files.length ? () => setPicking(false) : undefined}
      />
    )
  }
  const active = tabs.find((x) => x.sessionId === activeId) ?? tabs[tabs.length - 1]
  const chatting = !!active && !!chatOn[active.sessionId]
  // 더러운 파일을 닫으면 아라 공용 대화상자로 묻는다 — 저장 / 저장 안 함 / 취소.
  const closeFile = async (f: CodeFile): Promise<void> => {
    if (f.dirty) {
      const r = await ask({
        title: t('code.close.title'),
        message: t('code.close.msg').replace('{name}', baseName(f.path)),
        confirmLabel: t('code.close.save'),
        altLabel: t('code.close.discard')
      })
      if (r === 'cancel') return
      if (r === 'confirm' && !(await useCodeStore.getState().editorOps?.save(f.path))) return
    }
    useCodeStore.getState().closeFile(f.path)
  }
  return (
    <div className="aiws-agentws" data-aiws="agent-ws">
      <div className="aiws-tabs" role="tablist" aria-label={t('aiws.agent.tabs')}>
        {tabs.map((x) => (
          <div
            key={x.sessionId}
            role="tab"
            tabIndex={0}
            aria-selected={x === active && !shownFile}
            className={'aiws-tab' + (x === active && !shownFile ? ' on' : '')}
            data-agent-tab={x.agent}
            data-state={x.exited ? 'exited' : (statusById[x.sessionId]?.state ?? 'running')}
            title={x.line}
            onClick={() => {
              useCodeStore.getState().setActive(worktree.id, null)
              useAgentStore.getState().setActiveTab(worktree.id, x.sessionId)
            }}
          >
            {x.exited ? (
              <span className="aiws-tab-dot off" aria-hidden />
            ) : (
              <AgentGlyph
                display={displayOf(statusById[x.sessionId], seenById[x.sessionId] ?? true)}
                estimated={statusById[x.sessionId]?.estimated ?? true}
                detail={[statusById[x.sessionId]?.tool, statusById[x.sessionId]?.source].filter(Boolean).join(' · ')}
              />
            )}
            <span>{AGENTS[x.agent].label}</span>
            {x.name && (
              <span className="aiws-tab-name" data-aiws="tab-name" title={x.name}>
                {x.name}
              </span>
            )}
            <span className="aiws-tab-state" title={x.lost ? t('aiws.agent.lost.title') : undefined}>{x.lost ? t('aiws.agent.lost') : x.exited ? t('aiws.agent.exited') : t(`aiws.st.${displayOf(statusById[x.sessionId], seenById[x.sessionId] ?? true)}`)}</span>
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
        {/* M6 파일 탭(시안 SW-final: 에이전트 탭 옆 `OrderRetryPolicy.java`). 더러우면 ● — 닫을 때 묻는다. */}
        {files.map((f) => (
          <div
            key={f.path}
            role="tab"
            tabIndex={0}
            aria-selected={f === shownFile}
            className={'aiws-tab' + (f === shownFile ? ' on' : '')}
            data-file-tab={baseName(f.path)}
            data-dirty={f.dirty || undefined}
            title={f.path}
            onClick={() => useCodeStore.getState().setActive(worktree.id, f.path)}
          >
            <FileText className="aiws-tab-ic" aria-hidden />
            <span>{baseName(f.path)}</span>
            {f.dirty && (
              <span className="code-dirty" data-code="dirty" title={t('code.dirty')}>
                ●
              </span>
            )}
            <button
              type="button"
              className="aiws-ic"
              aria-label={t('code.close.tab')}
              onClick={(e) => {
                e.stopPropagation()
                void closeFile(f)
              }}
            >
              <X />
            </button>
          </div>
        ))}
        {active && !shownFile && (
          <button
            type="button"
            className={'aiws-tab aiws-chat-toggle' + (chatting ? ' on' : '')}
            data-aiws="chat-toggle"
            aria-pressed={chatting}
            title={`${t(chatting ? 'aiws.chat.toTerminal' : 'aiws.chat.toChat')} (${CHAT_KEY})`}
            onClick={() => useAgentStore.getState().toggleChat(active.sessionId)}
          >
            {chatting ? <SquareTerminal className="aiws-tab-ic" aria-hidden /> : <MessageSquare className="aiws-tab-ic" aria-hidden />}
            <span>{t(chatting ? 'aiws.chat.terminal' : 'aiws.chat.chat')}</span>
          </button>
        )}
        <button type="button" className="aiws-ic" data-aiws="agent-add" aria-label={t('aiws.agent.add')} title={t('aiws.agent.add')} onClick={() => setPicking(true)}>
          <Plus />
        </button>
      </div>
      {active && !shownFile && active.prompt && statusById[active.sessionId]?.promptFailed && (
        <div className="aiws-note aiws-err aiws-prompt-failed" role="alert" data-aiws="prompt-failed">
          <span>{t('aiws.agent.promptFailed')}</span>
          <textarea className="aiws-input aiws-mono" readOnly rows={2} value={active.prompt} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {active && chatting && !shownFile && <AgentChatView key={active.sessionId} tab={active} cwd={worktree.path} status={statusById[active.sessionId]} onTerminal={() => useAgentStore.getState().toggleChat(active.sessionId)} />}
      {tabs.map((x) => (
        <div key={x.sessionId} className="aiws-term" hidden={x !== active || chatting || !!shownFile}>
          <TerminalPane sessionId={x.sessionId} active={x === active && !chatting && !shownFile} local serverKey="localhost" agent />
        </div>
      ))}
      {/* 파일을 하나라도 열었으면 에디터를 붙여 둔다(숨겨도 모델·스크롤 유지). 처음 열 때만 Monaco 청크가 불린다. */}
      {files.length > 0 && (
        <Suspense fallback={<div className="aiws-note">{t('code.loading')}</div>}>
          <CodeEditor worktreeId={worktree.id} ask={ask} hidden={!shownFile} />
        </Suspense>
      )}
    </div>
  )
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
