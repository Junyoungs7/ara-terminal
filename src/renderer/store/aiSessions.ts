import { useCallback, useEffect, useState } from 'react'
import type { AiCliId } from '@shared/aiCli'
import type { Session } from '@shared/types'

// F30 AI 세션 패널 — "지금 어느 AI 가 나를 기다리나".
//
// 준영님 요청(2026-08-12): 서버 3대에 Claude Code 를 띄워 두면 어느 놈이 승인을 기다리며 멈춰
// 있는지 알 수 없다. 탭을 하나씩 눌러 보다가 "10분째 물어보고 있었네"가 된다.
//
// **판정 근거는 "출력이 멎었다" 하나뿐이다.** 승인 대기일 수도, 오래 걸리는 빌드일 수도 있다 —
// 둘을 가를 방법이 마땅치 않다(원격 프로세스 상태를 봐도 대기와 수면이 안 갈린다).
// 그래서 화면은 **관측한 사실만** 말한다: "조용함 2분". "기다립니다"라고 확신하는 척했다가 한 번
// 틀리면 그다음부터 이 표시를 아무도 안 믿는다 — 그러면 기능이 죽는다.

/** 이만큼 출력이 없으면 "조용함". 빌드·테스트가 30~60초 조용한 건 흔하고, 진짜 승인 대기는 분 단위다. */
export const QUIET_MS = 60_000
/** 활동 조회 주기. 로컬 IPC 라 싸다(원격에 나가는 것이 아니다). */
export const POLL_MS = 5_000

export type AiRun = {
  sessionId: string
  cli: AiCliId
  /** 실행한 폴더 — 같은 서버에 여러 개를 띄우는 일이 흔해서 구분에 필요하다. */
  path: string
  startedAt: number
}

export type AiState = 'quiet' | 'busy' | 'gone'

export type AiSessionView = {
  run: AiRun
  /** 세션이 살아 있으면 그 메타, 끝났으면 null. */
  session: Session | null
  state: AiState
  /** 조용해진 지 몇 ms — busy 면 0, gone 이면 끝난 뒤 경과. */
  quietMs: number
  serverName: string
}

/**
 * 실행 기록 + 세션 목록 + 마지막 출력 시각 → 화면이 그릴 것.
 * 순수 함수라 단위 테스트 대상이다 — 여기서 틀리면 화면이 조용히 거짓말을 한다.
 */
export function viewsOf(
  runs: readonly AiRun[],
  sessions: readonly Session[],
  activity: readonly { id: string; lastDataAt: number }[],
  now: number,
  quietMs: number = QUIET_MS
): AiSessionView[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const lastAt = new Map(activity.map((a) => [a.id, a.lastDataAt]))
  return runs.map((run) => {
    const session = byId.get(run.sessionId) ?? null
    if (!session) {
      // 세션이 사라졌다 = CLI 도 끝났다. 목록에서 바로 지우지 않고 잠깐 남긴다 —
      // "방금 끝났다"도 알고 싶은 정보다(끝난 걸 모르고 기다리는 일이 없게).
      return { run, session: null, state: 'gone' as const, quietMs: now - run.startedAt, serverName: '' }
    }
    const last = lastAt.get(run.sessionId) ?? run.startedAt
    const idle = Math.max(0, now - last)
    return {
      run,
      session,
      state: idle >= quietMs ? ('quiet' as const) : ('busy' as const),
      quietMs: idle,
      serverName: session.serverKey || session.title
    }
  })
}

/** 조용한 것부터, 그다음 오래 조용한 순. 볼 이유가 있는 것이 위로 온다. */
export function sortViews(views: readonly AiSessionView[]): AiSessionView[] {
  const rank = (v: AiSessionView) => (v.state === 'quiet' ? 0 : v.state === 'busy' ? 1 : 2)
  return [...views].sort((a, b) => rank(a) - rank(b) || b.quietMs - a.quietMs)
}

/** 액티비티 바 점·알림 판정 — 조용한 것이 하나라도 있나. */
export function quietCount(views: readonly AiSessionView[]): number {
  return views.filter((v) => v.state === 'quiet').length
}

/** "2분" · "1시간 5분". 초 단위는 보여 주지 않는다(1분 미만은 애초에 quiet 이 아니다). */
export function durationText(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}분`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
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
    if (list.length === 0) {
      setViews([])
      return
    }
    const [sessions, activity] = await Promise.all([
      window.ev?.session.list() ?? Promise.resolve([]),
      window.ev?.session.activity?.() ?? Promise.resolve([])
    ])
    const now = Date.now()
    const next = sortViews(viewsOf(list, sessions, activity, now))
    // 끝난 지 오래된 것은 기록에서도 지운다.
    for (const v of next) {
      if (v.state === 'gone' && v.quietMs > GONE_KEEP_MS) forgetAiRun(v.run.sessionId)
    }
    setViews(next.filter((v) => !(v.state === 'gone' && v.quietMs > GONE_KEEP_MS)))
  }, [])

  useEffect(() => {
    // 패널이 닫혀 있어도 돈다 — 액티비티 바 점과 알림이 그 결과를 쓴다(그게 이 기능의 목적이다).
    void tick()
    const t = setInterval(() => void tick(), POLL_MS)
    const off = () => clearInterval(t)
    listeners.add(tick)
    return () => {
      off()
      listeners.delete(tick)
    }
  }, [tick, active])

  return views
}
