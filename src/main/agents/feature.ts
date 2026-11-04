// M3 에이전트(AI-01·02·03, R2: AI-04·05·06) — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// 설정은 userData/agents.json(workspace.json 과 따로 — projects.json 과 같은 방식, atomicJson .bak).
// 실행은 Orca 처럼 main 이 계획한다(spawn-agent-launch.ts → planAgentPaneLaunch): 렌더러는 에이전트·폴더·첫 지시만 보내고
// 명령줄·env 는 main 이 저장된 설정으로 만든다. PTY 는 아라의 로컬 세션 경로 그대로(MainSessionManager → PtyBackend, DA1 수정 포함).
// R2: 첫 실행 때 훅 서버를 열고(그 에이전트의 훅을 심고) 탭을 상태 원장(status.ts)에 올린다 — AI 작업 공간을 안 쓰면 아무것도 안 돈다.
// M4 DM-01: 에이전트 PTY 는 로컬 데몬(main/daemon)에 만든다 — 앱을 끄고 켜도(업데이트 포함) 산다. 켤 때 살아 있는 세션에 다시 붙어 탭을 되살린다.
// 데몬을 못 쓰면(띄우기 실패 등) 예전처럼 앱의 로컬 PTY 로 연다(그 탭은 앱과 함께 끝난다).
import { randomUUID } from 'node:crypto'
import { appendFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { app, powerMonitor, powerSaveBlocker, type WebContents } from 'electron'
import { handle } from '../ipc/handle'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { pushSend } from '../util/windowPush'
import { logMainError, mainErrorLogPath } from '../log/MainErrorLog'
import { defaultLaunchShell } from '../sessions/PtyBackend'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { AGENTS, agentLimitsOf, agentSettingsOf, isAgentId, migrateAiCliFlags, PERMISSION_CHOICES, planAgentLaunch, type AgentId, type AgentPermissionChoice, type AgentSettings } from '@shared/agents'
import { HOOK_ENV, isHookSource, type AgentStatusView, type HookSource } from '@shared/agentHooks'
import type { AgentLaunchOptions, AgentLaunchResult, AgentTabInfo } from '@shared/ipc'
import type { AgentLimits } from '@shared/resources'
import { createAgentDetector } from './detect'
import { claudeLaunchArgs, createHookServer, geminiLaunchDefaults, installHooks, writeLaunchFile } from './hooks'
import { createAgentStatusTracker, type AgentStatusTracker } from './status'
import { createChatWatcher, type ChatWatcher } from './chat'
import { createRemoteChat, type RemoteChat } from './remoteChat'
import { generateChatName, listModels, scanSlash } from './options'
import { ingestAiWrite } from '../code/aiLines'
import { isOptionValue, type ModelCatalog } from '@shared/agentOptions'
import { createAgentDaemon, daemonRuntimeDir } from '../daemon/service'
import { withAraCliPath } from '../cli/childPath'
import { installRuntime, relocatedRuntime } from '../daemon/launcher'
import type { DaemonSessionInfo } from '../daemon/protocol'
import { createTerminalDaemonHook, isTerminalInfo, terminalSessionOf } from '../daemon/terminalShells'
import type { LocalDaemonHook } from '../sessions/MainSessionManager'
import { pickColdTabs, readTabRecords, type AgentTabRecord } from './coldRestore'
import { lowerPriority } from '../resources/hostProcs'
import type { AccountsFeature } from '../usage/accounts'
import type { ManagedFeature } from '../managed/feature'
import { remoteAgentSettings, remoteBaseName } from '@shared/runOn'
import { accountErrorText, remoteHookLaunch } from '@shared/managedServers'
import { GEMINI_DEFAULTS_ENV, orielGeminiDefaults, orielLaunch } from '@shared/oriel'
import type { Oriel } from '../oriel/oriel'
import { createAgentAwake } from './awake'
import { deriveGeneratedTabTitle } from '@shared/agentTabTitle'
import { promptBytes } from './status'
import { renderScreen } from '../sessions/screenText'
import { ASK_MAX_GROUPS, ASK_MAX_TEXT, ASK_STEP_MS, type AskAnswerKeyGroup } from '@shared/agentAsk'

export function registerAgentsFeature(deps: {
  userData: string
  /** M9 AI-10 — 에이전트 탭 Claude 의 statusLine 입력(JSON)과 탭 id. 사용량 서비스가 rate_limits·context_window(M13)만 읽는다. */
  onClaudeStatusLine?: (payload: Record<string, unknown>, pane: string) => void
  /** M13 통계 — 탭이 '일하는 중'으로 들어가고 나올 때. */
  onAgentWorking?: (sessionId: string, working: boolean) => void
  /** 3차 R2-B 브랜치 자동 개명 — 로컬 에이전트 탭에 지시가 들어올 때(실행 지시·훅 UserPromptSubmit). cwd = 그 탭의 폴더. */
  onPrompt?: (cwd: string, prompt: unknown) => void
  /** M13 계정 — Claude·Codex 계정의 실행 env(CLAUDE_CONFIG_DIR·CODEX_HOME). 시스템 기본이면 빈 객체. 로컬 실행에만. R0: 실행 옵션 account 로 고른 계정 대신 다른 계정. */
  accounts?: () => Pick<AccountsFeature, 'launchEnv' | 'view'>
  sessions: () => MainSessionManager
  /** 옛 설정 [AI] 의 터미널 AI 기본 플래그(workspace.json ui.aiCliFlags) — 처음 한 번 옮긴다. */
  readAiCliFlags: () => unknown
  /** 훅을 심을 홈(`~/.claude`·`~/.gemini`·`~/.ara/agent-hooks`). e2e 는 임시 폴더 — 사용자 설정을 시험 부산물로 바꾸지 않는다. */
  home: string
  mainWc: () => WebContents | null
  /** M8 DM-05 원격 실행(관리형 서버 기능 — 뒤에 서므로 부를 때 찾는다). */
  remote?: () => Pick<ManagedFeature, 'launch' | 'reconnect' | 'savedTabs' | 'kill' | 'attachOne' | 'forget' | 'meta' | 'read' | 'takeRebooted'> | null
  /** M9 R2 에이전트 웹 도구 — 로컬 실행에 Oriel 전용 MCP·지시를 붙인다(원격 실행은 안 붙임 — 서버에서 내 PC 의 Oriel 에 닿지 않는다). */
  oriel?: Pick<Oriel, 'status'>
}): { stop(): Promise<void>; views(): AgentStatusView[]; limits(): AgentLimits; orielPath(): string; orielFeedUrl(): string; terminalDaemon: LocalDaemonHook; tabs(): { sessionId: string; agent: AgentId; cwd: string }[]; answer(sessionId: string, groups: AskAnswerKeyGroup[]): { ok: boolean }; followUp(sessionId: string, text: string): { ok: boolean }; screen(sessionId: string): Promise<string>; remoteHook(sessionId: string, source: string, payload: Record<string, unknown>): void } {
  const file = join(deps.userData, 'agents.json')
  cleanupTemp(file)
  let settings = agentSettingsOf(readJsonWithBackup<unknown>(file, null))
  const save = (next: AgentSettings): AgentSettings => {
    settings = agentSettingsOf(next)
    writeJsonAtomic(file, settings)
    return settings
  }
  if (!settings.migratedAiCliFlags) save(migrateAiCliFlags(settings, deps.readAiCliFlags()))

  // 상태 원장·훅 서버는 첫 실행 때 만든다(성능 원칙 — AI 작업 공간을 안 쓰면 포트도 헤드리스 xterm 도 없다).
  let tracker: AgentStatusTracker | null = null
  // M4: 훅 포트·토큰을 기억한다 — 데몬에 산 에이전트는 띄울 때의 포트로 훅을 보낸다(재시작 뒤에도 같은 자리에서 받게).
  const hookFile = join(deps.userData, 'agent-hooks.json')
  const savedHook = readJsonWithBackup<{ port?: unknown; token?: unknown } | null>(hookFile, null)
  // M5 AI-13: 채팅으로 보기 — transcript 감시(열린 채팅 화면만). 첫 훅·첫 열기 때 만든다.
  let chat: ChatWatcher | null = null
  // e2e 는 사용자 설정 폴더(CLAUDE_CONFIG_DIR·CODEX_HOME)를 보지 않는다 — 임시 홈만.
  const userEnv: NodeJS.ProcessEnv = process.env['ARA_E2E'] === '1' ? {} : process.env
  const ensureChat = (): ChatWatcher =>
    (chat ??= createChatWatcher({ push: (e) => pushSend(deps.mainWc(), 'agents:chat', e), store: join(deps.userData, 'agent-chat.json'), home: deps.home, env: userEnv }))
  // 3차 R4 원격 탭 채팅 보기 — 서버 transcript 를 그 세션의 orcad 연결로 읽는다(remoteChat.ts). 첫 원격 탭 때 만든다.
  let rchat: RemoteChat | null = null
  const ensureRemoteChat = (): RemoteChat =>
    (rchat ??= createRemoteChat({
      read: (id, path, offset) => deps.remote?.()?.read(id, path, offset) ?? Promise.reject(new Error('remote off')),
      push: (e) => pushSend(deps.mainWc(), 'agents:chat', e),
      log: (m) => logMainError('remote chat', new Error(m))
    }))

  // M5 AI-19 채팅 이름 — 탭마다 첫 요청 한 번. 이름은 userData/agent-names.json(데몬에 산 탭은 다시 켜도 그대로), 탭이 끝나면 지운다.
  const namesFile = join(deps.userData, 'agent-names.json')
  const savedNames = readJsonWithBackup<unknown>(namesFile, null)
  const names = new Map<string, string>(savedNames && typeof savedNames === 'object' ? Object.entries(savedNames).filter((x): x is [string, string] => typeof x[1] === 'string') : [])
  const naming = new Set<string>()
  const tabMeta = new Map<string, { agent: AgentId; cwd: string }>()
  // R4 원격 탭(이름·제목 짓기만 — Slack 탭 목록 등 tabMeta 를 쓰는 곳엔 안 들어간다). cwd 는 이 PC 의 홈: 이름 짓기는 로컬 CLI 로 하고, 원격 폴더는 이 PC 에 없다.
  const remoteMeta = new Map<string, { agent: AgentId; cwd: string }>()
  const metaOf = (id: string): { agent: AgentId; cwd: string } | undefined => tabMeta.get(id) ?? remoteMeta.get(id)
  const saveNames = (): void => {
    try {
      writeJsonAtomic(namesFile, Object.fromEntries(names))
    } catch {
      /* 못 남기면 다시 켠 뒤 이름 없이 */
    }
  }
  const maybeName = (sessionId: string, firstPrompt: unknown): void => {
    const meta = metaOf(sessionId)
    if (!settings.chatNaming || !meta || typeof firstPrompt !== 'string' || !firstPrompt.trim() || names.has(sessionId) || naming.has(sessionId)) return
    naming.add(sessionId) // 한 탭에 한 번(실패해도 다시 묻지 않는다 — Orca 도 첫 요청만)
    void generateChatName({ agent: meta.agent, settings, cwd: meta.cwd, firstPrompt }).then((name) => {
      if (!name || !metaOf(sessionId)) return
      names.set(sessionId, name)
      saveNames()
      deps.remote?.()?.meta(sessionId, { name })
      pushSend(deps.mainWc(), 'agents:name', { sessionId, name })
    })
  }
  // M11 탭 제목(Orca deriveGeneratedTabTitle) — 첫 지시(실행 지시·훅의 첫 요청·채팅 입력)로 한 번. 데몬에 산 탭은 다시 켜도 그대로(agent-titles.json).
  const titlesFile = join(deps.userData, 'agent-titles.json')
  const savedTitles = readJsonWithBackup<unknown>(titlesFile, null)
  const genTitles = new Map<string, string>(savedTitles && typeof savedTitles === 'object' ? Object.entries(savedTitles).filter((x): x is [string, string] => typeof x[1] === 'string') : [])
  const saveTitles = (): void => {
    try {
      writeJsonAtomic(titlesFile, Object.fromEntries(genTitles))
    } catch {
      /* 못 남기면 다시 켠 뒤 생성 제목 없이 */
    }
  }
  const noteFirstPrompt = (sessionId: string, prompt: unknown): void => {
    if (genTitles.has(sessionId) || !metaOf(sessionId) || typeof prompt !== 'string' || prompt.startsWith('/')) return
    const title = deriveGeneratedTabTitle(prompt)
    if (!title) return
    genTitles.set(sessionId, title)
    saveTitles()
    // R1 원격 탭이면 서버에도(다른 PC 의 세션 목록·탭 제목). 로컬 탭이면 아무 일 없다.
    deps.remote?.()?.meta(sessionId, { genTitle: title })
    pushSend(deps.mainWc(), 'agents:title', { sessionId, title })
  }
  // M11 깨어있기(Orca AgentAwakeService) — 상태 원장 push 를 따라 '일하는 중' 탭을 센다. 설정이 끔이면 아무것도 안 막는다.
  const awake = createAgentAwake({ blocker: powerSaveBlocker, powerMonitor, log: (m) => logMainError('agent awake', new Error(m)) })
  awake.setMode(settings.awakeMode)
  // M11 R2 콜드 복원 — 띄운 로컬 에이전트 탭 기록(coldRestore.ts). 끝나면 지운다(앱 종료의 detach 는 끝이 아니라 남는다).
  const tabsFile = join(deps.userData, 'agent-tabs.json')
  const tabRecords = readTabRecords(readJsonWithBackup<unknown>(tabsFile, null))
  const saveTabRecords = (): void => {
    try {
      writeJsonAtomic(tabsFile, Object.fromEntries(tabRecords))
    } catch {
      /* 못 남기면 그 탭은 데몬째 죽었을 때 못 되살린다 */
    }
  }
  const forgetTab = (id: string): void => {
    if (tabRecords.delete(id)) saveTabRecords()
    chat?.forget(id)
    tabMeta.delete(id)
    remoteMeta.delete(id)
    rchat?.forget(id)
    awake.forget(id)
    if (names.delete(id)) saveNames()
    if (genTitles.delete(id)) saveTitles()
  }

  const hooks = createHookServer(
    (e) => {
      tracker?.hook(e)
      ensureChat().hook(e.paneKey, e.payload, e.source)
      ingestAiWrite(e.payload) // M12 R3 RV-03 AI 작성 줄(쓰기 도구의 끝만)
      // Claude UserPromptSubmit·Gemini BeforeAgent 의 prompt = 사람이 친 첫 요청(터미널에서 친 것도).
      maybeName(e.paneKey, e.payload['prompt'])
      noteFirstPrompt(e.paneKey, e.payload['prompt'])
      const meta = tabMeta.get(e.paneKey)
      if (meta) deps.onPrompt?.(meta.cwd, e.payload['prompt'])
    },
    typeof savedHook?.port === 'number' && typeof savedHook.token === 'string' ? { port: savedHook.port, token: savedHook.token } : null,
    (payload, pane) => deps.onClaudeStatusLine?.(payload, pane)
  )
  const ensureHooks = async (): Promise<{ port: number; token: string }> => {
    const r = await hooks.ensure()
    if (r.port > 0 && (savedHook?.port !== r.port || savedHook?.token !== r.token)) {
      try {
        writeJsonAtomic(hookFile, r)
      } catch {
        /* 못 남기면 다음 재시작 때 그 에이전트들의 훅만 못 받는다 */
      }
    }
    return r
  }
  const installed = new Set<HookSource>()
  let orielWarned = false
  const ensureTracker = (): AgentStatusTracker => {
    if (tracker) return tracker
    const t = createAgentStatusTracker({
      push: (v) => {
        pushSend(deps.mainWc(), 'agents:status', v)
        awake.observe(v.sessionId, v.state === 'working')
        deps.onAgentWorking?.(v.sessionId, v.state === 'working')
      },
      write: (id, data) => deps.sessions().write(id, data)
    })
    // 탭이 끝나면 기억한 transcript 경로도 지운다(앱 종료의 detach 는 exit 가 아니라 남는다 — 다시 켜면 바로 연다).
    deps.sessions().setTap({ ...t, exit: (id) => (t.exit(id), forgetTab(id)) })
    tracker = t
    return t
  }

  // ── M4 데몬 ──
  const daemonLog = (): string => join(dirname(mainErrorLogPath()), 'agent-daemon.log')
  const log = (m: string): void => {
    try {
      appendFileSync(daemonLog(), `${new Date().toISOString()} [app ${process.pid}] ${m}\n`)
    } catch {
      /* 무시 */
    }
  }
  const restoredTabs: AgentTabInfo[] = []
  const tabOf = (info: DaemonSessionInfo): AgentTabInfo | null => {
    const m = info.meta
    if (!isAgentId(m['agent']) || typeof m['title'] !== 'string') return null
    // R1 다른 PC 가 지은 이름·제목은 서버 meta 에서.
    const name = names.get(info.id) ?? (typeof m['name'] === 'string' ? m['name'] : undefined)
    const genTitle = genTitles.get(info.id) ?? (typeof m['genTitle'] === 'string' ? m['genTitle'] : undefined)
    return { sessionId: info.id, agent: m['agent'], cwd: info.cwd, title: m['title'], line: typeof m['line'] === 'string' ? m['line'] : '', ...(typeof m['prompt'] === 'string' ? { prompt: m['prompt'] } : {}), ...(name ? { name } : {}), ...(typeof m['host'] === 'string' ? { host: m['host'] } : {}), ...(genTitle ? { genTitle } : {}), ...(info.account !== undefined ? { account: info.account } : {}) }
  }
  const daemon = createAgentDaemon({
    runtimeDir: daemonRuntimeDir(deps.userData),
    logFile: daemonLog,
    appVersion: app.getVersion(),
    // e2e 는 앱이 꺼질 때 데몬도 함께 내린다(가짜 에이전트를 사용자 PC 에 남기지 않게). 데몬 생존을 보는 시험만 ARA_E2E_KEEP_DAEMON=1.
    exitWithClients: process.env['ARA_E2E'] === '1' && process.env['ARA_E2E_KEEP_DAEMON'] !== '1',
    runtime: async () => {
      const inst = installRuntime(app.getAppPath(), process.execPath)
      if (process.platform !== 'win32' || !app.isPackaged) return inst
      // NSIS 제거 훅(resources/installer.nsh)이 같은 자리를 지운다 — 바꾸면 거기도.
      const local = process.env['LOCALAPPDATA'] || join(app.getPath('home'), 'AppData', 'Local')
      return (await relocatedRuntime({ hostRoot: join(local, 'ARA', 'daemon-host'), version: app.getVersion(), execPath: process.execPath, resourcesPath: process.resourcesPath, log })) ?? inst
    },
    adopt: (backend, info) => {
      // M11 R2 터미널 공간 셸(terminalShells.ts) — 에이전트 탭이 아니다.
      if (isTerminalInfo(info)) return void deps.sessions().adopt(backend, terminalSessionOf(info), info.id)
      const tab = tabOf(info)
      deps.sessions().adopt(backend, { type: 'local', title: tab?.title ?? 'agent', serverKey: 'localhost', cwd: info.cwd, profileId: null, space: 'ai', cols: info.cols, rows: info.rows }, info.id)
    },
    restored: (info) => {
      const tab = tabOf(info)
      if (!tab) return
      restoredTabs.push(tab)
      ensureTracker().track({ sessionId: info.id, agent: tab.agent, cols: info.cols, rows: info.rows })
      ensureChat().bind(info.id, { agent: tab.agent, cwd: info.cwd, startedAt: typeof info.meta['startedAt'] === 'number' ? info.meta['startedAt'] : 0 })
      tabMeta.set(info.id, { agent: tab.agent, cwd: info.cwd })
      void ensureHooks()
    },
    log,
    isTerminal: isTerminalInfo,
    // M4 R3 자원 상한 — 적용은 데몬이(우선순위·메모리 표본). 넘으면 알림 센터로만 — 끄는 것은 사람이(자원 관리자·탭의 [종료]).
    limits: () => agentLimitsOf(settings),
    memoryOver: (e) => {
      const title = deps.sessions().ptyList().find((p) => p.id === e.id)?.title ?? ''
      log(`memory over ${e.id} ${e.memory} > ${e.limit}`)
      pushSend(deps.mainWc(), 'agents:memoryOver', { sessionId: e.id, title, memory: e.memory, limit: e.limit })
    }
  })

  // M11 R2: 터미널 셸이 데몬에 살므로 켤 때 미리 띄운다(첫 셸이 데몬 띄우기를 기다리지 않게 — Orca 도 켤 때 띄운다).
  void daemon.warm()
  const terminalDaemon = createTerminalDaemonHook(daemon, log)

  /**
   * M11 R2 콜드 복원: 데몬째 죽었던 탭(또는 앱 안 PTY 탭)을 한 번만 내준다 — 렌더러가 같은 에이전트·같은 폴더로 다시 띄운다(resume 이 있으면 재개).
   * 내준 기록은 지운다(다시 띄운 탭은 새 기록을 남긴다). 원격 탭은 기록하지 않는다(M8 R4 '끊김' 규칙 그대로).
   */
  let coldHanded = false
  const coldTabs = (): AgentTabInfo[] => {
    if (coldHanded) return []
    coldHanded = true
    const { cold, drop } = pickColdTabs(tabRecords, (id) => deps.sessions().has(id), daemon.found())
    const out = cold.map(([id, r]): AgentTabInfo => {
      ensureChat().bind(id, { agent: r.agent, cwd: r.cwd, startedAt: r.startedAt })
      const resume = ensureChat().resumeId(id)
      const name = names.get(id)
      const genTitle = genTitles.get(id)
      return { sessionId: id, agent: r.agent, cwd: r.cwd, title: r.title, line: r.line, cold: true, ...(resume ? { resume } : {}), ...(name ? { name } : {}), ...(genTitle ? { genTitle } : {}) }
    })
    for (const id of [...drop, ...cold.map((x) => x[0])]) forgetTab(id)
    if (cold.length || drop.length) log(`cold restore: ${cold.length} tab(s) to resume, ${drop.length} ended while closed`)
    return out
  }

  const detector = createAgentDetector()
  handle('agents:detect', ({ force }) => detector.detect(force === true))
  handle('agents:getSettings', () => settings)
  handle('agents:setSettings', ({ settings: next }) => {
    const before = agentLimitsOf(settings)
    models.clear() // 명령 바꾸기·env 가 바뀌었을 수 있다 — 모델 목록은 다음에 다시 묻는다
    const saved = save(next)
    const after = agentLimitsOf(saved)
    if (before.lowPriority !== after.lowPriority || before.memoryBytes !== after.memoryBytes) daemon.setLimits(after)
    awake.setMode(saved.awakeMode)
    return saved
  })
  handle('agents:statuses', () => tracker?.views() ?? [])
  // AI-15 모델 목록 — 설치된 CLI 에 처음 한 번 묻고 기억(같이 부르면 한 번만). 실패는 기억하지 않는다(다음에 다시).
  const models = new Map<AgentId, Promise<ModelCatalog>>()
  handle('agents:models', ({ agent, force }) => {
    if (!isAgentId(agent)) return { error: 'unknown agent' }
    if (force === true) models.delete(agent)
    let p = models.get(agent)
    if (!p) {
      p = listModels(agent, settings).then((c) => {
        if ('error' in c) models.delete(agent)
        return c
      })
      models.set(agent, p)
    }
    return p
  })
  handle('agents:slash', ({ agent, cwd }) => (isAgentId(agent) && typeof cwd === 'string' ? scanSlash(agent, cwd, deps.home, userEnv) : []))
  handle('agents:tabs', async () => {
    await daemon.ready
    // M8 R4 원격 탭은 저장해 둔 목록에서 '끊김'으로(서버에 묻지 않는다 — 자동 재접속 없음, 사람이 [다시 연결]).
    const cut = (deps.remote?.()?.savedTabs() ?? []).filter((info) => !deps.sessions().has(info.id)).flatMap((info) => {
      const tab = tabOf(info)
      return tab?.host ? [{ ...tab, cut: true as const }] : []
    })
    return [...restoredTabs.filter((t) => deps.sessions().has(t.sessionId)), ...cut, ...coldTabs()]
  })
  handle('agents:chatOpen', ({ sessionId }) => (rchat?.has(sessionId) ? rchat.open(sessionId) : ensureChat().open(sessionId)))
  handle('agents:chatClose', ({ sessionId }) => {
    chat?.close(sessionId)
    rchat?.close(sessionId)
  })
  // 채팅 입력 → PTY. 첫 지시와 같은 길(status.ts submit — 입력 상자가 뜬 뒤 괄호 붙여넣기 → 길이만큼 기다려 Enter).
  // 바로 쓰면 에이전트가 뜨기 전 셸(PowerShell PSReadLine 의 미리 읽기)이 글을 먹는다 — e2e CHAT-1 실패의 원인.
  handle('agents:chatSend', ({ sessionId, agent, text }) => {
    if (!isAgentId(agent) || typeof text !== 'string' || !text.trim() || !deps.sessions().has(sessionId)) return { ok: false }
    const ok = ensureTracker().submit(sessionId, text)
    if (ok && !text.startsWith('/')) maybeName(sessionId, text)
    if (ok) noteFirstPrompt(sessionId, text)
    return { ok }
  })
  // M11 질문/승인 카드의 답(Orca sendNativeChatAskAnswer) — 키 묶음을 ASK_STEP_MS 간격으로 그대로, 글은 붙여넣기 바이트로. 그 탭이 끝나면 멈춘다.
  const answer = (sessionId: string, groups: AskAnswerKeyGroup[]): { ok: boolean } => {
    const meta = tabMeta.get(sessionId)
    const steps = (Array.isArray(groups) ? groups : []).slice(0, ASK_MAX_GROUPS).flatMap((g: AskAnswerKeyGroup): string[] => {
      if (g && typeof g === 'object' && 'raw' in g && typeof g.raw === 'string' && g.raw.length <= 8) return [g.raw]
      if (g && typeof g === 'object' && 'text' in g && typeof g.text === 'string' && g.text.length <= ASK_MAX_TEXT) return [promptBytes(meta?.agent ?? 'claude', g.text, process.platform === 'win32')]
      return []
    })
    if (!steps.length || !deps.sessions().has(sessionId)) return { ok: false }
    steps.forEach((data, i) =>
      setTimeout(() => {
        if (deps.sessions().has(sessionId)) deps.sessions().write(sessionId, data)
      }, i * ASK_STEP_MS)
    )
    return { ok: true }
  }
  handle('agents:answer', ({ sessionId, groups }) => answer(sessionId, groups))
  // M10 WS-16 재우기 — 닫기 전에 탭마다 CLI 세션 id 를 받아 둔다(닫으면 transcript 경로를 잊는다).
  // R3 원격 탭은 서버 훅이 알려 준 CLI 세션 id(로컬 transcript 가 없다).
  handle('agents:resumeIds', ({ sessionIds }) =>
    Object.fromEntries((Array.isArray(sessionIds) ? sessionIds : []).filter((id): id is string => typeof id === 'string').map((id) => [id, remoteResume.get(id) ?? ensureChat().resumeId(id)]))
  )
  handle('agents:killBackground', async () => ({ killed: await daemon.killAll() }))
  handle('agents:quitCompletely', async () => {
    // 완전 종료 = 다시 켜도 되살리지 않는다(사람이 끝냈다).
    tabRecords.clear()
    saveTabRecords()
    await daemon.shutdownAll()
    app.quit()
  })
  // ── M8 DM-05 원격(관리형 서버) ── 원격 탭은 훅 서버(127.0.0.1)에 닿지 않는다. 3차 R2: 훅은 서버의 orcad 가 받아(orcad.py hook) status 사건으로
  // 보낸다 → remoteHook 이 로컬 훅과 같은 tracker 로. 옛 orcad(hookDir 없음)·Codex 는 화면 판정('추정')만. R4: 채팅 보기는 서버
  // transcript 를 orcad read 로(remoteChat.ts), 탭 제목·채팅 이름은 서버 훅의 prompt 로(이름 짓기 CLI 는 이 PC 에서). 명령줄은 POSIX 셸 기준(원격 로그인 셸)으로 만든다.
  /** R2 서버 orcad 가 들은 훅(status 사건) — 로컬 훅과 같은 상태 파이프라인(질문·승인 카드·알림 규칙 그대로). */
  // R3: 서버 훅의 session_id = 다른 계정으로 이어서(--resume) 할 id · StopFailure rate_limit = 한도 걸림(다음 지시면 풀림). 자식 이벤트는 안 본다.
  const remoteResume = new Map<string, string>()
  const remoteLimit = new Set<string>()
  const remoteHook = (sessionId: string, source: string, payload: Record<string, unknown>): void => {
    if (!isHookSource(source)) return
    tracker?.hook({ source, paneKey: sessionId, payload })
    if (payload['agent_id']) return
    // R4 채팅 보기(transcript_path)·탭 제목·채팅 이름(prompt) — 로컬 훅과 같은 규칙.
    rchat?.hook(sessionId, payload)
    maybeName(sessionId, payload['prompt'])
    noteFirstPrompt(sessionId, payload['prompt'])
    const sid = payload['session_id']
    if (typeof sid === 'string' && sid) remoteResume.set(sessionId, sid)
    const ev = payload['hook_event_name']
    const hit = ev === 'StopFailure' && payload['error'] === 'rate_limit' ? true : ev === 'UserPromptSubmit' ? false : null
    if (hit === null || hit === remoteLimit.has(sessionId)) return
    if (hit) remoteLimit.add(sessionId)
    else remoteLimit.delete(sessionId)
    pushSend(deps.mainWc(), 'agents:remoteLimit', { sessionId, hit })
  }
  /** R4 원격 탭 표시 — 채팅 보기(서버 transcript)·이름 짓기 대상. 첫 지시 전에 건다(훅이 곧 온다). */
  const remoteTab = (id: string, agent: AgentId): void => {
    ensureRemoteChat().bind(id, agent)
    remoteMeta.set(id, { agent, cwd: deps.home })
  }
  const launchRemote = async (host: string, agent: AgentId, cwd: string, prompt: string | undefined, resume: string | undefined, options: unknown): Promise<AgentLaunchResult> => {
    const remote = deps.remote?.()
    if (!remote) return { ok: false, error: '원격 실행을 쓸 수 없습니다.' }
    const planOf = (hookDir: string | null): ReturnType<typeof planAgentLaunch> =>
      planAgentLaunch({ agent, settings: remoteAgentSettings(settings, agent), prompt, shell: 'posix', resume, options: launchOptionsOf(options), ...remoteHookLaunch(agent, hookDir) })
    const checked = planOf(null)
    if (!checked.ok) return checked
    let plan = checked
    const title = `${AGENTS[agent].label} · ${remoteBaseName(cwd)}`
    const sessionId = randomUUID()
    const t = ensureTracker() // tap 을 세션보다 먼저 건다 - 로컬 실행과 같은 순서
    // R3 서버 계정(Claude·Codex): 옵션 account 를 안 주면 서버의 기본 계정, null = 서버 본래 로그인. 실제로 쓴 계정은 서버가 알려 준다.
    const wanted = accountOptionOf(options)
    const account = agent === 'claude' || agent === 'codex' ? { agent, ...(wanted !== undefined ? { id: wanted } : {}) } : undefined
    let used: string | null | undefined
    try {
      // env 는 에이전트 env 만(원격 환경 위에 덧붙는다 — 아라의 Windows 환경을 보내지 않는다). R2 훅 설정은 그 서버 orcad 가 훅 폴더를 알려 줄 때만.
      const info = await remote.launch(host, (hookDir) => {
        const p = planOf(hookDir)
        if (p.ok) plan = p
        return { id: sessionId, cwd, env: plan.env, meta: { agent, title, line: plan.line, startedAt: Date.now(), host, pc: hostname() }, ...(account ? { account } : {}) }
      })
      used = account ? (info.account ?? null) : undefined
    } catch (err) {
      return { ok: false, error: accountErrorText(err instanceof Error ? err.message : String(err)) }
    }
    t.track({ sessionId, agent, prompt: plan.deferredPrompt })
    remoteTab(sessionId, agent)
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line, ...(used !== undefined ? { account: used } : {}) }
  }
  // 원격 세션을 탭으로(다시 연결 · R1 서버 세션에 붙기 공통) — 상태 판정을 붙이고 탭 정보로.
  const remoteTabs = async (job: () => Promise<DaemonSessionInfo[]>): Promise<{ ok: true; tabs: AgentTabInfo[] } | { ok: false; error: string }> => {
    try {
      const infos = await job()
      const tabs: AgentTabInfo[] = []
      for (const info of infos) {
        const tab = tabOf(info)
        if (!tab) continue
        ensureTracker().track({ sessionId: info.id, agent: tab.agent, cols: info.cols, rows: info.rows })
        remoteTab(info.id, tab.agent)
        // R2 서버 대장의 마지막 상태(늦게 붙은 PC) — attach 사건이 track 보다 먼저 올 수 있어 목록 값으로 한 번 더.
        if (info.status) remoteHook(info.id, info.status.source, info.status.payload)
        tabs.push(tab)
      }
      return { ok: true, tabs }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  handle('agents:reconnect', async ({ hostKey }) => {
    const remote = deps.remote?.()
    if (!remote || typeof hostKey !== 'string') return { ok: false, error: '원격 실행을 쓸 수 없습니다.' }
    const r = await remoteTabs(() => remote.reconnect(hostKey))
    // R5 재부팅으로 잃은 탭(서버 부팅 id 가 바뀜) — 렌더러가 '재부팅으로 끝남'으로 표시한다.
    return r.ok ? { ...r, rebooted: remote.takeRebooted(hostKey) } : r
  })
  handle('agents:attachRemote', async ({ hostKey, sessionId }) => {
    const remote = deps.remote?.()
    if (!remote || typeof hostKey !== 'string' || typeof sessionId !== 'string') return { ok: false, error: '원격 실행을 쓸 수 없습니다.' }
    return remoteTabs(() => remote.attachOne(hostKey, sessionId))
  })
  handle('agents:forgetRemote', ({ sessionId }) => {
    if (typeof sessionId === 'string') deps.remote?.()?.forget(sessionId)
  })

  handle('agents:killRemote', async ({ hostKey, sessionId }) => {
    const remote = deps.remote?.()
    if (!remote || typeof hostKey !== 'string' || typeof sessionId !== 'string') return false
    return remote.kill(hostKey, sessionId)
  })

  handle('agents:launch', async ({ agent, cwd, prompt, resume, options, host }): Promise<AgentLaunchResult> => {
    if (!isAgentId(agent)) return { ok: false, error: '모르는 에이전트' }
    if (typeof host === 'string' && host) {
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) return { ok: false, error: `원격 폴더가 아닙니다: ${cwd}` }
      return launchRemote(host, agent, cwd, typeof prompt === 'string' ? prompt : undefined, typeof resume === 'string' && resume ? resume : undefined, options)
    }
    try {
      if (typeof cwd !== 'string' || !statSync(cwd).isDirectory()) return { ok: false, error: `폴더가 아닙니다: ${cwd}` }
    } catch {
      return { ok: false, error: `폴더가 없습니다: ${cwd}` }
    }
    const shell = defaultLaunchShell()
    // 훅: 서버를 열고(처음 한 번) 그 CLI 의 훅 스크립트를 쓴다(처음 한 번). 실패해도 실행은 한다 — 그 탭은 화면 판정('추정')만.
    // M9 R3: 훅 줄은 이 실행에만(Claude --settings · Gemini 시스템 기본값 파일) — 사용자 settings.json 은 안 건드린다.
    const hookEnv: Record<string, string> = {}
    const extraArgs: string[] = []
    // M13 고른 계정(Orca: 계정 폴더 env) — 사용자 설정의 CLAUDE_CONFIG_DIR·CODEX_HOME 보다 앞선다(시스템 기본을 고르면 안 붙는다).
    // R0 다른 계정으로 이어서: 옵션 account(null = 시스템 기본)가 오면 그 계정. Codex 재개면 그 rollout 을 대상 폴더로 복사해 둔다(accounts.ts).
    const acc = agent === 'claude' || agent === 'codex' ? deps.accounts?.() : undefined
    const wanted = accountOptionOf(options)
    if (acc && typeof wanted === 'string' && !acc.view()[agent as 'claude' | 'codex'].list.some((a) => a.id === wanted)) return { ok: false, error: '없는 계정입니다' }
    const account = acc ? (wanted === undefined ? acc.view()[agent as 'claude' | 'codex'].active : wanted) : undefined
    const extraEnv: Record<string, string> = acc ? { ...acc.launchEnv(agent as 'claude' | 'codex', account, typeof resume === 'string' && resume ? resume : undefined) } : {}
    // Gemini 시스템 기본값 파일은 env 하나라 훅·Oriel MCP 를 한 파일에 담는다.
    const geminiDefaults: Record<string, unknown> = {}
    if (isHookSource(agent)) {
      const { port, token } = await ensureHooks()
      if (!installed.has(agent)) {
        const r = installHooks(deps.home, agent)
        if (r.ok) installed.add(agent)
        else logMainError(`agent hooks:${agent}`, new Error(r.message))
      }
      if (port > 0 && installed.has(agent)) Object.assign(hookEnv, { [HOOK_ENV.port]: String(port), [HOOK_ENV.token]: token })
      // 상태 훅(R3)·statusLine(R2, 사용량 실시간)은 이 claude 에만 --settings 로. 사용자 원래 훅·상태줄은 그대로.
      if (hookEnv[HOOK_ENV.port]) {
        try {
          if (agent === 'claude') {
            const configDir = extraEnv['CLAUDE_CONFIG_DIR'] || settings.agents.claude.env['CLAUDE_CONFIG_DIR'] || userEnv['CLAUDE_CONFIG_DIR'] || join(deps.home, '.claude')
            extraArgs.push(...claudeLaunchArgs(deps.home, cwd, configDir))
          } else Object.assign(geminiDefaults, geminiLaunchDefaults(deps.home))
        } catch (e) {
          logMainError('agent hooks launch', e)
        }
      }
    }
    // M9 R2 Oriel — 이 실행에만 Oriel 전용 MCP·지시(사용자 MCP 설정 파일은 안 씀). 없으면 그대로 띄우고 앱 실행 중 처음 한 번 알린다.
    let noOriel = false
    const os = await deps.oriel?.status()
    if (os?.installed) {
      try {
        // 브라우저에 "어느 세션의 어느 AI 인가"를 보인다(Oriel 0.1.3 ORIEL_AGENT_LABEL — 옛 Oriel 은 모르는 env 라 무시).
        // 작은따옴표는 Codex -c 값에서 막히므로(orielLaunch 가 Oriel 을 통째로 뺀다) 바꿔 둔다.
        const label = `아라 · ${AGENTS[agent].label} · ${basename(cwd) || cwd}`.replace(/'/g, '’')
        const runner = { ...os.runner, env: { ...os.runner.env, ORIEL_AGENT_LABEL: label } }
        if (agent === 'gemini') Object.assign(geminiDefaults, orielGeminiDefaults(os.info.cliPath, runner))
        else {
          const o = orielLaunch(agent, os.info.cliPath, (name, ext, body) => writeLaunchFile(deps.home, name, ext, body), runner)
          extraArgs.push(...o.args)
          Object.assign(extraEnv, o.env)
        }
      } catch (e) {
        logMainError('agent oriel', e)
      }
    } else if (os && !orielWarned) {
      orielWarned = true
      noOriel = true
    }
    if (Object.keys(geminiDefaults).length) {
      try {
        extraEnv[GEMINI_DEFAULTS_ENV] = writeLaunchFile(deps.home, 'gemini-defaults', 'json', JSON.stringify(geminiDefaults, null, 2))
      } catch (e) {
        logMainError('agent gemini defaults', e)
      }
    }
    const plan = planAgentLaunch({ agent, settings, prompt: typeof prompt === 'string' ? prompt : undefined, shell, resume: typeof resume === 'string' && resume ? resume : undefined, options: launchOptionsOf(options), extraArgs, extraEnv })
    if (!plan.ok) return plan
    const t = ensureTracker()
    const title = `${AGENTS[agent].label} · ${basename(cwd) || cwd}`
    const env = { ...plan.env, ...hookEnv }
    let sessionId: string = randomUUID()
    const startedAt = Date.now()
    let local = false
    try {
      // 데몬 셸은 앱의 **지금** 환경을 받는다(데몬 환경은 띄운 순간에 굳는다 — 감지가 더한 PATH 등을 놓친다).
      const appEnv = Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => typeof x[1] === 'string' && x[0] !== 'ELECTRON_RUN_AS_NODE'))
      const meta = { agent, title, line: plan.line, startedAt, ...(plan.deferredPrompt ? { prompt: plan.deferredPrompt } : {}) }
      await daemon.create({ id: sessionId, cwd, env: withAraCliPath({ ...appEnv, ...env }), meta })
    } catch (err) {
      log(`daemon create failed — local PTY fallback: ${String(err)}`)
      logMainError('agent daemon', err)
      sessionId = await deps.sessions().create({ type: 'local', title, serverKey: 'localhost', cwd, profileId: null, space: 'ai', env })
      local = true
      // 로컬 PTY 로 넘어가도 우선순위는 건다(메모리 표본은 데몬에만 있다).
      const pid = deps.sessions().ptyList().find((p) => p.id === sessionId)?.pid
      if (settings.lowPriority && pid) lowerPriority(pid)
    }
    // 헤드리스 화면은 80×24 로 시작해 렌더러 터미널이 붙으며 보내는 resize 를 따라간다(SessionTap.resize).
    t.track({ sessionId, agent, prompt: plan.deferredPrompt })
    ensureChat().bind(sessionId, { agent, cwd, startedAt })
    tabMeta.set(sessionId, { agent, cwd })
    const record: AgentTabRecord = { agent, cwd, title, line: plan.line, startedAt, ...(local ? { local: true as const } : {}) }
    tabRecords.set(sessionId, record)
    saveTabRecords()
    if (typeof prompt === 'string') maybeName(sessionId, prompt)
    noteFirstPrompt(sessionId, prompt)
    deps.onPrompt?.(cwd, prompt)
    // 막 뜬 셸에 바로 친다 — conpty 가 입력을 담아 두고 셸이 읽기 시작하면 받는다(터미널 AI 시작과 같은 순서).
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line, ...(noOriel ? { noOriel: true as const } : {}), ...(account !== undefined ? { account } : {}) }
  })
  return {
    stop: () => {
      daemon.disconnect() // 세션·데몬은 산다 — 다음에 켜면 다시 붙는다
      chat?.stop()
      rchat?.stop()
      awake.dispose()
      return hooks.stop()
    },
    views: () => tracker?.views() ?? [],
    remoteHook,
    limits: () => agentLimitsOf(settings),
    orielPath: () => settings.orielPath,
    orielFeedUrl: () => settings.orielFeedUrl,
    terminalDaemon,
    // M15 Slack(main/integrations) — 탭 목록(띄운 순서)과 카드 답(같은 길).
    tabs: () => [...tabMeta].map(([sessionId, m]) => ({ sessionId, agent: m.agent, cwd: m.cwd })),
    answer,
    // IN-02b Slack 이어 지시(채팅 입력과 같은 M3 안전 입력 — 입력 상자를 본 뒤 붙여넣기 → Enter)·턴 결과(화면 글).
    followUp: (sessionId, text) => ({ ok: typeof text === 'string' && !!text.trim() && deps.sessions().has(sessionId) && ensureTracker().submit(sessionId, text) }),
    screen: async (sessionId) => {
      const s = deps.sessions().snapshot().find((x) => x.id === sessionId)
      return s ? renderScreen(deps.sessions().peek(sessionId), s.cols ?? 80, s.rows ?? 24) : ''
    }
  }
}

/** 렌더러가 보낸 첫 실행 옵션을 다시 거른다(값은 셸 한 줄에 들어간다). */
function launchOptionsOf(v: unknown): { model?: string; effort?: string; permission?: AgentPermissionChoice } {
  const o = (v && typeof v === 'object' ? v : {}) as AgentLaunchOptions
  return {
    ...(isOptionValue(o.model) ? { model: o.model } : {}),
    ...(isOptionValue(o.effort) ? { effort: o.effort } : {}),
    ...(PERMISSION_CHOICES.includes(o.permission as AgentPermissionChoice) ? { permission: o.permission } : {})
  }
}

/** R0 실행 옵션 account — 안 오면 undefined(고른 계정), null = 시스템 기본, 문자열 = 그 계정 id. */
function accountOptionOf(v: unknown): string | null | undefined {
  const a = v && typeof v === 'object' ? (v as AgentLaunchOptions).account : undefined
  return a === null || typeof a === 'string' ? a : undefined
}
