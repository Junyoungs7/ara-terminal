// F32 세션 창 — 떼어낸 탭이 사는 별도 OS 창. 준영님 확정 구성("작업 창"):
// 탭바 · 분할 그리드 · 하단바 · 상태바. 연결 트리·아라·설정은 **없다** — 그것들은 본창에서 하고
// 이 창은 "이 서버를 보는 화면"에 집중한다(설정 드로어가 두 창에 동시에 뜨는 상태도 안 만든다).
//
// 화면 대부분을 `MainArea` 가 그대로 준다 — 그쪽 props 가 거의 다 optional 이라, 이 창에 없는
// 기능(연결 관리자·AI CLI·아라)은 그냥 안 넘기면 된다. 새 탭바·새 분할 그리드를 만들지 않는다.
//
// **꺼야 하는 것 둘**(detachedWinId 가 끈다): 부트 복원(또 돌면 세션이 두 벌) · 스냅샷 저장
// (이 창은 세션 일부만 보므로 그대로 저장하면 본창 것이 사라진다). MainArea 머리주석 참고.
//
// **안 넣는 것 하나**(#201 A-5): `onResumeAi` — 끊김 카드의 [이어서 시작]. AI CLI 플래그와 최근
// 목록이 Shell 에 있고 F32 가 이 창에서 AI 를 뺐다. 게다가 이 창은 부트 복원을 안 하므로
// `PaneGrid` 의 `aiEnded` 카드가 뜰 일도 거의 없다 — 안 넘기면 그 버튼이 아예 안 그려진다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MainArea, type MainAreaHandle } from './MainArea'
import { BottomPanel } from './BottomPanel'
import { PortMonitor } from './PortMonitor'
import { LogPanel } from './LogPanel'
import { SysMonitorPanel } from './SysMonitorPanel'
import { ServerTool } from './ServerTool'
import { useDialog } from './Dialog'
import { useBugReport } from './BugReportModal'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { useSessions } from '../store/sessions'
import { connectErrorMessage, connectErrorTitle, useProfiles, type ConnectFailure } from '../store/profiles'
import { connectWithRecovery } from '../store/sshConnect'
import { sizeOf } from '../terminal/termRegistry'
import type { SshRestoreResult } from './MainArea'
import { useTelemetry } from '../store/telemetry'
import { useStatsHistory } from '../store/sysMonitor'
import { BOTTOM_IDS, type BottomId } from '@shared/types'
import { AppLogPanel } from './AppLogPanel'
import type { SessionWinTarget } from '@shared/sessionWin'
import { t } from '../i18n'
import { matchBinding } from '../../shared/keymap'

// 해시 계약은 shared 에 있다(main 도 같은 문자열로 창을 연다) — 여기서는 그대로 다시 내보낸다.
export { parseSessionWinHash, type SessionWinTarget } from '@shared/sessionWin'

export function SessionWindow({ target }: { target: SessionWinTarget }): JSX.Element {
  const sessions = useSessions(target.winId)
  const mainRef = useRef<MainAreaHandle>(null)
  const { ask, askText, node: dialogNode } = useDialog()
  // #206 오류 신고 — 이 창엔 메뉴바가 없어서 **단축키가 유일한 입구**다. 찍히는 것은 이 창이다
  // (main 이 부른 창을 찍는다). 터미널이 이 키를 삼키지 않는 것은 KEYMAP 의 isAppShortcut 덕이다.
  const bugReport = useBugReport()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchBinding(e, 'report.open')) return
      e.preventDefault()
      void bugReport.open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bugReport.open])
  // 프로필은 main 이 갖고 IPC 로 준다 — 렌더러 아무 창에서나 읽는다(연결 트리가 없는 것과 무관하다).
  const { profiles, lookup, connect } = useProfiles()
  const [bottom, setBottom] = useState<BottomId | null>(null)
  // [서버 로그] 탭이 세션마다 보고 있는 파일(본창 Shell.logPaths 와 같은 규칙).
  const [logPaths, setLogPaths] = useState<Record<string, string>>({})
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
  // 상태바 그래프가 늘 그려지므로 이력도 늘 쌓는다(본창과 같은 규칙 — 제보 ③).
  const sysHistory = useStatsHistory(telemetry.stats, activeSession?.id ?? null, true)

  // 앱 버전. 예전엔 `version=""` 을 넘겨 이 창의 상태바와 [정보]에 **`v` 만** 떴다(AUDIT-R2 ④).
  // 본창 Shell 과 같은 방식으로 main 에게 물어 온다 — 못 받으면 빈 문자열이고, 그때는 받는 쪽이
  // 줄 자체를 감춘다.
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.ev?.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  // 창 제목 = 보고 있는 세션. 작업표시줄에서 어느 서버 창인지 구분되는 유일한 단서다.
  useEffect(() => {
    document.title = activeSession ? `${activeSession.serverKey} — ${activeSession.title}` : t('app.name')
  }, [activeSession])

  // 마지막 세션이 이 창을 떠나면(되돌리기·종료) 빈 창이 남는다 — 스스로 닫는다.
  // (window:close 는 **부른 창**을 닫는다. 예전엔 무조건 본창을 닫아서 이 한 줄이 앱을 끝냈다.)
  const had = useRef(false)
  useEffect(() => {
    if (sessions.sessions.length > 0) had.current = true
    else if (had.current) void window.ev?.window.close()
  }, [sessions.sessions.length])

  /**
   * 창을 닫으려 하면 main 이 **막고** 물어 온다(준영님 제보 4번: "창 닫을 때 세션 목록·확인 팝업").
   * 무엇이 사라지는지 이름으로 보여 준다 — "세션 3개"만으로는 그게 지금 배포 돌리는 창인지 알 수 없다.
   * 취소는 아무 답도 보내지 않는다: main 은 이미 닫기를 막아 뒀으므로 창이 그대로 열려 있다.
   */
  const listRef = useRef(sessions.sessions)
  listRef.current = sessions.sessions
  useEffect(() => {
    return window.ev?.window.onCloseAsk?.(() => {
      void (async () => {
        const r = await ask({
          title: t('sessionwin.close.title'),
          message: t('sessionwin.close.msg'),
          detail: listRef.current.map((s) => ({ label: s.serverKey || t('sessionwin.close.local'), value: s.title })),
          tone: 'danger',
          confirmLabel: t('sessionwin.close.kill'),
          altLabel: t('sessionwin.close.toMain')
        })
        if (r === 'cancel') return
        await window.ev?.window.confirmClose(target.winId, r === 'confirm')
      })()
    })
  }, [ask, target.winId])

  /**
   * 접속 실패 안내 — **이 창 몫의 얇은 것**(#201 A-2).
   *
   * 본창의 `Shell.showConnectFailure` 에는 갈래가 둘 더 있다: 인증 실패면 [비밀번호 다시 입력]
   * (연결 관리자를 연다), 호스트키 불일치면 [호스트키 재설정]. **이 창엔 연결 관리자가 없다** —
   * 그래서 그 갈래를 뺀 것만 준다. 창마다 다른 것은 주입하고 같은 것(되묻는 순서)만 공유한다.
   *
   * ⚠️ **"어차피 못 여니 조용히"는 안 된다.** 사유를 안 보여 주면 이번 제보와 같은 병이 된다
   *    (눌렀는데 아무 일도 안 남). 못 고쳐 주더라도 무엇이 막았는지는 말한다.
   */
  const showFailure = useCallback(
    async (profileId: string, res: ConnectFailure) => {
      const p = await lookup(profileId)
      const detail: { label: string; value: string }[] = []
      if (p) detail.push({ label: t('conn.fail.server'), value: `${p.username}@${p.host}:${p.port}` })
      if ('message' in res) detail.push({ label: t('conn.fail.detail'), value: res.message })
      // 지문 둘은 불일치의 **본문**이다 — 얇게 만든다고 이걸 빼면 사람이 판단할 근거가 사라진다.
      if (res.reason === 'hostKeyMismatch') {
        detail.push({ label: t('conn.hostkey.saved'), value: res.knownFingerprint })
        detail.push({ label: t('conn.hostkey.received'), value: res.fingerprint })
      }
      await ask({
        title: connectErrorTitle(res),
        message: connectErrorMessage(res),
        detail,
        ...(res.reason === 'hostKeyMismatch' ? { tone: 'danger' as const } : {}),
        confirmLabel: t('dlg.ok'),
        cancelLabel: null
      })
    },
    [ask, lookup]
  )

  /**
   * [다시 접속] — 끊긴 SSH 를 되살린다(#201 A-2). **이 창에 없던 기능이다**: prop 을 안 넘겨
   * `MainArea` 가 `if (!err.profileId || !sshRestore) return` 으로 조용히 빠져나갔다 —
   * 버튼은 있는데 눌러도 토스트조차 안 떴다.
   *
   * 🔴 `winId` 를 싣는다. 안 실으면 새 세션이 **본창에** 뜬다(main 은 안 주면 본창으로 잡는다) —
   *    이 창에서 되살렸는데 저쪽에 나타나는 것이 A 의 진짜 첫 번째 결함이었다.
   * 🔴 실패는 `'shown'` 이다 — **화면 문구가 아니라 신호**(MainArea.tsx 의 `SshRestoreResult` 주석).
   *    `connectWithRecovery` 가 이미 화면으로 말했으니 호출측은 조용히 넘어가라는 뜻이고,
   *    `restore.reason.shown` 이라는 i18n 키는 없고 있으면 안 된다.
   */
  const sshRestore = useCallback(
    async (profileId: string, size?: { cols: number; rows: number }): Promise<SshRestoreResult> => {
      const res = await connectWithRecovery(
        { connect, lookup, ask, askText, showFailure },
        profileId,
        { size, winId: target.winId }
      )
      if (!res.ok) return { ok: false, reason: 'shown' }
      const p = await lookup(profileId)
      const name = p?.name ?? 'ssh'
      sessions.adopt(res.id, res.title ?? name, name, 'ssh', profileId)
      mainRef.current?.activateSession(res.id)
      return { ok: true, id: res.id }
    },
    [connect, lookup, ask, askText, showFailure, sessions, target.winId]
  )

  /**
   * 탭 [복제] — 같은 서버로 하나 더 붙는다. **이 창에서는 로컬 PowerShell 이 열렸다**(prop 을
   * 안 넘겨 `MainArea.duplicateSession` 의 `else void openLocal()` 로 빠졌다) — 안 되는 것보다
   * 나쁘다, 다른 일을 했다.
   *
   * 프로필을 **이름으로** 찾는 것은 `Shell.duplicateSession` 과 같은 규칙이다(serverKey = 프로필명).
   * 접속은 위 `sshRestore` 를 그대로 지난다 — 이 창에서 SSH 가 새로 뜨는 길을 둘로 만들지 않는다.
   * 치수는 지금 보고 있는 칸에서 잰다(#158 — 안 재면 첫 프롬프트가 80칸에서 접힌다).
   */
  const duplicateSession = useCallback(
    (session: { serverKey: string }) => {
      const p = profiles.find((x) => x.name === session.serverKey)
      if (p) void sshRestore(p.id, sizeOf(sessions.activeId) ?? undefined)
    },
    [profiles, sshRestore, sessions.activeId]
  )

  const winTitle = activeSession ? `${activeSession.serverKey} — ${activeSession.title}` : t('app.name')

  return (
    <div className="app sessionwin">
      {/* 2026-08-23 준영님 제보 5 — 이 창의 상단도 아라다(그전엔 OS 기본 프레임 + Electron 기본
          메뉴였다). 본창과 **같은 컴포넌트**를 쓰되 메뉴바·통합 검색은 넘기지 않는다: 이 창은
          "이 서버를 보는 화면"이라 그 둘이 할 일이 없다(F32 확정 구성). */}
      <TitleBar title={winTitle} />
      <div className="middle">
        <MainArea
          ref={mainRef}
          sessions={sessions}
          detachedWinId={target.winId}
          version={version}
          ask={ask}
          askText={askText}
          sshRestore={sshRestore}
          onDuplicateSession={duplicateSession}
          // 본창은 Shell 이 openBottom('log') 로 같은 탭을 연다 — 이 창에도 그 탭이 실재한다.
          onOpenLog={() => setBottom('log')}
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
                    loaded={telemetry.loaded}
                    forwards={telemetry.forwards}
                    sessionId={activeSession?.id ?? null}
                    isSsh={activeSession?.type === 'ssh'}
                    onRefresh={telemetry.refresh}
                    onForwardsChanged={telemetry.refreshForwards}
                    ask={ask}
                    onOpenLog={(path) => {
                      if (activeSession) {
                        setLogPaths((m) => ({ ...m, [activeSession.id]: path }))
                        setBottom('applog')
                      }
                    }}
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
                ) : id === 'applog' ? (
                  // 본창과 같은 탭이다(기능은 양쪽 같게 — 창을 뺐다고 도구가 줄면 안 된다).
                  <AppLogPanel
                    sessionId={activeSession?.id ?? null}
                    isSsh={activeSession?.type === 'ssh'}
                    path={(activeSession && logPaths[activeSession.id]) || null}
                    onOpen={(p) => activeSession && setLogPaths((m) => ({ ...m, [activeSession.id]: p }))}
                    onClose={() =>
                      activeSession &&
                      setLogPaths((m) => {
                        const next = { ...m }
                        delete next[activeSession.id]
                        return next
                      })
                    }
                    ask={ask}
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
        version={version}
        session={activeSession}
        profile={undefined}
        conn={{}}
        cwd={null}
        sessionCount={sessions.sessions.length}
        stats={telemetry.stats}
        history={sysHistory}
      />
      {dialogNode}
      {bugReport.node}
    </div>
  )
}
