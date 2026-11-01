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
import { AGENTS, agentLimitsOf, agentSettingsOf, isAgentId, migrateAiCliFlags, planAgentLaunch, type AgentSettings } from '@shared/agents'
import { HOOK_ENV, isHookSource, type AgentStatusView, type HookSource } from '@shared/agentHooks'
import type { AgentLaunchResult, AgentTabInfo } from '@shared/ipc'
import type { AgentLimits } from '@shared/resources'
import { createAgentDetector } from './detect'
import { createHookServer, installHooks } from './hooks'
import { createAgentStatusTracker, type AgentStatusTracker } from './status'
import { createChatWatcher, type ChatWatcher } from './chat'
import { createAgentDaemon, daemonRuntimeDir } from '../daemon/service'
import { installRuntime, relocatedRuntime } from '../daemon/launcher'
import type { DaemonSessionInfo } from '../daemon/protocol'
import { lowerPriority } from '../resources/hostProcs'

export function registerAgentsFeature(deps: {
  userData: string
  sessions: () => MainSessionManager
  /** 옛 설정 [AI] 의 터미널 AI 기본 플래그(workspace.json ui.aiCliFlags) — 처음 한 번 옮긴다. */
  readAiCliFlags: () => unknown
  /** 훅을 심을 홈(`~/.claude`·`~/.gemini`·`~/.ara/agent-hooks`). e2e 는 임시 폴더 — 사용자 설정을 시험 부산물로 바꾸지 않는다. */
  home: string
  mainWc: () => WebContents | null
}): { stop(): Promise<void>; views(): AgentStatusView[]; limits(): AgentLimits } {
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
  const ensureChat = (): ChatWatcher =>
    (chat ??= createChatWatcher({ push: (e) => pushSend(deps.mainWc(), 'agents:chat', e), store: join(deps.userData, 'agent-chat.json'), home: deps.home, env: process.env['ARA_E2E'] === '1' ? {} : process.env }))
  const hooks = createHookServer(
    (e) => {
      tracker?.hook(e)
      if (e.source === 'claude') ensureChat().hook(e.paneKey, e.payload)
    },
    typeof savedHook?.port === 'number' && typeof savedHook.token === 'string' ? { port: savedHook.port, token: savedHook.token } : null
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
  const ensureTracker = (): AgentStatusTracker => {
    if (tracker) return tracker
    const t = createAgentStatusTracker({
      push: (v) => pushSend(deps.mainWc(), 'agents:status', v),
      write: (id, data) => deps.sessions().write(id, data)
    })
    // 탭이 끝나면 기억한 transcript 경로도 지운다(앱 종료의 detach 는 exit 가 아니라 남는다 — 다시 켜면 바로 연다).
    deps.sessions().setTap({ ...t, exit: (id) => (t.exit(id), chat?.forget(id)) })
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
    return { sessionId: info.id, agent: m['agent'], cwd: info.cwd, title: m['title'], line: typeof m['line'] === 'string' ? m['line'] : '', ...(typeof m['prompt'] === 'string' ? { prompt: m['prompt'] } : {}) }
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
    const saved = save(next)
    const after = agentLimitsOf(saved)
    if (before.lowPriority !== after.lowPriority || before.memoryBytes !== after.memoryBytes) daemon.setLimits(after)
    return saved
  })
  handle('agents:statuses', () => tracker?.views() ?? [])
  handle('agents:tabs', async () => {
    await daemon.ready
    return restoredTabs.filter((t) => deps.sessions().has(t.sessionId))
  })
  handle('agents:chatOpen', ({ sessionId }) => ensureChat().open(sessionId))
  handle('agents:chatClose', ({ sessionId }) => chat?.close(sessionId))
  // 채팅 입력 → PTY. 첫 지시와 같은 길(status.ts send — 입력 상자가 뜬 뒤 괄호 붙여넣기 → 길이만큼 기다려 Enter).
  // 바로 쓰면 에이전트가 뜨기 전 셸(PowerShell PSReadLine 의 미리 읽기)이 글을 먹는다 — e2e CHAT-1 실패의 원인.
  handle('agents:chatSend', ({ sessionId, agent, text }) => {
    if (!isAgentId(agent) || typeof text !== 'string' || !text.trim() || !deps.sessions().has(sessionId)) return { ok: false }
    return { ok: ensureTracker().send(sessionId, text) }
  })
  handle('agents:killBackground', async () => ({ killed: await daemon.killAll() }))
  handle('agents:quitCompletely', async () => {
    await daemon.shutdownAll()
    app.quit()
  })
  handle('agents:launch', async ({ agent, cwd, prompt, resume }): Promise<AgentLaunchResult> => {
    if (!isAgentId(agent)) return { ok: false, error: '모르는 에이전트' }
    try {
      if (typeof cwd !== 'string' || !statSync(cwd).isDirectory()) return { ok: false, error: `폴더가 아닙니다: ${cwd}` }
    } catch {
      return { ok: false, error: `폴더가 없습니다: ${cwd}` }
    }
    const shell = defaultLaunchShell()
    const plan = planAgentLaunch({ agent, settings, prompt: typeof prompt === 'string' ? prompt : undefined, shell, resume: typeof resume === 'string' && resume ? resume : undefined })
    if (!plan.ok) return plan
    const t = ensureTracker()
    // 훅: 서버를 열고(처음 한 번) 그 CLI 의 훅을 심는다(처음 한 번). 실패해도 실행은 한다 — 그 탭은 화면 판정('추정')만.
    const hookEnv: Record<string, string> = {}
    if (isHookSource(agent)) {
      const { port, token } = await ensureHooks()
      if (!installed.has(agent)) {
        const r = installHooks(deps.home, agent)
        if (r.ok) installed.add(agent)
        else logMainError(`agent hooks:${agent}`, new Error(r.message))
      }
      if (port > 0 && installed.has(agent)) Object.assign(hookEnv, { [HOOK_ENV.port]: String(port), [HOOK_ENV.token]: token })
    }
    const title = `${AGENTS[agent].label} · ${basename(cwd) || cwd}`
    const env = { ...plan.env, ...hookEnv }
    let sessionId: string = randomUUID()
    try {
      // 데몬 셸은 앱의 **지금** 환경을 받는다(데몬 환경은 띄운 순간에 굳는다 — 감지가 더한 PATH 등을 놓친다).
      const appEnv = Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => typeof x[1] === 'string' && x[0] !== 'ELECTRON_RUN_AS_NODE'))
      const meta = { agent, title, line: plan.line, ...(plan.deferredPrompt ? { prompt: plan.deferredPrompt } : {}) }
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
    // 막 뜬 셸에 바로 친다 — conpty 가 입력을 담아 두고 셸이 읽기 시작하면 받는다(터미널 AI 시작과 같은 순서).
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line }
  })
  return {
    stop: () => {
      daemon.disconnect() // 세션·데몬은 산다 — 다음에 켜면 다시 붙는다
      chat?.stop()
      return hooks.stop()
    },
    views: () => tracker?.views() ?? [],
    limits: () => agentLimitsOf(settings)
  }
}
