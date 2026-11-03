// p3-M21 셋업 가이드(시작하기) 판정 — Orca shared/feature-wall-setup-steps.ts · feature-wall/feature-wall-setup-progress.ts(orcaRef ec112c6b01)의 아라판(순수).
// 단계 id 는 Orca 그대로. 판정은 이미 있는 값만 읽는다 — 기본 에이전트·Oriel 은 첫 안내(AiOnboarding)와 같은 감지(agents.detect·oriel.status)를 쓴다.
// 뺀 것: 원격 측정, computer-use 권한 탐침, 원격 런타임 탐침, '브라우저를 한 번 써 봄' 기록(아라는 Oriel 설치 여부로 판정).

export const SETUP_STEP_IDS = [
  'default-agent',
  'notifications',
  'agent-capabilities',
  'task-sources',
  'setup-script',
  'add-two-repos',
  'two-worktrees',
  'browser'
] as const
export type SetupStepId = (typeof SETUP_STEP_IDS)[number]

/** Orca FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS — 나머지는 '준비'. */
const PARALLEL: readonly SetupStepId[] = ['two-worktrees', 'browser']
export const sectionOfStep = (id: SetupStepId): 'setup' | 'parallel' => (PARALLEL.includes(id) ? 'parallel' : 'setup')

export type SetupGuideInput = {
  /** 기본 에이전트가 설치돼 있나(agents.detect + 설정 defaultAgent). */
  defaultAgentInstalled: boolean
  /** 설정 › 알림 [에이전트 알림]. */
  agentNotes: boolean
  /** 번들 스킬(ara-cli)이 한 곳이라도 설치됐나. */
  skillInstalled: boolean
  /** GitLab 연동이 켜지고 토큰이 있나(Orca: 작업 소스 연결). */
  trackerConnected: boolean
  /** 어느 저장소든 orca.yaml scripts.setup 이 있나. */
  hasSetupScript: boolean
  repoCount: number
  /** 본 폴더가 아닌 작업 단위 수(경로가 있는 것만 — Orca countAvailableNonMainWorktrees). */
  extraWorktreeCount: number
  orielInstalled: boolean
}

export type SetupGuideProgress = { ready: boolean; stepDone: Record<SetupStepId, boolean>; doneCount: number; total: number }

export function setupGuideProgress(input: SetupGuideInput, ready = true): SetupGuideProgress {
  const stepDone: Record<SetupStepId, boolean> = {
    'default-agent': input.defaultAgentInstalled,
    notifications: input.agentNotes,
    'agent-capabilities': input.skillInstalled,
    'task-sources': input.trackerConnected,
    'setup-script': input.hasSetupScript,
    'add-two-repos': input.repoCount >= 2,
    'two-worktrees': input.extraWorktreeCount >= 1,
    browser: input.orielInstalled
  }
  return { ready, stepDone, doneCount: SETUP_STEP_IDS.filter((id) => stepDone[id]).length, total: SETUP_STEP_IDS.length }
}

/** Orca getFirstIncompleteFeatureWallSetupStepId — 준비를 먼저, 그다음 병렬. 다 했으면 첫 단계. */
export function firstIncompleteStep(stepDone: Partial<Record<SetupStepId, boolean>>): SetupStepId {
  const setup = SETUP_STEP_IDS.find((id) => sectionOfStep(id) === 'setup' && !stepDone[id])
  return setup ?? SETUP_STEP_IDS.find((id) => !stepDone[id]) ?? SETUP_STEP_IDS[0]
}

/** Orca shouldShowSetupGuideEntry — 판정이 끝났고, 다 하지 않았고, 숨기지 않았을 때만 사이드바 줄. */
export const showSidebarEntry = (p: SetupGuideProgress, hidden: boolean): boolean => p.ready && p.doneCount < p.total && !hidden
