// M3 에이전트(AI-01·02·03, R2: AI-04·05·06) — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// 설정은 userData/agents.json(workspace.json 과 따로 — projects.json 과 같은 방식, atomicJson .bak).
// 실행은 Orca 처럼 main 이 계획한다(spawn-agent-launch.ts → planAgentPaneLaunch): 렌더러는 에이전트·폴더·첫 지시만 보내고
// 명령줄·env 는 main 이 저장된 설정으로 만든다. PTY 는 아라의 로컬 세션 경로 그대로(MainSessionManager → PtyBackend, DA1 수정 포함).
// R2: 첫 실행 때 훅 서버를 열고(그 에이전트의 훅을 심고) 탭을 상태 원장(status.ts)에 올린다 — AI 작업 공간을 안 쓰면 아무것도 안 돈다.
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import { handle } from '../ipc/handle'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { pushSend } from '../util/windowPush'
import { logMainError } from '../log/MainErrorLog'
import { defaultLaunchShell } from '../sessions/PtyBackend'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { AGENTS, agentSettingsOf, isAgentId, migrateAiCliFlags, planAgentLaunch, type AgentSettings } from '@shared/agents'
import { HOOK_ENV, isHookSource, type AgentStatusView, type HookSource } from '@shared/agentHooks'
import type { AgentLaunchResult } from '@shared/ipc'
import { createAgentDetector } from './detect'
import { createHookServer, installHooks } from './hooks'
import { createAgentStatusTracker, type AgentStatusTracker } from './status'

export function registerAgentsFeature(deps: {
  userData: string
  sessions: () => MainSessionManager
  /** 옛 설정 [AI] 의 터미널 AI 기본 플래그(workspace.json ui.aiCliFlags) — 처음 한 번 옮긴다. */
  readAiCliFlags: () => unknown
  /** 훅을 심을 홈(`~/.claude`·`~/.gemini`·`~/.ara/agent-hooks`). e2e 는 임시 폴더 — 사용자 설정을 시험 부산물로 바꾸지 않는다. */
  home: string
  mainWc: () => WebContents | null
}): { stop(): Promise<void>; views(): AgentStatusView[] } {
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
  const hooks = createHookServer((e) => tracker?.hook(e))
  const installed = new Set<HookSource>()
  const ensureTracker = (): AgentStatusTracker => {
    if (tracker) return tracker
    const t = createAgentStatusTracker({
      push: (v) => pushSend(deps.mainWc(), 'agents:status', v),
      write: (id, data) => deps.sessions().write(id, data)
    })
    deps.sessions().setTap(t)
    tracker = t
    return t
  }

  const detector = createAgentDetector()
  handle('agents:detect', ({ force }) => detector.detect(force === true))
  handle('agents:getSettings', () => settings)
  handle('agents:setSettings', ({ settings: next }) => save(next))
  handle('agents:statuses', () => tracker?.views() ?? [])
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
      const { port, token } = await hooks.ensure()
      if (!installed.has(agent)) {
        const r = installHooks(deps.home, agent)
        if (r.ok) installed.add(agent)
        else logMainError(`agent hooks:${agent}`, new Error(r.message))
      }
      if (port > 0 && installed.has(agent)) Object.assign(hookEnv, { [HOOK_ENV.port]: String(port), [HOOK_ENV.token]: token })
    }
    const title = `${AGENTS[agent].label} · ${basename(cwd) || cwd}`
    const sessionId = await deps.sessions().create({ type: 'local', title, serverKey: 'localhost', cwd, profileId: null, space: 'ai', env: { ...plan.env, ...hookEnv } })
    // 헤드리스 화면은 80×24 로 시작해 렌더러 터미널이 붙으며 보내는 resize 를 따라간다(SessionTap.resize).
    t.track({ sessionId, agent, prompt: plan.deferredPrompt })
    // 막 뜬 셸에 바로 친다 — conpty 가 입력을 담아 두고 셸이 읽기 시작하면 받는다(터미널 AI 시작과 같은 순서).
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line }
  })
  return { stop: () => hooks.stop(), views: () => tracker?.views() ?? [] }
}
