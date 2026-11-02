// M14 R1 AU-01 예약 실행 — Orca src/shared/automations-types.ts 의 데스크톱(이 PC) 부분.
// 뺀 것: 원격 호스트·SSH 예약 주인(schedulerOwner), 실행마다 새 작업 단위(new_per_run), 세션 재사용, 추가 인자, 사용량 귀속, 소스 맥락.
import type { AgentId } from '../agents'

export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_precheck'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'dispatch_failed'
export type AutomationRunTrigger = 'scheduled' | 'manual'

/** Statuses a run can never leave; only these are safe to evict from history. */
export function isFinalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return status === 'completed' || status === 'dispatch_failed' || status === 'skipped_precheck' || status === 'skipped_missed' || status === 'skipped_unavailable'
}

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export type AutomationPrecheck = { command: string; timeoutSeconds: number }

export type AutomationPrecheckResult = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type Automation = {
  id: string
  name: string
  prompt: string
  precheck: AutomationPrecheck | null
  agentId: AgentId
  /** 작업 단위(워크트리) — Orca workspaceMode 'existing'. 실행은 그 폴더에서. */
  projectId: string
  workspaceId: string
  workspacePath: string
  workspaceName: string
  /** RRULE(FREQ=…) 또는 cron 5칸 — Orca 와 같은 문법. */
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
}

export type AutomationRun = {
  id: string
  automationId: string
  title: string
  scheduledFor: number
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  workspaceId: string | null
  workspaceDisplayName: string | null
  /** 띄운 에이전트 탭(세션 id). */
  sessionId: string | null
  precheckResult: AutomationPrecheckResult | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  completedAt: number | null
  createdAt: number
  runNumber: number
}

export type AutomationInput = {
  name: string
  prompt: string
  precheck: AutomationPrecheck | null
  agentId: AgentId
  projectId: string
  workspaceId: string
  workspacePath: string
  workspaceName: string
  rrule: string
  enabled: boolean
  missedRunGraceMinutes: number
}

/** main → 렌더러: 이 실행을 띄워 달라(Orca automations:dispatchRequested). */
export type AutomationDispatchRequest = { automation: Automation; run: AutomationRun }
/** 렌더러 → main: 띄운 결과(Orca markDispatchResult). */
export type AutomationDispatchResult = { runId: string; status: 'dispatched' | 'dispatch_failed' | 'skipped_unavailable'; sessionId?: string | null; error?: string | null }

export type AutomationsState = { automations: Automation[]; runs: AutomationRun[] }

/** Orca 편집기 기본값(use-automation-editor-actions.ts): 평일·09:00·유예 720분·사전 점검 60초. */
export const AUTOMATION_DEFAULT_TIME = '09:00'
export const AUTOMATION_DEFAULT_GRACE_MINUTES = 720
/** Orca AutomationMissedRunGraceField 의 고를 수 있는 값(분). */
export const AUTOMATION_GRACE_CHOICES = [0, 30, 60, 180, 720, 1440, 2880] as const
/** 자동화 하나에 남기는 끝난 실행 이력 수(Orca MAX_AUTOMATION_RUNS_PER_AUTOMATION). */
export const AUTOMATION_RUNS_KEPT = 100
