import { useEffect, useRef } from 'react'
import { durationText, quietCount, useAiSessions } from './aiSessions'
import { t } from '../i18n'

/**
 * 조용한 AI 감시(#132) — **화면 없는 감시자.**
 *
 * F30 은 이 일을 우측 레일 패널 안에서 했다. 그 패널은 사이드바 [AI] 작업대 목록으로 흡수됐지만
 * **감시는 남아야 한다**: 이 기능의 목적이 "패널을 안 보고 있어도 조용한 AI 를 알아채는 것"이라
 * 화면과 함께 지우면 목적째 사라진다(패널이 닫혀 있어도 돌던 이유가 그것이다).
 *
 * 그래서 로직만 떼어 Shell 이 항상 돌린다. 판정·문구는 store/aiSessions.ts 그대로다 —
 * 옮기면서 규칙을 바꾸지 않는다.
 */
export function useAiQuietWatch(onGoTo: (sessionId: string) => void): { quiet: number; quietIds: Set<string> } {
  // 항상 돈다(true) — 볼 사람이 없어도 세는 것이 이 물건의 일이다.
  const views = useAiSessions(true)
  const notifiedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const v of views) {
      if (v.state !== 'quiet') {
        notifiedRef.current.delete(v.run.sessionId)
        continue
      }
      if (notifiedRef.current.has(v.run.sessionId)) continue
      notifiedRef.current.add(v.run.sessionId)
      // **앱이 뒤에 있을 때만.** 앞에 있으면 점으로 충분하고, 알림이 겹치기 시작하면
      // 그때부터 전부 무시하게 된다. 세션당 한 번만(조용한 동안 5초마다 울리면 안 된다).
      if (document.hasFocus()) continue
      try {
        new Notification(t('aisess.notify.title').replace('{s}', v.serverName).replace('{c}', v.run.cli), {
          body: t('aisess.notify.body').replace('{d}', durationText(v.quietMs))
        }).onclick = () => onGoTo(v.run.sessionId)
      } catch {
        // 알림 권한이 없거나 OS 가 막은 환경 — 목록의 점은 그대로 돈다.
      }
    }
  }, [views, onGoTo])

  const quietIds = new Set(views.filter((v) => v.state === 'quiet').map((v) => v.run.sessionId))
  return { quiet: quietCount(views), quietIds }
}
