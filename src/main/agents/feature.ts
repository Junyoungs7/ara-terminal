// M3 에이전트(AI-01·02·03) — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// 설정은 userData/agents.json(workspace.json 과 따로 — projects.json 과 같은 방식, atomicJson .bak).
// 실행은 Orca 처럼 main 이 계획한다(spawn-agent-launch.ts → planAgentPaneLaunch): 렌더러는 에이전트·폴더·첫 지시만 보내고
// 명령줄·env 는 main 이 저장된 설정으로 만든다. PTY 는 아라의 로컬 세션 경로 그대로(MainSessionManager → PtyBackend, DA1 수정 포함).
import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { handle } from '../ipc/handle'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { defaultLaunchShell } from '../sessions/PtyBackend'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { AGENTS, agentSettingsOf, isAgentId, migrateAiCliFlags, planAgentLaunch, type AgentSettings } from '@shared/agents'
import type { AgentLaunchResult } from '@shared/ipc'
import { createAgentDetector } from './detect'

export function registerAgentsFeature(deps: {
  userData: string
  sessions: () => MainSessionManager
  /** 옛 설정 [AI] 의 터미널 AI 기본 플래그(workspace.json ui.aiCliFlags) — 처음 한 번 옮긴다. */
  readAiCliFlags: () => unknown
}): void {
  const file = join(deps.userData, 'agents.json')
  cleanupTemp(file)
  let settings = agentSettingsOf(readJsonWithBackup<unknown>(file, null))
  const save = (next: AgentSettings): AgentSettings => {
    settings = agentSettingsOf(next)
    writeJsonAtomic(file, settings)
    return settings
  }
  if (!settings.migratedAiCliFlags) save(migrateAiCliFlags(settings, deps.readAiCliFlags()))

  const detector = createAgentDetector()
  handle('agents:detect', ({ force }) => detector.detect(force === true))
  handle('agents:getSettings', () => settings)
  handle('agents:setSettings', ({ settings: next }) => save(next))
  handle('agents:launch', async ({ agent, cwd, prompt }): Promise<AgentLaunchResult> => {
    if (!isAgentId(agent)) return { ok: false, error: '모르는 에이전트' }
    try {
      if (typeof cwd !== 'string' || !statSync(cwd).isDirectory()) return { ok: false, error: `폴더가 아닙니다: ${cwd}` }
    } catch {
      return { ok: false, error: `폴더가 없습니다: ${cwd}` }
    }
    const shell = defaultLaunchShell()
    const plan = planAgentLaunch({ agent, settings, prompt: typeof prompt === 'string' ? prompt : undefined, shell })
    if (!plan.ok) return plan
    const title = `${AGENTS[agent].label} · ${basename(cwd) || cwd}`
    const sessionId = await deps.sessions().create({ type: 'local', title, serverKey: 'localhost', cwd, profileId: null, space: 'ai', env: plan.env })
    // 막 뜬 셸에 바로 친다 — conpty 가 입력을 담아 두고 셸이 읽기 시작하면 받는다(터미널 AI 시작과 같은 순서).
    deps.sessions().write(sessionId, plan.line + '\r')
    return { ok: true, sessionId, title, line: plan.line }
  })
}
