import { useCallback, useEffect, useState } from 'react'
import type { AgentState, AgentStatus } from '@shared/agentStatus'
import type { AiCliId } from '@shared/aiCli'
import type { Session } from '@shared/types'
import { agentStatuses, forgetAgentStatus, subscribeAgent } from './agentStatus'

// F30 AI 세션 패널 — "지금 어느 AI 가 나를 기다리나".
//
// 준영님 요청(2026-08-12): 서버 3대에 Claude Code 를 띄워 두면 어느 놈이 승인을 기다리며 멈춰
// 있는지 알 수 없다. 탭을 하나씩 눌러 보다가 "10분째 물어보고 있었네"가 된다.
//
// **F1a(2026-08-30)에서 판정 근거가 통째로 바뀌었다.** 예전에는 근거가 "출력이 멎었다" 하나였고
// (`idle >= 60초 → 조용함`), 그래서 **3분짜리 빌드가 "기다립니다" 알림**이 됐다. 이제는 CLI 가
// 훅으로 자기 상태를 직접 말한다(shared/agentStatus.ts) — 침묵은 이 파일의 입력이 아니다.
// 못 들었으면 `unverifiable` 이라고 말하지, 조용하다고 해석하지 않는다.

/** 세션 목록 조회 주기. 로컬 IPC 라 싸다(원격에 나가는 것이 아니다). 상태 자체는 폴링이 아니라 훅 push 다. */
export const POLL_MS = 5_000

export type AiRun = {
  sessionId: string
  cli: AiCliId
  /** 실행한 폴더 — 같은 서버에 여러 개를 띄우는 일이 흔해서 구분에 필요하다. */
  path: string
  startedAt: number
}

/** 훅이 말해 준 상태 넷 + 세션이 사라진 자리. */
export type AiState = AgentState | 'gone'

export type AiSessionView = {
  run: AiRun
  /** 세션이 살아 있으면 그 메타, 끝났으면 null. */
  session: Session | null
  state: AiState
  /**
   * 이 상태가 시작된 시각(gone 은 실행 시작 시각 — 목록에서 걷어낼 시점을 그걸로 잰다).
   * 알림 id 가 이 값으로 만들어지므로(`notifyTag`) 같은 상태가 이어지는 동안 알림은 하나다.
   */
  stateStartedAt: number
  /** 훅이 아니라 우리가 주장한 상태다 — **나이와 무관하게 신선하지 않다.** 알림이 이걸 안 믿는다. */
  unconfirmed: boolean
  serverName: string
}

/**
 * 실행 기록 + 세션 목록 + **훅이 말해 준 상태** → 화면이 그릴 것.
 * 순수 함수라 단위 테스트 대상이다 — 여기서 틀리면 화면이 조용히 거짓말을 한다.
 *
 * 🔴 **목록에 있고 없고를 정하는 것은 훅이다.** 예전에는 `runs`(= 우리가 띄운 것)만 훑었고,
 * 그래서 준영님이 터미널에 직접 `claude` 를 치면 **훅은 그 세션의 상태를 받고 있는데 목록에는
 * 안 보였다**. 실행 기록은 이제 "있으면 더 잘 아는 것"(어느 CLI 를 어느 폴더에서 띄웠나)이지
 * 목록의 자격 요건이 아니다 — 자격은 **말을 걸어 온 세션 전부**다.
 */
// `now` 를 안 받는다: 상태의 나이는 **화면이 그릴 때** 재면 되고, 여기서 미리 빼 두면 그 값이
// 다음 틱까지 낡은 채 남는다. 무엇보다 이 함수가 시각을 안 보는 것이 곧 "침묵은 입력이 아니다"다.
export function viewsOf(
  runs: readonly AiRun[],
  sessions: readonly Session[],
  statuses: readonly AgentStatus[]
): AiSessionView[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const runOf = new Map(runs.map((r) => [r.sessionId, r]))
  const statusOf = new Map(statuses.map((s) => [s.sessionId, s]))
  return [...new Set([...runOf.keys(), ...statusOf.keys()])].map((sessionId) => {
    const session = byId.get(sessionId) ?? null
    const st = statusOf.get(sessionId)
    // 실행 기록이 없는 세션 = **우리가 안 띄운 것.** 훅과 세션이 아는 만큼만 채운다:
    // CLI 는 훅이 말했고(어느 표를 태워 왔나) 폴더·이름은 그 터미널이 안다.
    const run: AiRun = runOf.get(sessionId) ?? {
      sessionId,
      cli: st?.cli ?? 'claude',
      path: session?.cwd ?? '',
      // 언제 시작했는지는 모른다 — **처음 들은 때**가 우리가 아는 가장 이른 시각이다.
      startedAt: st?.stateStartedAt ?? 0
    }
    if (!session) {
      // 세션이 사라졌다 = CLI 도 끝났다. 목록에서 바로 지우지 않고 잠깐 남긴다 —
      // "방금 끝났다"도 알고 싶은 정보다(끝난 걸 모르고 기다리는 일이 없게).
      return { run, session: null, state: 'gone' as const, stateStartedAt: run.startedAt, unconfirmed: false, serverName: '' }
    }
    return {
      run,
      session,
      // 한 마디도 못 들었으면 **모르는 것이다.** 훅이 안 깔렸거나 훅 없는 CLI 일 수 있다 —
      // 옛 60초 규칙으로 되돌아가지 않는다(그 판정이 이 기능을 못 믿게 만들었다).
      state: st?.state ?? 'unverifiable',
      stateStartedAt: st?.stateStartedAt ?? run.startedAt,
      unconfirmed: st?.restoredUnconfirmed === true,
      serverName: session.serverKey || session.title
    }
  })
}

/**
 * 볼 이유가 있는 것이 위로. **기다리는 것 → 끝난 것 → 도는 것 → 모르는 것 → 사라진 것.**
 *
 * `unverifiable` 을 위로 올리지 않는 이유: 훅이 없는 CLI 는 늘 거기 있어서, 위로 올리면 목록
 * 꼭대기가 "모르겠다"로 가득 차 정작 나를 부르는 둘을 밀어낸다.
 */
const RANK: Record<AiState, number> = { waiting: 0, done: 1, working: 2, unverifiable: 3, gone: 4 }

export function sortViews(views: readonly AiSessionView[]): AiSessionView[] {
  // 같은 상태끼리는 **오래된 것이 위로** — 5분째 기다리는 것이 방금 물어본 것보다 급하다.
  return [...views].sort((a, b) => RANK[a.state] - RANK[b.state] || a.stateStartedAt - b.stateStartedAt)
}

/** 액티비티 바 점·알림 판정 — **나를 기다리는 것**이 몇인가. */
export function waitingCount(views: readonly AiSessionView[]): number {
  return views.filter((v) => v.state === 'waiting').length
}

// ── 실행 기록(모듈 스코프) ────────────────────────────────────────────────────
// 왜 영속화하지 않나: 앱을 껐다 켜면 우리 세션이 사라지고, 그 세션에 붙어 있던 CLI 도 우리 손을
// 떠난다(tmux 를 쓰지 않기로 했다 — 2026-08-12). 살아 있지도 않은 것을 목록에 남기면 거짓말이다.

const runs = new Map<string, AiRun>()
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((f) => f())

export function registerAiRun(run: AiRun): void {
  runs.set(run.sessionId, run)
  emit()
}

/** 세션이 끝난 뒤 일정 시간이 지나면 목록에서 뺀다(호출측이 정리 시점을 정한다). */
export function forgetAiRun(sessionId: string): void {
  if (runs.delete(sessionId)) emit()
}

export function aiRuns(): AiRun[] {
  return [...runs.values()]
}

/** 끝난 지 오래된 기록을 걷어낸다 — "끝남" 이 영원히 남지 않게. */
export const GONE_KEEP_MS = 5 * 60_000

export function useAiSessions(active: boolean) {
  const [views, setViews] = useState<AiSessionView[]>([])

  const tick = useCallback(async () => {
    const list = aiRuns()
    const statuses = agentStatuses()
    // 둘 다 비어야 볼 것이 없다 — **훅만 말해 준 세션**이 여기서 잘려 나가던 자리다.
    if (list.length === 0 && statuses.length === 0) {
      setViews([])
      return
    }
    const sessions = (await window.ev?.session.list()) ?? []
    const now = Date.now()
    const next = sortViews(viewsOf(list, sessions, statuses))
    // 끝난 지 오래된 것은 기록에서도 지운다. 상태 사본도 함께 — main 은 세션이 끝날 때
    // 자기 원장에서 지우지만(index.ts 의 `agent.server.forget`) 그 사실을 밀어 주지는 않아,
    // 여기서 안 지우면 죽은 세션의 상태가 렌더러 캐시에 영영 남는다.
    const stale = (v: AiSessionView): boolean => v.state === 'gone' && now - v.stateStartedAt > GONE_KEEP_MS
    for (const v of next) {
      if (!stale(v)) continue
      forgetAiRun(v.run.sessionId)
      forgetAgentStatus(v.run.sessionId)
    }
    setViews(next.filter((v) => !stale(v)))
  }, [])

  useEffect(() => {
    // 패널이 닫혀 있어도 돈다 — 액티비티 바 점과 알림이 그 결과를 쓴다(그게 이 기능의 목적이다).
    void tick()
    // 폴링은 **세션 목록**을 위한 것이다(탭이 사라진 것을 알아야 gone 을 그린다). 상태는 훅이
    // 도착하는 즉시 온다 — 그래서 "화면은 즉시"가 성립한다.
    const t = setInterval(() => void tick(), POLL_MS)
    const offAgent = subscribeAgent(() => void tick())
    listeners.add(tick)
    return () => {
      clearInterval(t)
      offAgent()
      listeners.delete(tick)
    }
  }, [tick, active])

  return views
}
