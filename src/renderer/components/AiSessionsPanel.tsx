import { useEffect, useRef } from 'react'
import { IconClose } from './icons'
import { t } from '../i18n'
import { durationText, quietCount, useAiSessions, type AiSessionView } from '../store/aiSessions'

// F30 AI 세션 패널 — 준영님 요청(2026-08-12): 서버 여러 대에 AI CLI 를 띄워 두면 어느 놈이
// 나를 기다리는지 모른다. 목업 D안 확정(mockups/ai-sessions.png).
//
// 문구가 "기다립니다"가 아니라 "조용합니다"인 것은 실수가 아니다 — 우리는 대기를 확신할 수 없고,
// 확신하는 척했다가 한 번 틀리면 그다음부터 아무도 이 표시를 안 믿는다(store/aiSessions.ts 머리주석).

function stateText(v: AiSessionView): string {
  if (v.state === 'gone') return t('aisess.state.gone').replace('{d}', durationText(v.quietMs))
  if (v.state === 'quiet') return t('aisess.state.quiet').replace('{d}', durationText(v.quietMs))
  return t('aisess.state.busy')
}

export function AiSessionsPanel({
  open,
  onClose,
  onGoTo,
  onQuietChange,
  onQuietIds
}: {
  open: boolean
  onClose: () => void
  /** 행을 누르면 그 세션 탭으로 간다. */
  onGoTo: (sessionId: string) => void
  /** 액티비티 바 점을 켜고 끄기 위해 조용한 개수를 위로 올린다. */
  onQuietChange: (n: number) => void
  /**
   * #129: 어느 세션이 조용한가 — 사이드바 [AI] 작업대 목록이 같은 값을 쓴다.
   * 판정을 두 곳에서 따로 하면 같은 세션을 두고 한쪽은 노랑, 한쪽은 초록이 된다.
   */
  onQuietIds: (ids: Set<string>) => void
}) {
  // 패널이 닫혀 있어도 센다 — 그래야 액티비티 바 점과 알림이 돈다(이 기능의 목적이 그것이다).
  const views = useAiSessions(open)
  const quiet = quietCount(views)
  const notifiedRef = useRef<Set<string>>(new Set())

  useEffect(() => onQuietChange(quiet), [quiet, onQuietChange])

  // 조용한 세션 id 묶음. 내용이 같으면 새 Set 을 올리지 않는다(위쪽이 매 5초 다시 그리면 안 된다).
  const quietKey = views
    .filter((v) => v.state === 'quiet')
    .map((v) => v.run.sessionId)
    .sort()
    .join(',')
  useEffect(() => {
    onQuietIds(new Set(quietKey === '' ? [] : quietKey.split(',')))
  }, [quietKey, onQuietIds])

  // OS 알림 — **앱이 뒤에 있을 때만.** 앞에 있으면 점으로 충분하고, 알림이 겹치기 시작하면
  // 그때부터 전부 무시하게 된다. 세션당 한 번만 띄운다(조용한 동안 5초마다 울리면 안 된다).
  useEffect(() => {
    for (const v of views) {
      if (v.state !== 'quiet') {
        notifiedRef.current.delete(v.run.sessionId)
        continue
      }
      if (notifiedRef.current.has(v.run.sessionId)) continue
      notifiedRef.current.add(v.run.sessionId)
      if (document.hasFocus()) continue
      try {
        new Notification(t('aisess.notify.title').replace('{s}', v.serverName).replace('{c}', v.run.cli), {
          body: t('aisess.notify.body').replace('{d}', durationText(v.quietMs))
        }).onclick = () => onGoTo(v.run.sessionId)
      } catch {
        // 알림 권한이 없거나 OS 가 막은 환경 — 패널과 점은 그대로 돈다.
      }
    }
  }, [views, onGoTo])

  if (!open) return null

  // 서버별로 묶어 보여 준다 — 같은 서버에 여러 개를 띄우는 일이 흔하다.
  const groups = new Map<string, AiSessionView[]>()
  for (const v of views) {
    const key = v.serverName || t('aisess.gone.server')
    const list = groups.get(key) ?? []
    list.push(v)
    groups.set(key, list)
  }

  return (
    <div className="monitor-panel aisess">
      <div className="mon-head">
        <span className="mon-name">{t('aisess.title')}</span>
        {quiet > 0 && <span className="aisess-cnt">{t('aisess.count').replace('{n}', String(quiet))}</span>}
        <span className="mon-close" title={t('aisess.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>

      <div className="aisess-body">
        {views.length === 0 && <div className="aisess-empty">{t('aisess.empty')}</div>}
        {[...groups.entries()].map(([server, list]) => (
          <div key={server}>
            <div className="aisess-grp">{server}</div>
            {list.map((v) => (
              <div
                className={'aisess-row ' + v.state}
                key={v.run.sessionId}
                onClick={() => v.session && onGoTo(v.run.sessionId)}
                title={v.run.path}
              >
                <span className={'dot ' + v.state} aria-hidden />
                <span className="aisess-main">
                  <span className="aisess-cli">{v.run.cli}</span>
                  <span className="aisess-path">{v.run.path}</span>
                </span>
                <span className={'aisess-el' + (v.state === 'quiet' ? ' w' : '')}>{stateText(v)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 판정 근거를 숨기지 않는다 — 이 화면이 무엇을 보고 말하는지 알아야 믿을 수 있다. */}
      {views.length > 0 && <div className="aisess-foot">{t('aisess.basis')}</div>}
    </div>
  )
}
