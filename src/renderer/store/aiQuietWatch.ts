import { useEffect, useRef } from 'react'
import { notifyTag } from '@shared/agentStatus'
import { useAiSessions, waitingCount } from './aiSessions'
import { t } from '../i18n'

/**
 * AI 감시(#132 · F1a) — **화면 없는 감시자.**
 *
 * F30 은 이 일을 우측 레일 패널 안에서 했다. 그 패널은 사이드바 [AI] 작업대 목록으로 흡수됐지만
 * **감시는 남아야 한다**: 이 기능의 목적이 "패널을 안 보고 있어도 나를 부르는 AI 를 알아채는 것"이라
 * 화면과 함께 지우면 목적째 사라진다(패널이 닫혀 있어도 돌던 이유가 그것이다).
 *
 * **F1a 에서 울리는 조건이 바뀌었다**: 예전에는 "60초 조용함"이었고 그래서 긴 빌드마다 울렸다.
 * 이제는 CLI 가 훅으로 `waiting`(권한·질문)이라고 **말했을 때만** 울린다.
 */

/**
 * 알림만 늦춘다 — **화면은 즉시**(orca-analysis §3 값싼 것 c).
 *
 * 잠깐 `waiting` 을 찍고 스스로 이어 가는 CLI 가 자기 알림을 취소하게 된다. 화면은 그 깜빡임을
 * 그대로 그려도 되지만(보다가 사라지는 것은 값이 싸다) 알림은 한 번 뜨면 사람이 치워야 한다.
 */
export const NOTIFY_DELAY_MS = 1_500

export function useAiQuietWatch(onGoTo: (sessionId: string) => void): { quiet: number; quietIds: Set<string> } {
  // 항상 돈다(true) — 볼 사람이 없어도 세는 것이 이 물건의 일이다.
  const views = useAiSessions(true)
  // 예약된 알림(태그 → 타이머)과 이미 울린 것(태그). **태그는 상태가 시작된 시각을 담으므로**
  // 같은 대기 한 번에 알림도 한 번이고, 다음 대기는 새 태그라 다시 울린다 — 중복 제거 표가 없다.
  const pending = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const fired = useRef<Set<string>>(new Set())

  useEffect(() => {
    const want = new Map<string, { tag: string; serverName: string; cli: string; sessionId: string }>()
    for (const v of views) {
      // 우리가 주장한 상태(unconfirmed)로는 울리지 않는다 — 훅이 말해 준 것만 사람을 부른다.
      if (v.state !== 'waiting' || v.unconfirmed) continue
      const tag = notifyTag({ sessionId: v.run.sessionId, stateStartedAt: v.stateStartedAt })
      want.set(tag, { tag, serverName: v.serverName, cli: v.run.cli, sessionId: v.run.sessionId })
    }
    // 더 이상 기다리지 않는 것의 예약은 취소한다(그 CLI 가 스스로 이어 갔다).
    for (const [tag, timer] of pending.current) {
      if (want.has(tag)) continue
      clearTimeout(timer)
      pending.current.delete(tag)
    }
    for (const [tag, v] of want) {
      if (pending.current.has(tag) || fired.current.has(tag)) continue
      pending.current.set(
        tag,
        setTimeout(() => {
          pending.current.delete(tag)
          fired.current.add(tag)
          // **앱이 뒤에 있을 때만.** 앞에 있으면 점으로 충분하고, 알림이 겹치기 시작하면
          // 그때부터 전부 무시하게 된다.
          if (document.hasFocus()) return
          try {
            const n = new Notification(t('aisess.notify.title').replace('{s}', v.serverName).replace('{c}', v.cli), {
              body: t('aisess.notify.body'),
              // 같은 대기의 반복 이벤트를 OS 가 알림 하나로 합쳐 준다.
              tag
            })
            n.onclick = () => onGoTo(v.sessionId)
          } catch {
            // 알림 권한이 없거나 OS 가 막은 환경 — 목록의 점은 그대로 돈다.
          }
        }, NOTIFY_DELAY_MS)
      )
    }
  }, [views, onGoTo])

  // 창을 닫을 때 예약을 남기지 않는다(사라진 화면이 뒤늦게 알림을 띄우면 안 된다).
  useEffect(() => {
    const timers = pending.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // 사이드바 계약은 그대로다(`quiet`/`quietIds`) — 그 화면의 어휘를 바꾸는 것은 별도 라운드다.
  // 바뀐 것은 **무엇이 그 집합에 드는가**뿐이다: 조용한 것이 아니라 **나를 기다리는 것**.
  const quietIds = new Set(views.filter((v) => v.state === 'waiting').map((v) => v.run.sessionId))
  return { quiet: waitingCount(views), quietIds }
}
