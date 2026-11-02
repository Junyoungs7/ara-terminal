// M14 R2 `ara` CLI — 기능 틀(docs/feature-module.md)의 main 등록 함수.
//  · 받는 자리(server.ts) 켜기 — 앱이 떠 있는 동안 늘. 전역 설정을 바꾸지 않는다(파일은 userData 안의 ara-runtime.json 하나).
//  · 설정의 [CLI 설치]·[제거](install.ts) · 번들 스킬 [설치](bundledSkill.ts) — 사람이 눌렀을 때만.
//  · 에이전트 띄우기는 본창 렌더러가 한다(앱의 [+] 와 같은 길) — 'cli:launchAgent' 로 부탁하고 'cli:launchAgentResult' 로 답을 받는다.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { AgentLaunchResult } from '@shared/ipc'
import type { AgentId } from '@shared/agents'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { logMainError } from '../log/MainErrorLog'
import { renderScreen } from '../sessions/screenText'
import { skillRoots } from '../skills/feature'
import { startCliServer, type CliServerHandle } from './server'
import { createCliHandlers, type CliDeps } from './handlers'
import { cliInstallStatus, installCli, realInstallDeps, uninstallCli } from './install'
import { bundledSkillSource, bundledSkillStatus, installBundledSkill } from './bundledSkill'
import { setupAraCliChildPath } from './childPath'

/** 렌더러가 탭을 띄우는 데 기다리는 상한 — 에이전트 감지가 처음이면 몇 초 걸린다. */
const LAUNCH_TIMEOUT_MS = 60_000

export function registerCliFeature(deps: {
  userData: string
  appVersion: string
  isPackaged: boolean
  resourcesPath: string
  /** 번들 스킬 원본 후보(설치본 resources · 개발 저장소 resources). */
  skillSourceDirs: string[]
  home: string
  env: Record<string, string | undefined>
  worktrees: CliDeps['worktrees']
  sessions: () => CliDeps['sessions'] | null
  mainWc: () => WebContents | null
}): { stop(): Promise<void> } {
  const pending = new Map<string, (r: AgentLaunchResult) => void>()
  const launchAgent = (req: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string }): Promise<AgentLaunchResult> =>
    new Promise((resolve) => {
      const wc = deps.mainWc()
      if (!wc || wc.isDestroyed()) return resolve({ ok: false, error: '에이전트를 띄울 아라 창이 없습니다.' })
      const reqId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(reqId)
        resolve({ ok: false, error: '아라 창이 답하지 않았습니다(잠겨 있거나 아직 뜨는 중일 수 있습니다).' })
      }, LAUNCH_TIMEOUT_MS)
      pending.set(reqId, (r) => {
        clearTimeout(timer)
        pending.delete(reqId)
        resolve(r)
      })
      pushSend(wc, 'cli:launchAgent', { reqId, ...req })
    })
  handle('cli:launchAgentResult', ({ reqId, result }) => {
    pending.get(reqId)?.(result)
  })

  const sessions = (): CliDeps['sessions'] => {
    const s = deps.sessions()
    if (!s) throw new Error('세션 관리자가 아직 준비되지 않았습니다.')
    return s
  }
  const handlers = createCliHandlers({
    appVersion: deps.appVersion,
    worktrees: deps.worktrees,
    sessions: {
      snapshot: () => sessions().snapshot(),
      has: (id) => sessions().has(id),
      write: (id, data) => sessions().write(id, data),
      peek: (id) => sessions().peek(id),
      nextTitle: (b) => sessions().nextTitle(b),
      create: (spec) => sessions().create(spec)
    },
    renderScreen,
    launchAgent,
    worktreesChanged: (repoId) => pushSend(deps.mainWc(), 'cli:worktreesChanged', { repoId })
  })

  let server: CliServerHandle | null = null
  void startCliServer({ userData: deps.userData, appVersion: deps.appVersion, handlers, log: logMainError })
    .then((s) => (server = s))
    .catch((e) => logMainError('cli server', e))

  // 정리 1: 아라가 띄우는 PTY 의 PATH 맨 앞에 ara 폴더(childPath.ts) — [CLI 설치] 없이 에이전트 탭에서 `ara`. araCli.js 는 이 번들 옆(out/main).
  setupAraCliChildPath({ platform: process.platform, isPackaged: deps.isPackaged, resourcesPath: deps.resourcesPath, userData: deps.userData, execPath: process.execPath, cliEntryCandidates: [join(__dirname, 'araCli.js'), join(__dirname, '..', 'araCli.js')], log: (m) => logMainError('cli child path', new Error(m)) })

  const install = () => realInstallDeps({ isPackaged: deps.isPackaged, resourcesPath: deps.resourcesPath })
  handle('cli:status', () => cliInstallStatus(install()))
  handle('cli:install', () => installCli(install()))
  handle('cli:uninstall', () => uninstallCli(install()))

  const roots = () => skillRoots(deps.home, deps.env, [])
  handle('cli:skillStatus', () => bundledSkillStatus(bundledSkillSource(deps.skillSourceDirs), roots()))
  handle('cli:skillInstall', ({ rootId }) => installBundledSkill(bundledSkillSource(deps.skillSourceDirs), roots(), rootId))

  return { stop: async () => void (await server?.stop()) }
}
