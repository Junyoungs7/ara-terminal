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
import { app, type WebContents } from 'electron'
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
import { generateChatName, listModels, scanSlash } from './options'
import { isOptionValue, type ModelCatalog } from '@shared/agentOptions'
import { createAgentDaemon, daemonRuntimeDir } from '../daemon/service'
import { installRuntime, relocatedRuntime } from '../daemon/launcher'
import type { DaemonSessionInfo } from '../daemon/protocol'
import { lowerPriority } from '../resources/hostProcs'
import type { ManagedFeature } from '../managed/feature'
import { remoteAgentSettings, remoteBaseName } from '@shared/runOn'
import { GEMINI_DEFAULTS_ENV, orielGeminiDefaults, orielLaunch } from '@shared/oriel'
import type { Oriel } from '../oriel/oriel'

export function registerAgentsFeature(deps: {
  userData: string
  /** M9 AI-10 — 에이전트 탭 Claude 의 statusLine 입력(JSON). 사용량 서비스가 rate_limits 만 읽는다. */
  onClaudeStatusLine?: (payload: Record<string, unknown>) => void
  sessions: () => MainSessionManager
  /** 옛 설정 [AI] 의 터미널 AI 기본 플래그(workspace.json ui.aiCliFlags) — 처음 한 번 옮긴다. */
  readAiCliFlags: () => unknown
  /** 훅을 심을 홈(`~/.claude`·`~/.gemini`·`~/.ara/agent-hooks`). e2e 는 임시 폴더 — 사용자 설정을 시험 부산물로 바꾸지 않는다. */
  home: string
  mainWc: () => WebContents | null
  /** M8 DM-05 원격 실행(관리형 서버 기능 — 뒤에 서므로 부를 때 찾는다). */
  remote?: () => Pick<ManagedFeature, 'launch' | 'reconnect' | 'savedTabs' | 'kill'> | null
  /** M9 R2 에이전트 웹 도구 — 로컬 실행에 Oriel 전용 MCP·지시를 붙인다(원격 실행은 안 붙임 — 서버에서 내 PC 의 Oriel 에 닿지 않는다). */
  oriel?: Pick<Oriel, 'status'>
}): { stop(): Promise<void>; views(): AgentStatusView[]; limits(): AgentLimits; orielPath(): string } {
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

  // M5 AI-19 채팅 이름 — 탭마다 첫 요청 한 번. 이름은 userData/agent-names.json(데몬에 산 탭은 다시 켜도 그대로), 탭이 끝나면 지운다.
  const namesFile = join(deps.userData, 'agent-names.json')
  const savedNames = readJsonWithBackup<unknown>(namesFile, null)
  const names = new Map<string, string>(savedNames && typeof savedNames === 'object' ? Object.entries(savedNames).filter((x): x is [string, string] => typeof x[1] === 'string') : [])
  const naming = new Set<string>()
  const tabMeta = new Map<string, { agent: AgentId; cwd: string }>()
  const saveNames = (): void => {
    try {
      writeJsonAtomic(namesFile, Object.fromEntries(names))
    } catch {
      /* 못 남기면 다시 켠 뒤 이름 없이 */
    }
  }
  const maybeName = (sessionId: string, firstPrompt: unknown): void => {
    const meta = tabMeta.get(sessionId)
    if (!settings.chatNaming || !meta || typeof firstPrompt !== 'string' || !firstPrompt.trim() || names.has(sessionId) || naming.has(sessionId)) return
    naming.add(sessionId) // 한 탭에 한 번(실패해도 다시 묻지 않는다 — Orca 도 첫 요청만)
    void generateChatName({ agent: meta.agent, settings, cwd: meta.cwd, firstPrompt }).then((name) => {
      if (!name || !tabMeta.has(sessionId)) return
      names.set(sessionId, name)
      saveNames()
      pushSend(deps.mainWc(), 'agents:name', { sessionId, name })
    })
  }
  const forgetTab = (id: string): void => {
    chat?.forget(id)
    tabMeta.delete(id)
    if (names.delete(id)) saveNames()
  }

  const hooks = createHookServer(
    (e) => {
      tracker?.hook(e)
      ensureChat().hook(e.paneKey, e.payload, e.source)
      // Claude UserPromptSubmit·Gemini BeforeAgent 의 prompt = 사람이 친 첫 요청(터미널에서 친 것도).
      maybeName(e.paneKey, e.payload['prompt'])
    },
    typeof savedHook?.port === 'number' && typeof savedHook.token === 'string' ? { port: savedHook.port, token: savedHook.token } : null,
    (payload) => deps.onClaudeStatusLine?.(payload)
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
      push: (v) => pushSend(deps.mainWc(), 'agents:status', v),
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
    const name = names.get(info.id)
    return { sessionId: info.id, agent: m['agent'], cwd: info.cwd, title: m['title'], line: typeof m['line'] === 'string' ? m['line'] : '', ...(typeof m['prompt'] === 'string' ? { prompt: m['prompt'] } : {}), ...(name ? { name } : {}), ...(typeof m['host'] === 'string' ? { host: m['host'] } : {}) }
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
    // M4 R3 자원 상한 — 적용은 데몬이(우선순위·메모리 표본). 넘으면 알림 센터로만 — 끄는 것은 사람이(자원 관리자·탭의 [종료]).
    limits: () => agentLimitsOf(settings),
    memoryOver: (e) => {
      const title = deps.sessions().ptyList().find((p) => p.id === e.id)?.title ?? ''
      log(`memory over ${e.id} ${e.memory} > ${e.limit}`)
      pushSend(deps.mainWc(), 'agents:memoryOver', { sessionId: e.id, title, memory: e.memory, limit: e.limit })
    }
  })

  const detector = createAgentDetector()
  handle('agents:detect', ({ force }) => detector.detect(force === true))
  handle('agents:getSettings', () => settings)
  handle('agents:setSettings', ({ settings: next }) => {
    const before = agentLimitsOf(settings)
    models.clear() // 명령 바꾸기·env 가 바뀌었을 수 있다 — 모델 목록은 다음에 다시 묻는다
    const saved = save(next)
    const after = agentLimitsOf(saved)
    if (before.lowPriority !== after.lowPriority || before.memoryBytes !== after.memoryBytes) daemon.setLimits(after)
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
    return [...restoredTabs.filter((t) => deps.sessions().has(t.sessionId)), ...cut]
  })
  handle('agents:chatOpen', ({ sessionId }) => ensureChat().open(sessionId))
  handle('agents:chatClose', ({ sessionId }) => chat?.close(sessionId))
  // 채팅 입력 → PTY. 첫 지시와 같은 길(status.ts submit — 입력 상자가 뜬 뒤 괄호 붙여넣기 → 길이만큼 기다려 Enter).
  // 바로 쓰면 에이전트가 뜨기 전 셸(PowerShell PSReadLine 의 미리 읽기)이 글을 먹는다 — e2e CHAT-1 실패의 원인.
  handle('agents:chatSend', ({ sessionId, agent, text }) => {
    if (!isAgentId(agent) || typeof text !== 'string' || !text.trim() || !deps.sessions().has(sessionId)) return { ok: false }
    const ok = ensureTracker().submit(sessionId, text)
    if (ok && !text.startsWith('/')) maybeName(sessionId, text)
    return { ok }
  })
  handle('agents:killBackground', async () => ({ killed: await daemon.killAll() }))
  handle('agents:quitCompletely', async () => {
    await daemon.shutdownAll()
    app.quit()
  })
  // ── M8 DM-05 원격(관리형 서버) ── 원격 탭은 훅 서버(127.0.0.1)에 닿지 않는다 → 상태는 화면 판정('추정')만. 채팅 보기·이름 짓기도
  // 로컬 transcript·로컬 CLI 를 읽으므로 걸지 않는다. 명령줄은 POSIX 셸 기준(원격 로그인 셸)으로 만든다.
  const launchRemote = async (host: string, agent: AgentId, cwd: string, prompt: string | undefined, resume: string | undefined, options: unknown): Promise<AgentLaunchResult> => {
    const remote = deps.remote?.()
    if (!remote) return { ok: false, error: '원격 실행을 쓸 수 없습니다.' }
    const plan = planAgentLaunch({ agent, settings: remoteAgentSettings(settings, agent), prompt, shell: 'posix', resume, options: launchOptionsOf(options) })
    if (!plan.ok) return plan
    const title = `${AGENTS[agent].label} · ${remoteBaseName(cwd)}`
    const sessionId = randomUUID()
    const t = ensureTracker() // tap 을 세션보다 먼저 건다 - 로컬 실행과 같은 순서
    try {
      // env 는 에이전트 env 만(원격 환경 위에 덧붙는다 — 아라의 Windows 환경을 보내지 않는다).
      await remote.launch(host, { id: sessionId, cwd, env: plan.env, meta: { agent, title, line: plan.line, startedAt: Date.now(), host } })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    t.track({ sessionId, agent, prompt: plan.deferredPrompt })
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line }
  }
  handle('agents:reconnect', async ({ hostKey }) => {
    const remote = deps.remote?.()
    if (!remote || typeof hostKey !== 'string') return { ok: false, error: '원격 실행을 쓸 수 없습니다.' }
    try {
      const infos = await remote.reconnect(hostKey)
      const tabs: AgentTabInfo[] = []
      for (const info of infos) {
        const tab = tabOf(info)
        if (!tab) continue
        ensureTracker().track({ sessionId: info.id, agent: tab.agent, cols: info.cols, rows: info.rows })
        tabs.push(tab)
      }
      return { ok: true, tabs }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
    const extraEnv: Record<string, string> = {}
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
            const configDir = settings.agents.claude.env['CLAUDE_CONFIG_DIR'] || userEnv['CLAUDE_CONFIG_DIR'] || join(deps.home, '.claude')
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
        if (agent === 'gemini') Object.assign(geminiDefaults, orielGeminiDefaults(os.info.cliPath))
        else {
          const o = orielLaunch(agent, os.info.cliPath, (name, ext, body) => writeLaunchFile(deps.home, name, ext, body))
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
    try {
      // 데몬 셸은 앱의 **지금** 환경을 받는다(데몬 환경은 띄운 순간에 굳는다 — 감지가 더한 PATH 등을 놓친다).
      const appEnv = Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => typeof x[1] === 'string' && x[0] !== 'ELECTRON_RUN_AS_NODE'))
      const meta = { agent, title, line: plan.line, startedAt, ...(plan.deferredPrompt ? { prompt: plan.deferredPrompt } : {}) }
      await daemon.create({ id: sessionId, cwd, env: { ...appEnv, ...env }, meta })
    } catch (err) {
      log(`daemon create failed — local PTY fallback: ${String(err)}`)
      logMainError('agent daemon', err)
      sessionId = await deps.sessions().create({ type: 'local', title, serverKey: 'localhost', cwd, profileId: null, space: 'ai', env })
      // 로컬 PTY 로 넘어가도 우선순위는 건다(메모리 표본은 데몬에만 있다).
      const pid = deps.sessions().ptyList().find((p) => p.id === sessionId)?.pid
      if (settings.lowPriority && pid) lowerPriority(pid)
    }
    // 헤드리스 화면은 80×24 로 시작해 렌더러 터미널이 붙으며 보내는 resize 를 따라간다(SessionTap.resize).
    t.track({ sessionId, agent, prompt: plan.deferredPrompt })
    ensureChat().bind(sessionId, { agent, cwd, startedAt })
    tabMeta.set(sessionId, { agent, cwd })
    if (typeof prompt === 'string') maybeName(sessionId, prompt)
    // 막 뜬 셸에 바로 친다 — conpty 가 입력을 담아 두고 셸이 읽기 시작하면 받는다(터미널 AI 시작과 같은 순서).
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line, ...(noOriel ? { noOriel: true as const } : {}) }
  })
  return {
    stop: () => {
      daemon.disconnect() // 세션·데몬은 산다 — 다음에 켜면 다시 붙는다
      chat?.stop()
      return hooks.stop()
    },
    views: () => tracker?.views() ?? [],
    limits: () => agentLimitsOf(settings),
    orielPath: () => settings.orielPath
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
