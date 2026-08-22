import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '../store/sessions'
import { useTelemetry } from '../store/telemetry'
import { PortMonitor } from './PortMonitor'
import { useDialog } from './Dialog'
import { t } from '../i18n'

// 포트 모니터 독립 창 (2026-08-21 준영님 요청).
//
// 왜 진짜 창인가: **다른 모니터에 띄워 두고 보는** 용도라서다. 앱 안에 떠 있는 창(작업대·탐색기)
// 은 본창을 못 벗어나고 본창을 최소화하면 같이 숨는다 — 포트를 곁눈질하려고 여는 화면에는 안 맞는다.
//
// 창은 **하나**, 서버가 늘면 **탭**이 는다(준영님 확정). 그래서 창 자체엔 매개변수가 없고
// (`#portwin`) 어느 서버를 볼지는 여기서 고른다.
//
// 이 창은 세션을 **소유하지 않는다**(F32 SessionWindows 와 다른 점). 포트 목록은 읽기 화면이라
// 창이 죽어도 세션·포워딩은 그대로 산다. main 은 텔레메트리를 소유 창과 **함께** 이 창에도 보낸다
// (registerTelemetryIpc 의 alsoTo) — 그래서 본창과 같은 값을 같은 순간에 본다.
export function PortWindow() {
  const sessions = useSessions()
  // 포트 충돌을 물을 자리(제보 17). 이 창에도 다이얼로그가 필요해졌다 — 본창의 것을 빌려올 수 없다.
  const { ask, node: dialogNode } = useDialog()
  // SSH 세션만 대상이다 — 포트 목록은 원격 `ss` 출력이고 로컬 셸에는 그 개념이 없다.
  const sshSessions = useMemo(() => sessions.sessions.filter((s) => s.type === 'ssh'), [sessions.sessions])

  const [tabId, setTabId] = useState<string | null>(null)
  // 고르지 않았거나 보던 세션이 끊겼으면 첫 SSH 세션으로 떨어진다 — 빈 창을 남기지 않는다.
  const active = sshSessions.find((s) => s.id === tabId) ?? sshSessions[0] ?? null
  useEffect(() => {
    if (active && active.id !== tabId) setTabId(active.id)
  }, [active, tabId])

  // 보고 있는 탭 하나만 구독한다. 탭마다 폴러를 띄우면 서버 N 대에 2.5초 폴링이 N 벌 돈다 —
  // 안 보는 탭의 숫자를 최신으로 유지할 값어치가 없다(탭을 누르면 즉시 한 바퀴 돈다).
  const telemetry = useTelemetry(active?.id ?? null, true)

  useEffect(() => {
    document.title = active ? `${t('mon.title')} — ${active.title}` : t('mon.title')
  }, [active])

  return (
    <div className="app portwin">
      <div className="pw-tabs" role="tablist">
        {sshSessions.map((s) => {
          const on = s.id === active?.id
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={'pw-tab' + (on ? ' on' : '')}
              data-session={s.id}
              onClick={() => setTabId(s.id)}
            >
              <span className="dot" />
              {s.title}
            </button>
          )
        })}
        {sshSessions.length === 0 && <span className="pw-none">{t('portwin.noSsh')}</span>}
      </div>
      <div className="pw-body">
        {active ? (
          <PortMonitor
            ports={telemetry.ports}
            forwards={telemetry.forwards}
            sessionId={active.id}
            isSsh
            inWindow
            onRefresh={telemetry.refresh}
            onForwardsChanged={telemetry.refreshForwards}
            ask={ask}
          />
        ) : (
          // 접속한 SSH 세션이 없으면 보여 줄 것이 없다. 창을 닫으라고 하지 않는다 —
          // 본창에서 접속하면 탭이 저절로 생긴다.
          <div className="sftp-empty">{t('portwin.empty')}</div>
        )}
      </div>
      {dialogNode}
    </div>
  )
}
