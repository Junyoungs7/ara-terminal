// M11 깨어있기 — 에이전트가 일하는 동안 PC 절전을 막는다(설정 › 에이전트: 끔 / 에이전트가 일할 때만 / 항상).
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/agent-awake-service.ts·agent-awake-status-lease.ts·shared/computer-awake-mode.ts 의 핵심.
// 규칙(Orca 그대로): 'on' = 늘 막음, 'auto' = 이번 실행에서 본 '일하는 중' 탭이 하나라도 있으면 막음, 2시간 넘게 소식이 없는 '일하는 중'은 셈에서 뺀다
// (끊긴 훅 때문에 밤새 켜 두지 않게). 막는 방법은 Electron powerSaveBlocker('prevent-display-sleep'), 컴퓨터가 깨어나면 다시 맞춘다.
// 뺀 것: macOS caffeinate·Linux 덮개 잠금 어서션(사내 PC 는 Windows — 셋 다 powerSaveBlocker 로 막는다), 상태바 표시(Orca Caffeinate 는 '보류').
// Windows 덮개 닫힘 절전은 막지 않는다 — Orca 주석: 그건 사용자 전원 계획(전역 설정)을 바꿔야 한다(PC 침범 금지).

import { isAwakeMode, type AwakeMode } from '@shared/agents'

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}
type ResumeSource = { on: (event: 'resume', listener: () => void) => void; off: (event: 'resume', listener: () => void) => void }

export type AgentAwake = {
  setMode(mode: AwakeMode): void
  /** 탭 하나의 상태가 바뀔 때(main 상태 원장 push). working 이면 지금 시각으로 갱신, 아니면 셈에서 뺀다. */
  observe(sessionId: string, working: boolean): void
  /** 탭이 끝났다. */
  forget(sessionId: string): void
  readonly active: boolean
  dispose(): void
}

export function createAgentAwake(deps: { blocker: PowerSaveBlocker; powerMonitor?: ResumeSource | null; now?: () => number; log?: (m: string) => void }): AgentAwake {
  const now = deps.now ?? Date.now
  let mode: AwakeMode = 'off'
  let blockerId: number | null = null
  const working = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const eligible = (): number => {
    const t = now()
    let n = 0
    for (const at of working.values()) if (t - at <= AGENT_AWAKE_STATUS_STALE_AFTER_MS) n++
    return n
  }
  const isStarted = (): boolean => {
    if (blockerId === null) return false
    try {
      if (deps.blocker.isStarted(blockerId)) return true
    } catch {
      return true // 모르면 켜진 것으로(Orca reconcileBlocker)
    }
    blockerId = null
    return false
  }
  // 가장 이른 만료에 한 번 다시 본다(2시간 침묵한 '일하는 중'을 빼려고).
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    const t = now()
    let next: number | null = null
    for (const at of working.values()) {
      const exp = at + AGENT_AWAKE_STATUS_STALE_AFTER_MS
      if (exp > t) next = next === null ? exp : Math.min(next, exp)
    }
    if (next === null) return
    timer = setTimeout(refresh, next - t + 1)
    timer.unref?.()
  }
  function refresh(): void {
    const block = mode === 'on' || (mode === 'auto' && eligible() > 0)
    if (block && !isStarted()) {
      try {
        blockerId = deps.blocker.start('prevent-display-sleep')
      } catch (e) {
        deps.log?.(`awake start failed: ${String(e)}`)
      }
    } else if (!block && blockerId !== null) {
      try {
        deps.blocker.stop(blockerId)
      } catch (e) {
        deps.log?.(`awake stop failed: ${String(e)}`)
      }
      isStarted()
      blockerId = null
    }
    schedule()
  }
  const onResume = (): void => refresh()
  deps.powerMonitor?.on('resume', onResume)

  return {
    setMode(next) {
      if (!isAwakeMode(next) || next === mode) return
      mode = next
      refresh()
    },
    observe(id, isWorking) {
      const had = working.has(id)
      if (isWorking) working.set(id, now())
      else working.delete(id)
      if (isWorking || had) refresh()
    },
    forget(id) {
      if (working.delete(id)) refresh()
    },
    get active() {
      return isStarted()
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      deps.powerMonitor?.off('resume', onResume)
      mode = 'off'
      working.clear()
      refresh()
    }
  }
}
