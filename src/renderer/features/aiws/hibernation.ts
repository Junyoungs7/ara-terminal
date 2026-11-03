// p3-M21 에이전트 잠재우기(하이버네이션) — Orca lib/agent-hibernation-planner.ts · agent-hibernation-pane-eligibility.ts ·
// agent-hibernation-confirmation.ts(orcaRef ec112c6b01)의 아라판. 기본 꺼짐(설정 › 에이전트).
//  재우는 조건(모두): 상태 끝남(idle) · 그 탭이 화면에 안 보임 · 끝난 뒤 키 입력 없음 · 하위 에이전트 없음 · 기다림 N분(1분~24시간) ·
//                    로컬 탭(원격 M8 은 수동 재우기처럼 제외) · 세션 id 를 받을 수 있음(agents.resumeIds — 재개할 수 있는 CLI).
//  60초마다 후보를 고르고 **두 번 연속** 같은 서명인 탭만 재운다(Orca 확인 서명). 재운다 = 세션 종료, 탭은 남기고 z 표시.
//  그 탭으로 돌아오면 같은 세션으로 이어 띄운다(2차 WS-16 wakeWorktree 와 같은 launchAgent(resume)). 재개에 실패하면 새로 띄운다.
// 뺀 것: 모바일 조종 잠금, 원격 런타임 exact-stop, twin-host, 레이아웃 소유자 전환, 디스패치 판정(아라에 없다), 새 출력으로 시계 되돌리기.
import type { AgentStatusView } from '@shared/agentHooks'
import { hibernateMinutesOf } from '@shared/agents'
import { useAgentStore } from './agentStore'
import { useAiwsStore } from './store'
import { lastInputAt } from '../../terminal/inputClock'
import { pushNote } from '../../store/notify'
import { t } from '../../i18n'

export const HIBERNATE_TICK_MS = 60_000
const MINUTE_MS = 60_000

export type HibernationSnapshot = {
  enabled: boolean
  idleMs: number
  now: number
  tabs: { sessionId: string; exited: boolean; host?: string; slept?: unknown }[]
  statusById: Record<string, AgentStatusView | undefined>
  /** 지금 보이는 탭. */
  viewing: string | null
  /** 끝남(idle)이 된 시각 — 처음 본 것. */
  doneAt: Record<string, number | undefined>
  /** 그 탭을 떠난 시각(Orca foregroundTerminalLastSeenAtByTabId). */
  leftAt: Record<string, number | undefined>
  inputAt: Record<string, number | undefined>
}

export type HibernationCandidate = { id: string; signature: string; idleStart: number }

/** Orca planAgentHibernationCandidates + getEligiblePane(순수). */
export function planHibernation(s: HibernationSnapshot): HibernationCandidate[] {
  if (!s.enabled) return []
  const out: HibernationCandidate[] = []
  for (const tab of s.tabs) {
    const id = tab.sessionId
    const st = s.statusById[id]
    const doneAt = s.doneAt[id]
    if (tab.exited || tab.host || tab.slept || s.viewing === id) continue
    if (!st || st.state !== 'idle' || st.agentExited || st.children.length > 0 || doneAt === undefined) continue
    const idleStart = Math.max(doneAt, s.leftAt[id] ?? 0)
    if (s.now - idleStart < s.idleMs) continue
    const inputAt = s.inputAt[id] ?? 0
    // 끝난 뒤 친 글(보내지 않은 초안)이 있으면 세션을 끄면 잃는다.
    if (inputAt > doneAt) continue
    out.push({ id, idleStart, signature: `${id}:${doneAt}:${idleStart}:${inputAt}` })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Orca confirmAgentHibernationCandidates — 앞 틱과 서명이 같은 후보만 통과. 빠진 후보는 기록에서도 지운다. */
export function confirmHibernation(prev: Record<string, string>, candidates: HibernationCandidate[]): { confirmed: HibernationCandidate[]; state: Record<string, string> } {
  const state: Record<string, string> = {}
  const confirmed: HibernationCandidate[] = []
  for (const c of candidates) {
    state[c.id] = c.signature
    if (prev[c.id] === c.signature) confirmed.push(c)
  }
  return { confirmed, state }
}

// ── 런타임(AI 작업 공간 청크) ─────────────────────────────────────────────────

const doneAt: Record<string, number> = {}
const leftAt: Record<string, number> = {}
let confirmState: Record<string, string> = {}
let started = false
const waking = new Set<string>()

function snapshot(now: number): HibernationSnapshot {
  const a = useAgentStore.getState()
  return {
    enabled: a.settings?.hibernate === true,
    idleMs: hibernateMinutesOf(a.settings?.hibernateMinutes) * MINUTE_MS,
    now,
    tabs: a.tabs,
    statusById: a.statusById,
    viewing: a.viewing,
    doneAt,
    leftAt,
    inputAt: Object.fromEntries(lastInputAt)
  }
}

async function tick(): Promise<void> {
  const now = Date.now()
  const plan = confirmHibernation(confirmState, planHibernation(snapshot(now)))
  confirmState = plan.state
  for (const c of plan.confirmed) await sleepTab(c.id, Math.round((now - c.idleStart) / MINUTE_MS))
}

/** 탭 하나를 재운다 — 세션 id 를 받고(닫기 전에 — 닫으면 main 이 transcript 경로를 잊는다) 세션을 끈다. 탭은 z 로 남는다. */
async function sleepTab(sessionId: string, minutes: number): Promise<void> {
  const ids = await window.ev.agents.resumeIds([sessionId]).catch(() => ({}) as Record<string, string | null>)
  const resume = ids[sessionId]
  const a = useAgentStore.getState()
  // 묻는 사이 보거나 친 것이 있으면 그대로 둔다.
  if (!resume || a.viewing === sessionId || (lastInputAt.get(sessionId) ?? 0) > (doneAt[sessionId] ?? 0)) return
  useAgentStore.setState((s) => ({ tabs: s.tabs.map((x) => (x.sessionId === sessionId ? { ...x, slept: { resume, minutes } } : x)) }))
  delete confirmState[sessionId]
  void window.ev.session.destroy(sessionId)
}

/** 잠든 탭으로 돌아왔다 — 같은 세션으로 이어 띄워 그 자리에 둔다(Orca resumeSleptPane). 재개가 안 되면 새로. */
export async function wakeTab(sessionId: string): Promise<void> {
  const old = useAgentStore.getState().tabs.find((x) => x.sessionId === sessionId)
  if (!old?.slept || waking.has(sessionId)) return
  waking.add(sessionId)
  try {
    const w = Object.values(useAiwsStore.getState().worktreesByRepo)
      .flat()
      .find((x) => x.id === old.worktreeId)
    if (!w) return
    const base = { agent: old.agent, worktreeId: old.worktreeId, cwd: w.path, ...(old.vaultTitle ? { vaultTitle: old.vaultTitle } : {}) }
    let r = await useAgentStore.getState().launchAgent({ ...base, resume: old.slept.resume })
    if (!r.ok) r = await useAgentStore.getState().launchAgent(base)
    if (!r.ok) {
      pushNote({ kind: 'error', space: 'ai', title: t('aiws.hib.wakeFailed'), body: r.error })
      return
    }
    const fresh = r.sessionId
    const keep = { woke: old.slept.minutes, ...(old.name ? { name: old.name } : {}), ...(old.genTitle ? { genTitle: old.genTitle } : {}) }
    // 새 탭(끝에 붙음)을 옛 자리로, 옛 탭은 닫는다(세션은 이미 끝났다).
    useAgentStore.setState((s) => {
      const nt = s.tabs.find((x) => x.sessionId === fresh)
      return nt ? { tabs: s.tabs.filter((x) => x !== nt).flatMap((x) => (x.sessionId === sessionId ? [x, { ...nt, ...keep }] : [x])) } : {}
    })
    useAgentStore.getState().closeTab(sessionId)
    useAgentStore.getState().setActiveTab(old.worktreeId, fresh)
  } finally {
    waking.delete(sessionId)
  }
}

/** AI 작업 공간을 처음 열 때 한 번. 창이 사는 동안 돈다(공간을 떠나도 — 그때는 아무 탭도 안 보인다). */
export function startHibernation(): void {
  if (started) return
  started = true
  const seed = (now: number): void => {
    const a = useAgentStore.getState()
    for (const [id, st] of Object.entries(a.statusById)) if (st?.state === 'idle' && doneAt[id] === undefined) doneAt[id] = now
  }
  seed(Date.now())
  useAgentStore.subscribe((s, p) => {
    const now = Date.now()
    if (s.statusById !== p.statusById)
      for (const [id, st] of Object.entries(s.statusById)) {
        if (st?.state !== 'idle') delete doneAt[id]
        else if (doneAt[id] === undefined || p.statusById[id]?.state !== 'idle') doneAt[id] = now
      }
    if (s.viewing !== p.viewing && p.viewing) {
      leftAt[p.viewing] = now
      // 깨운 뒤 한 줄 알림은 그 탭을 떠나면 걷는다.
      if (s.tabs.some((x) => x.sessionId === p.viewing && x.woke !== undefined))
        useAgentStore.setState((x) => ({ tabs: x.tabs.map((y) => (y.sessionId === p.viewing ? { ...y, woke: undefined } : y)) }))
    }
  })
  setInterval(() => void tick(), HIBERNATE_TICK_MS)
}
