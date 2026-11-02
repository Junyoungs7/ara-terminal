// M14 R1 AU-01 예약 실행 — Orca src/main/automations/service.ts(AutomationService)의 이 PC 부분.
// 규칙(Orca 그대로):
//  · 앱(main) 안의 60초 타이머가 예약을 본다. **OS 작업 스케줄러에 등록하지 않는다**(Orca 데스크톱도 앱 안에서만 돈다).
//    앱이 꺼져 있던 동안의 예약은 다음에 켰을 때 "놓친 실행 유예"(기본 720분) 안이면 한 번만 돌리고, 넘었으면 '놓침'으로 남긴다.
//  · PC 가 잠들어 있던 동안도 같다 — 타이머가 멈췄다 깨어난 뒤의 첫 틱이 경과 시간으로 판정한다(missedBeyondGrace).
//  · 예약 실행만 사전 점검(precheck)을 돌린다. [지금 실행]은 건너뛴다. 종료 코드 0 이 아니면(오류·시간 초과 포함) '사전 점검으로 건너뜀'.
//  · 띄우기는 렌더러가 한다(Orca automations:dispatchRequested → 에이전트 탭). 렌더러가 없으면 '실행할 창 없음'으로 건너뛴다.
//  · 끝남 = 그 탭의 에이전트가 '일하는 중'을 지나 멈췄을 때(Orca handleAgentDone).
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { latestAutomationOccurrenceAtOrBefore, nextAutomationOccurrenceAfter } from '@shared/automations/automation-schedule-occurrences'
import { isRunnableAutomationSchedule, isValidAutomationSchedule } from '@shared/automations/automation-schedule-parsing'
import { didAutomationPrecheckPass, formatAutomationPrecheckFailure, normalizeAutomationPrecheck } from '@shared/automations/automation-precheck'
import {
  AUTOMATION_RUNS_KEPT,
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationDispatchRequest,
  type AutomationDispatchResult,
  type AutomationInput,
  type AutomationPrecheck,
  type AutomationPrecheckResult,
  type AutomationRun,
  type AutomationRunTrigger,
  type AutomationsState
} from '@shared/automations/automations-types'
import { isAgentId } from '@shared/agents'

export const AUTOMATION_TICK_MS = 60 * 1000

/** Orca AUTOMATION_RUN_FAILURE_COPY 중 이 PC 에서 나는 것(화면은 이 문장을 그대로 보인다). */
export const AUTOMATION_FAILURE = {
  noDispatchHost: '실행할 아라 창이 없어 건너뛰었습니다.',
  missedGraceWindow: '아라가 꺼져 있었거나 PC 가 잠들어 유예 시간 안에 실행하지 못했습니다.',
  targetMissing: '대상 작업 단위 폴더가 없습니다.',
  unevaluableSchedule: '예약을 해석하지 못했습니다.'
} as const

export type AutomationServiceDeps = {
  load: () => AutomationsState
  save: (s: AutomationsState) => void
  /** 렌더러에 띄우기를 부탁한다. 받을 창이 없으면 false. */
  dispatch: (req: AutomationDispatchRequest) => boolean
  runPrecheck: (precheck: AutomationPrecheck, cwd: string) => Promise<AutomationPrecheckResult>
  /** 바뀔 때마다(화면 갱신). */
  changed?: (s: AutomationsState) => void
  now?: () => number
  pathExists?: (p: string) => boolean
  tickMs?: number
}

export type AutomationService = ReturnType<typeof createAutomationService>

/** Allow tick jitter beyond downtime grace; elapsed time still catches system sleep(Orca dispatch-refusal.ts). */
export function missedBeyondGrace(a: Pick<Automation, 'missedRunGraceMinutes'>, scheduledFor: number, now: number, tickMs: number): boolean {
  return now - scheduledFor > a.missedRunGraceMinutes * 60 * 1000 + tickMs * 2
}

/** Evict only final runs; a dispatched run still needs its row(Orca pruneAutomationRuns). */
export function pruneRuns(runs: readonly AutomationRun[], max = AUTOMATION_RUNS_KEPT): AutomationRun[] {
  const keep = new Set<string>()
  const byAuto = new Map<string, AutomationRun[]>()
  for (const r of runs) if (isFinalAutomationRunStatus(r.status)) byAuto.set(r.automationId, [...(byAuto.get(r.automationId) ?? []), r])
  for (const list of byAuto.values()) for (const r of [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, max)) keep.add(r.id)
  return runs.filter((r) => keep.has(r.id) || !isFinalAutomationRunStatus(r.status))
}

/** 렌더러에서 온 입력을 다시 거른다. 잘못이면 사유. */
export function validateAutomationInput(v: unknown): { ok: true; input: AutomationInput } | { ok: false; error: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const name = str('name').trim()
  const prompt = str('prompt').trim()
  const rrule = str('rrule').trim()
  if (!name) return { ok: false, error: '이름을 입력하세요.' }
  if (!prompt) return { ok: false, error: '지시를 입력하세요.' }
  if (!isAgentId(o['agentId'])) return { ok: false, error: '에이전트를 고르세요.' }
  if (!str('workspaceId') || !str('workspacePath')) return { ok: false, error: '작업 단위를 고르세요.' }
  if (!isValidAutomationSchedule(rrule)) return { ok: false, error: '예약이 올바르지 않습니다.' }
  const grace = Number(o['missedRunGraceMinutes'])
  return {
    ok: true,
    input: {
      name,
      prompt,
      precheck: normalizeAutomationPrecheck(o['precheck'] as AutomationPrecheck | null),
      agentId: o['agentId'],
      projectId: str('projectId'),
      workspaceId: str('workspaceId'),
      workspacePath: str('workspacePath'),
      workspaceName: str('workspaceName') || str('workspacePath'),
      rrule,
      enabled: o['enabled'] !== false,
      missedRunGraceMinutes: Number.isFinite(grace) && grace >= 0 ? Math.min(Math.floor(grace), 7 * 24 * 60) : 720
    }
  }
}

export function createAutomationService(deps: AutomationServiceDeps) {
  const now = deps.now ?? Date.now
  const tickMs = deps.tickMs ?? AUTOMATION_TICK_MS
  const pathExists = deps.pathExists ?? existsSync
  let state: AutomationsState = deps.load()
  let timer: ReturnType<typeof setInterval> | null = null
  let evaluating = false
  /** 띄운 실행의 탭 → '일하는 중'을 봤나. */
  const watching = new Map<string, { runId: string; sawWorking: boolean }>()
  for (const r of state.runs) if (r.status === 'dispatched' && r.sessionId) watching.set(r.sessionId, { runId: r.id, sawWorking: false })

  const commit = (): void => {
    state = { automations: state.automations, runs: pruneRuns(state.runs) }
    deps.save(state)
    deps.changed?.(state)
  }
  const find = (id: string): Automation | undefined => state.automations.find((a) => a.id === id)
  const nextAfter = (a: Pick<Automation, 'rrule' | 'dtstart'>, t: number): number => {
    try {
      return nextAutomationOccurrenceAfter(a.rrule, a.dtstart, t)
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  }
  const patchRun = (runId: string, p: Partial<AutomationRun>): AutomationRun | null => {
    let out: AutomationRun | null = null
    state = { ...state, runs: state.runs.map((r) => (r.id === runId ? (out = { ...r, ...p }) : r)) }
    return out
  }
  const createRun = (a: Automation, scheduledFor: number, trigger: AutomationRunTrigger): AutomationRun => {
    const runNumber = state.runs.filter((r) => r.automationId === a.id).reduce((m, r) => Math.max(m, r.runNumber), 0) + 1
    const run: AutomationRun = {
      id: randomUUID(),
      automationId: a.id,
      title: `${a.name} #${runNumber}`,
      scheduledFor,
      status: 'pending',
      trigger,
      workspaceId: a.workspaceId,
      workspaceDisplayName: a.workspaceName,
      sessionId: null,
      precheckResult: null,
      error: null,
      startedAt: null,
      dispatchedAt: null,
      completedAt: null,
      createdAt: now(),
      runNumber
    }
    state = { ...state, runs: [...state.runs, run] }
    return run
  }
  const finish = (runId: string, p: Partial<AutomationRun>): AutomationRun | null => {
    const r = patchRun(runId, { ...p, completedAt: now() })
    commit()
    return r
  }

  /** 사전 점검(예약 실행만) → 대상 확인 → 렌더러에 띄우기 부탁. */
  const dispatch = async (a: Automation, run: AutomationRun): Promise<AutomationRun | null> => {
    patchRun(run.id, { status: 'dispatching', startedAt: now() })
    commit()
    if (!pathExists(a.workspacePath)) return finish(run.id, { status: 'skipped_unavailable', error: AUTOMATION_FAILURE.targetMissing })
    if (run.trigger === 'scheduled' && a.precheck) {
      const pre = await deps.runPrecheck(a.precheck, a.workspacePath)
      patchRun(run.id, { precheckResult: pre })
      if (!didAutomationPrecheckPass(pre)) return finish(run.id, { status: 'skipped_precheck', error: formatAutomationPrecheckFailure(pre) })
    }
    const current = state.runs.find((r) => r.id === run.id)!
    if (!deps.dispatch({ automation: a, run: current })) return finish(run.id, { status: 'skipped_unavailable', error: AUTOMATION_FAILURE.noDispatchHost })
    commit()
    return state.runs.find((r) => r.id === run.id) ?? null
  }

  const evaluateAutomation = async (a: Automation, t: number): Promise<void> => {
    const scheduledFor = latestAutomationOccurrenceAtOrBefore(a.rrule, a.dtstart, t)
    const advance = (): void => {
      state = { ...state, automations: state.automations.map((x) => (x.id === a.id ? { ...x, nextRunAt: nextAfter(x, t), ...(scheduledFor !== null ? { lastRunAt: scheduledFor } : {}) } : x)) }
    }
    if (scheduledFor === null) {
      advance()
      commit()
      return
    }
    const run = createRun(a, scheduledFor, 'scheduled')
    advance()
    if (missedBeyondGrace(a, scheduledFor, t, tickMs)) {
      finish(run.id, { status: 'skipped_missed', error: AUTOMATION_FAILURE.missedGraceWindow })
      return
    }
    await dispatch(a, run)
  }

  const evaluateDueRuns = async (): Promise<void> => {
    if (evaluating) return
    evaluating = true
    try {
      const t = now()
      for (const a of state.automations) {
        if (!a.enabled || a.nextRunAt > t) continue
        // A malformed schedule must not prevent later due rows from running.
        try {
          if (!isRunnableAutomationSchedule(a.rrule)) throw new Error('unrunnable')
          await evaluateAutomation(a, t)
        } catch {
          const run = createRun(a, a.nextRunAt, 'scheduled')
          state = { ...state, automations: state.automations.map((x) => (x.id === a.id ? { ...x, nextRunAt: Number.MAX_SAFE_INTEGER } : x)) }
          finish(run.id, { status: 'skipped_unavailable', error: AUTOMATION_FAILURE.unevaluableSchedule })
        }
      }
    } finally {
      evaluating = false
    }
  }

  const update = (id: string, input: AutomationInput): Automation | null => {
    const cur = find(id)
    if (!cur) return null
    const t = now()
    // 예약이 바뀌거나 다시 켜면 지금부터 센다(지난 칸을 소급하지 않는다).
    const rescheduled = cur.rrule !== input.rrule || (!cur.enabled && input.enabled)
    const next: Automation = { ...cur, ...input, updatedAt: t, ...(rescheduled ? { dtstart: t } : {}) }
    if (rescheduled) next.nextRunAt = nextAfter(next, t)
    state = { ...state, automations: state.automations.map((a) => (a.id === id ? next : a)) }
    commit()
    return next
  }

  return {
    state: (): AutomationsState => state,
    /** 렌더러가 띄울 준비가 됐다 — 타이머를 걸고 밀린 예약을 바로 본다(Orca setRendererReady). */
    start(): void {
      if (!timer) timer = setInterval(() => void evaluateDueRuns(), tickMs)
      void evaluateDueRuns()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    },
    evaluateDueRuns,
    create(input: AutomationInput): Automation {
      const t = now()
      const a: Automation = { ...input, id: randomUUID(), dtstart: t, nextRunAt: 0, createdAt: t, updatedAt: t }
      a.nextRunAt = nextAfter(a, t)
      state = { ...state, automations: [...state.automations, a] }
      commit()
      return a
    },
    update,
    setEnabled(id: string, enabled: boolean): Automation | null {
      const cur = find(id)
      return cur ? update(id, { ...cur, enabled }) : null
    },
    /** 지우면 실행 이력도 함께(Orca remove). */
    remove(id: string): boolean {
      if (!find(id)) return false
      state = { automations: state.automations.filter((a) => a.id !== id), runs: state.runs.filter((r) => r.automationId !== id) }
      commit()
      return true
    },
    /** [지금 실행]·[다시 실행] — 사전 점검을 건너뛴다(Orca runNow). */
    async runNow(id: string): Promise<AutomationRun | null> {
      const a = find(id)
      if (!a) return null
      return dispatch(a, createRun(a, now(), 'manual'))
    },
    markDispatchResult(r: AutomationDispatchResult): AutomationRun | null {
      const run = state.runs.find((x) => x.id === r.runId)
      if (!run || isFinalAutomationRunStatus(run.status)) return run ?? null
      if (r.status === 'dispatched') {
        const out = patchRun(r.runId, { status: 'dispatched', dispatchedAt: now(), sessionId: r.sessionId ?? null, error: null })
        if (r.sessionId) watching.set(r.sessionId, { runId: r.runId, sawWorking: false })
        commit()
        return out
      }
      return finish(r.runId, { status: r.status, error: r.error ?? null })
    },
    /** 에이전트 탭 상태 — '일하는 중'을 지나 멈추면 그 실행은 끝(Orca handleAgentDone). 탭이 끝나도 끝. */
    observe(sessionId: string, working: boolean | 'exit'): void {
      const w = watching.get(sessionId)
      if (!w) return
      if (working === true) {
        w.sawWorking = true
        return
      }
      if (working === 'exit' || w.sawWorking) {
        watching.delete(sessionId)
        finish(w.runId, { status: 'completed' })
      }
    }
  }
}
