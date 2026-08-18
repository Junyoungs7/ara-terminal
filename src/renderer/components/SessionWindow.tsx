// F32 세션 창 — 떼어낸 탭이 사는 별도 OS 창. 준영님 확정 구성("작업 창"):
// 탭바 · 분할 그리드 · 하단바 · 상태바. 연결 트리·아라·설정은 **없다** — 그것들은 본창에서 하고
// 이 창은 "이 서버를 보는 화면"에 집중한다(설정 드로어가 두 창에 동시에 뜨는 상태도 안 만든다).
//
// 화면 대부분을 `MainArea` 가 그대로 준다 — 그쪽 props 가 거의 다 optional 이라, 이 창에 없는
// 기능(연결 관리자·AI CLI·아라)은 그냥 안 넘기면 된다. 새 탭바·새 분할 그리드를 만들지 않는다.
//
// **꺼야 하는 것 둘**(detachedWinId 가 끈다): 부트 복원(또 돌면 세션이 두 벌) · 스냅샷 저장
// (이 창은 세션 일부만 보므로 그대로 저장하면 본창 것이 사라진다). MainArea 머리주석 참고.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MainArea, type MainAreaHandle } from './MainArea'
import { BottomPanel } from './BottomPanel'
import { PortMonitor } from './PortMonitor'
import { LogPanel } from './LogPanel'
import { SysMonitorPanel } from './SysMonitorPanel'
import { ServerTool } from './ServerTool'
import { useDialog } from './Dialog'
import { StatusBar } from './StatusBar'
import { useSessions } from '../store/sessions'
import { useTelemetry } from '../store/telemetry'
import { useStatsHistory } from '../store/sysMonitor'
import { BOTTOM_IDS, type BottomId } from '@shared/types'
import type { SessionWinTarget } from '@shared/sessionWin'
import { t } from '../i18n'

// 해시 계약은 shared 에 있다(main 도 같은 문자열로 창을 연다) — 여기서는 그대로 다시 내보낸다.
export { parseSessionWinHash, type SessionWinTarget } from '@shared/sessionWin'

export function SessionWindow({ target }: { target: SessionWinTarget }): JSX.Element {
  const sessions = useSessions(target.winId)
  const mainRef = useRef<MainAreaHandle>(null)
  const { ask, node: dialogNode } = useDialog()
  const [bottom, setBottom] = useState<BottomId | null>(null)
  const lastBottom = useRef<BottomId>('monitor')
  if (bottom) lastBottom.current = bottom
  const toggleBottomBar = useCallback(() => setBottom((cur) => (cur ? null : lastBottom.current)), [])

  const activeSession = useMemo(
    () => sessions.sessions.find((s) => s.id === sessions.activeId) ?? null,
    [sessions.sessions, sessions.activeId]
  )
  // 하단바는 **이 창의** 활성 세션을 따라간다. 폴링도 이 창 몫이다 — main 의 라우터가
  // telemetry:data 를 이 창으로 보내 준다(getWebContents(sessionId)).
  const telemetry = useTelemetry(activeSession?.id ?? null, activeSession?.type === 'ssh')
  // 그래프 이력은 [시스템 모니터] 탭이 열려 있을 때만 쌓는다(본창과 같은 규칙).
  const sysHistory = useStatsHistory(telemetry.stats, activeSession?.id ?? null, bottom === 'sys')

  // 창 제목 = 보고 있는 세션. 작업표시줄에서 어느 서버 창인지 구분되는 유일한 단서다.
  useEffect(() => {
    document.title = activeSession ? `${activeSession.serverKey} — ${activeSession.title}` : t('app.name')
  }, [activeSession])

  // 마지막 세션이 이 창을 떠나면(되돌리기·종료) 빈 창이 남는다 — 스스로 닫는다.
  const had = useRef(false)
  useEffect(() => {
    if (sessions.sessions.length > 0) had.current = true
    else if (had.current) void window.ev?.window.close()
  }, [sessions.sessions.length])

  return (
    <div className="app sessionwin">
      <div className="middle">
        <MainArea
          ref={mainRef}
          sessions={sessions}
          detachedWinId={target.winId}
          version=""
          ask={ask}
          bottom={
            <BottomPanel
              tab={bottom}
              onTab={setBottom}
              onClose={() => setBottom(null)}
              ids={BOTTOM_IDS}
              server={activeSession?.type === 'ssh' ? (activeSession?.serverKey ?? '') : ''}
            >
              {(id, active) =>
                id === 'monitor' ? (
                  <PortMonitor
                    ports={telemetry.ports}
                    forwards={telemetry.forwards}
                    sessionId={activeSession?.id ?? null}
                    isSsh={activeSession?.type === 'ssh'}
                    onRefresh={telemetry.refresh}
                    onForwardsChanged={telemetry.refreshForwards}
                  />
                ) : id === 'sys' ? (
                  <SysMonitorPanel
                    open={active}
                    embedded
                    onClose={() => setBottom(null)}
                    sessionId={activeSession?.id ?? null}
                    isSsh={activeSession?.type === 'ssh'}
                    serverName={activeSession?.title ?? ''}
                    stats={telemetry.stats}
                    history={sysHistory}
                  />
                ) : id === 'log' ? (
                  <LogPanel
                    open={active}
                    embedded
                    onClose={() => setBottom(null)}
                    sessionId={activeSession?.id ?? null}
                    sessionTitle={activeSession?.title ?? ''}
                  />
                ) : (
                  <ServerTool
                    id={id}
                    active={active}
                    sessionId={activeSession?.type === 'ssh' ? (activeSession?.id ?? null) : null}
                    isSsh={activeSession?.type === 'ssh'}
                    server={activeSession?.type === 'ssh' ? activeSession.serverKey : undefined}
                    ask={ask}
                    // 이 창에는 아라도 작업대도 없다(준영님 확정 구성) — 그 둘로 가는 길은
                    // 본창에 있다. 여기서 흉내 내지 않고 아무 일도 하지 않는다.
                    onAskAi={() => {}}
                    onOpenExplorer={() => {}}
                    onSendInput={(text: string) => {
                      const sid = activeSession?.id
                      if (sid) window.ev?.session.input(sid, text)
                    }}
                  />
                )
              }
            </BottomPanel>
          }
        />
        {/* 하단바 토글 — 본창 액티비티 바의 그 버튼과 같은 자리·같은 클래스(누르는 손이 헷갈리지
            않게). 이 창에는 다른 액티비티 항목이 없으므로 바에 이것 하나만 산다. */}
        <div className="activity-bar" role="tablist" aria-label={t('activity.bar.label')}>
          <button
            type="button"
            className={'act-item act-bottombar' + (bottom ? ' active' : '')}
            aria-pressed={bottom !== null}
            title={t('bottom.bar.toggle')}
            data-activity="bottombar"
            onClick={toggleBottomBar}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 15h18" />
            </svg>
          </button>
        </div>
      </div>
      {/* 상태바 — 지금 붙어 있는 곳과 자원. 연결 프로필 목록은 이 창에 없으므로(본창 것이다)
          호스트 표기는 serverKey 로 떨어진다 — statusModel 이 그 폴백을 이미 갖고 있다. */}
      <StatusBar
        version=""
        session={activeSession}
        profile={undefined}
        conn={{}}
        cwd={null}
        sessionCount={sessions.sessions.length}
        stats={telemetry.stats}
      />
      {dialogNode}
    </div>
  )
}
