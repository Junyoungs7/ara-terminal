import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { MainArea, type MainAreaHandle } from './MainArea'
import { MiniPreview } from './MiniPreview'
import { AiPanel } from './AiPanel'
import { AiBootstrapModal } from './AiBootstrapModal'
import { AiCliModal, type AiCliLaunchRequest } from './AiCliModal'
import { cliInstalled, ensureRemoteDir, waitShellReady } from './aiCliLaunch'
import { WorkProfileModal } from './WorkProfileModal'
import { ActivityBar } from './ActivityBar'
import { MonitorPanel } from './MonitorPanel'
import { LogPanel } from './LogPanel'
import { StatusBar } from './StatusBar'
import { McpIndicator } from './McpIndicator'
import { ConnectionModal, type ConnModalRequest } from './ConnectionModal'
import { ExplorerView } from './ExplorerView'
import { ServerConsoleView } from './ServerConsoleView'
import { CommandPalette } from './CommandPalette'
import { useDialog } from './Dialog'
import { useSessions } from '../store/sessions'
import { useProfiles, connectErrorTitle, connectErrorMessage, type ConnectFailure } from '../store/profiles'
import { clampSidebarWidth, useSidebar } from '../store/sidebar'
import { useWorkProfiles } from '../store/workProfiles'
import { useAiCliRecent } from '../store/aiCliRecent'
import { binOf } from '../../shared/aiCli'
import { useTelemetry } from '../store/telemetry'
import { useStatsHistory } from '../store/sysMonitor'
import { registerAiRun } from '../store/aiSessions'
import { AiSessionsPanel } from './AiSessionsPanel'
import { SysMonitorPanel } from './SysMonitorPanel'
import { groupsOf, noneGroup, useGroupList } from '../store/groups'
import { ACTIVITY_ITEMS, type ActivityId } from '../store/activityBar'
import type { TreeTarget } from './ConnTree'
import { cdCommand } from './filePath'
import type { MenuCommandId, TreeActionId } from '../interactions/actions'
import { dispatchAction, matchBinding } from '../../shared/keymap'
import { buildTmuxInput } from '../../shared/tmux'
import {
  MCP_AUTO_ALLOW_MINUTES,
  type ConnectionProfile,
  type WorkProfile,
  type McpApprovalDecision,
  type McpApprovalRequest,
  type SessionType
} from '@shared/types'
import { t } from '../i18n'

// 3행 그리드 앱 셸 (design-system §4.1): 타이틀바 / (사이드바+메인) / 상태바.
export function Shell() {
  // R4.3: 폭·접힘·활성 탭이 한 상태로 묶여 workspace.json 에 저장된다(그전엔 렌더러 지역 상태).
  const { sidebar, update: updateSidebar, preview: previewSidebar } = useSidebar()
  // 드래그 중에는 사이드바 폭 트랜지션을 끈다(0.22s ease 가 걸린 채로 끌면 폭이 커서를 따라오지 않는다).
  const [resizing, setResizing] = useState(false)
  const [version, setVersion] = useState('0.1.0')
  const [modalOpen, setModalOpen] = useState(false)
  // F15 우측 미니 프리뷰 레일(Ctrl+Shift+P · View 메뉴). 세션 수명 동안만 사는 토글이라
  // workspace.json 에 저장하지 않는다 — 모니터링용 임시 창이지 레이아웃 설정이 아니다.
  const [previewOpen, setPreviewOpen] = useState(false)
  // F16 아라 패널(Alt+A · 라디얼 [AI에게 질문] · 타이틀바). 미니 프리뷰와 같은 규칙으로 영속하지
  // 않는다 — 세션 수명 동안만 사는 토글이고, 상호 배타로 만들지도 않는다(둘 다 열려도 터미널이 남는다).
  const [aiOpen, setAiOpen] = useState(false)
  // 라디얼 [AI에게 질문] 이 넘긴 선택 텍스트. at 이 함께 와야 같은 문자열을 다시 골라도 반영된다.
  // autoSend: F17 부트스트랩 전용(조립된 질문을 즉시 보낸다 — AiPanel.prefill 참고).
  const [aiPrefill, setAiPrefill] = useState<{ text: string; at: number; autoSend?: boolean } | null>(null)
  // F17 AI 부트스트랩 폼. 열림 상태만 여기 있고, 폼 값은 모달 안에만 산다(경로·이름이 렌더러
  // 상태 트리 위로 올라오지 않는다 — F16 이 API 키를 다루는 것과 같은 절제).
  const [bootstrapOpen, setBootstrapOpen] = useState(false)
  // F27 AI CLI 시작 창. 진입점이 넷이라(탭바 ＋ · Ctrl+Shift+L · 폴더 우클릭 · 서버 우클릭) 열기만
  // 여기 모으고, 미리 채울 값은 prefill 하나로 받는다(at 은 같은 값으로 두 번 열어도 반영되게 하는
  // 표식 — aiPrefill·explorerReveal 과 같은 모양).
  const [aiCliOpen, setAiCliOpen] = useState(false)
  const [aiCliPrefill, setAiCliPrefill] = useState<{ profileId?: string; path?: string; at: number } | null>(null)
  const aiCliRecent = useAiCliRecent()
  const openAiCli = useCallback((pre?: { profileId?: string; path?: string }) => {
    setAiCliPrefill(pre ? { ...pre, at: Date.now() } : null)
    setAiCliOpen(true)
  }, [])
  // FB-ui2(FB-0007② 변경): [모니터] 우측 레일. 미니 프리뷰·아라 패널과 같은 규칙 — 세션 수명
  // 동안만 사는 토글이라 workspace.json 에 저장하지 않는다.
  const [monitorOpen, setMonitorOpen] = useState(false)
  // F29 시스템 모니터(자원 그래프). monitor(포트)와 별개 패널이라 동시에 열어 둘 수 있다.
  const [sysOpen, setSysOpen] = useState(false)
  // F30 AI 세션 패널 + 액티비티 바 점(조용한 AI 개수).
  const [aiSessOpen, setAiSessOpen] = useState(false)
  const [aiQuiet, setAiQuiet] = useState(0)
  const [logOpen, setLogOpen] = useState(false)
  // 작업 프로필(서버+폴더 즐겨찾기). 트리에 행을 만들지 않고 팝업 목록으로만 보여 준다.
  const [workOpen, setWorkOpen] = useState(false)
  const work = useWorkProfiles()
  // FB-ui2: 설정 창 열림 상태의 실제 주인은 MainArea(Ctrl+, keydown 이 거기 배선돼 있다) — 액티비티
  // 바의 활성 표시만을 위한 미러(MainArea.onSettingsOpenChange 가 채운다).
  const [settingsActive, setSettingsActive] = useState(false)
  // 우측 액티비티 바에 그릴 항목(설정에서 끄고 켜고 옮긴 결과). prefs 의 주인은 MainArea 라
  // 거기서 올려 준다 — settingsActive 미러와 같은 방식.
  const [activityItems, setActivityItems] = useState<ActivityId[]>(() => [...ACTIVITY_ITEMS])
  // W4sat F20: 탐색기 전체화면 모드. .middle 은 언마운트하지 않는다(display:none 만) — 터미널
  // 세션·레이아웃이 살아 있어야 나갈 때 보존된다(스펙 요구사항). 미니 프리뷰·아라 패널과 같은 규칙으로
  // 세션 수명 동안만 사는 토글이라 workspace.json 에 저장하지 않는다.
  const [explorerOpen, setExplorerOpen] = useState(false)
  // F26 R2: 디스크 창의 [탐색기로 열기]. 탐색기에 "이 서버의 이 폴더로 가라"를 한 번 건네는 신호다
  // (at 은 같은 경로를 두 번 눌러도 다시 열리게 하는 표식 — aiPrefill 과 같은 모양).
  const [explorerReveal, setExplorerReveal] = useState<{ profileId: string; path: string; at: number } | null>(null)
  // F26 서버 콘솔(런치패드 + 프로세스 창). 탐색기와 같은 떠 있는 창이라 같은 규칙 —
  // 세션 수명 동안만 사는 토글이라 workspace.json 에 저장하지 않는다.
  const [consoleOpen, setConsoleOpen] = useState(false)
  // F31 통합 검색(F1 · 타이틀바 돋보기). 목록은 기존 표(KEYMAP·MENUBAR·프로필)에서 만들어진다.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 연결 관리자를 어떤 상태로 열지(트리 "정보 수정" → 해당 프로필 / 그룹 "새 연결" → 그룹 기본값).
  const [modalReq, setModalReq] = useState<ConnModalRequest>(null)

  // 앱 전역 확인/경고 다이얼로그(window.confirm/alert 대체). 한 인스턴스를 모두가 공유한다.
  const dialog = useDialog()
  const ask = dialog.ask
  const askText = dialog.askText

  const sessions = useSessions()

  // F23: MCP 승인 다이얼로그. mcp:approvalRequest 는 사용자 액션과 무관하게 아무 때나 도착하므로
  // 공유 dialog 슬롯(useDialog 는 한 번에 하나만 보여준다)을 두고 겹치면 앞 요청이 조용히 밀려나
  // 그 결정이 유실된다 — 큐로 순서대로 처리한다(main 의 2분 타임아웃이 최후 방어선이라 여기서
  // 유실돼도 자동 거부로 마감되지만, 사용자가 실제로 볼 기회를 주는 게 이 큐의 목적이다).
  const approvalQueueRef = useRef<McpApprovalRequest[]>([])
  const approvalBusyRef = useRef(false)
  const processApprovalQueue = useCallback(async () => {
    if (approvalBusyRef.current) return
    const next = approvalQueueRef.current.shift()
    if (!next) return
    approvalBusyRef.current = true
    const sessionLabel = sessions.sessions.find((s) => s.id === next.sessionId)?.title ?? next.sessionId
    const r = await ask({
      title: t('mcp.approval.title'),
      message: t('mcp.approval.msg'),
      detail: [
        { label: t('mcp.approval.session'), value: sessionLabel },
        { label: t('mcp.approval.tool'), value: next.tool },
        { label: t('mcp.approval.args'), value: next.argsSummary }
      ],
      confirmLabel: t('mcp.approval.approve'),
      cancelLabel: t('mcp.approval.deny'),
      altLabel: t('mcp.approval.autoAllow')
    })
    const decision: McpApprovalDecision =
      r === 'alt'
        ? { requestId: next.requestId, decision: 'autoAllow', minutes: MCP_AUTO_ALLOW_MINUTES }
        : { requestId: next.requestId, decision: r === 'confirm' ? 'approve' : 'deny' }
    await window.ev?.mcp.respondApproval(decision)
    approvalBusyRef.current = false
    void processApprovalQueue()
  }, [ask, sessions.sessions])

  useEffect(() => {
    const off = window.ev?.mcp.onApprovalRequest((r) => {
      approvalQueueRef.current.push(r)
      void processApprovalQueue()
    })
    return () => off?.()
  }, [processApprovalQueue])

  const { profiles, conn, lookup, save, remove, connect } = useProfiles()
  // R6 연결 그룹: 프로필에서 파생된 그룹 + 저장된 빈 그룹. 트리·연결 폼이 같은 목록을 쓴다.
  const { stored: storedGroups, save: saveGroups } = useGroupList()
  const groups = groupsOf(profiles, storedGroups)
  // 마지막으로 접속한 프로필(트리 active 표시).
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  // F7: 세션별 OSC7 cwd(터미널→SFTP 트리 동기 + 사이드바 세션 카드 표시).
  // 활성 세션 하나만 구독하던 것을 전 세션 맵으로 넓혔다 — 카드마다 "지금 어느 폴더인지"가 필요하고,
  // 세션을 오갈 때 cwd 가 null 로 깜빡이던 것도 사라진다(마지막 값을 기억한다).
  const [cwdBy, setCwdBy] = useState<Record<string, string>>({})
  // 메인 영역 세션 활성화 핸들(트리 세션 행 클릭 → 탭·패널 동기).
  const mainRef = useRef<MainAreaHandle>(null)
  const selectSession = useCallback((id: string) => mainRef.current?.activateSession(id), [])
  // 새 로컬 셸은 MainArea 경로로만 연다 — 세션 생성과 패널 배치가 한 곳에 있어야 한다(R1.2).
  const newLocal = useCallback(() => mainRef.current?.newLocal(), [])

  const openConnManager = useCallback((req: ConnModalRequest = null) => {
    setModalReq(req)
    setModalOpen(true)
  }, [])

  useEffect(() => {
    window.ev?.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  // F7: 활성 세션 + 그 세션의 cwd 변경 구독. 세션 전환 시 cwd 리셋 후 새 세션 이벤트 수신.
  const activeSession = sessions.sessions.find((s) => s.id === sessions.activeId) ?? null
  const activeId = sessions.activeId
  const sessionIds = sessions.sessions.map((s) => s.id).join(',')
  useEffect(() => {
    const offs = sessionIds
      .split(',')
      .filter(Boolean)
      .map((id) => window.ev?.session.onCwd(id, (info) => setCwdBy((m) => ({ ...m, [id]: info.cwd }))))
    return () => offs.forEach((off) => off?.())
  }, [sessionIds])
  const activeCwd = activeId ? (cwdBy[activeId] ?? null) : null

  // R4.4: 창 타이틀(OS 작업표시줄·Alt+Tab)이 활성 세션을 반영한다. Electron 은 기본적으로 페이지 제목을
  // 창 제목으로 쓰므로 document.title 만 바꾸면 된다 — 별도 IPC 를 만들 이유가 없다.
  const activeTitle = activeSession?.title
  useEffect(() => {
    document.title = activeTitle ? `${t('app.name')} — ${activeTitle}` : t('app.name')
  }, [activeTitle])

  // W1 F9/F10: 활성 SSH 세션의 포트·리소스 폴링. [모니터] 탭과 상태바 게이지가 이 구독 하나를 나눠 쓴다.
  const telemetry = useTelemetry(activeId, activeSession?.type === 'ssh')
  // F29: 이미 흐르는 stats 를 시계열로 쌓는다(패널이 열려 있는 동안만 — 닫으면 버린다).
  const sysHistory = useStatsHistory(telemetry.stats, activeId, sysOpen)

  // R4.2: 상태바가 SSH 세션의 user@host:port 를 찍으려면 프로필이 필요하다. serverKey 가 프로필명이므로
  // (연결·복제 경로가 이미 그 규약을 쓴다) 새 조회 없이 목록에서 찾는다.
  const activeProfile = activeSession?.type === 'ssh'
    ? profiles.find((p) => p.name === activeSession.serverKey)
    : undefined

  // E2E 하네스 seam: 프로필로 접속을 프로그램적으로 트리거(트리 렌더 의존 없이 실 connectProfile 경로 사용).
  // 프로덕션에도 존재하나 아무도 호출하지 않는다. 아래 connectProfile 정의 뒤에서 실제 함수를 바인딩한다.

  // 셸 소유 상태의 단축키(§B.8 + R3.8): 연결 관리자 / 사이드바 접기 / 파일 트리 토글.
  // 사이드바 탭·접힘 상태가 여기 있어 여기서 배선한다. 키 조합은 keymap.ts 단일 소스에서만 온다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchBinding(e, 'connection.manager')) {
        e.preventDefault()
        openConnManager(null)
      } else if (matchBinding(e, 'sidebar.collapse')) {
        e.preventDefault()
        updateSidebar((s) => ({ collapsed: !s.collapsed }))
      } else if (matchBinding(e, 'fileTree.toggle')) {
        // [파일] 탭으로 전환(이미 파일 탭이면 [연결] 로 되돌림). 접혀 있으면 함께 펼친다 —
        // 접힌 채 탭만 바꾸면 눌러도 아무 일도 안 일어난 것처럼 보인다.
        e.preventDefault()
        updateSidebar((s) => ({ collapsed: false, activeTab: s.activeTab === 'file' ? 'conn' : 'file' }))
      } else if (matchBinding(e, 'preview.toggle')) {
        e.preventDefault()
        setPreviewOpen((o) => !o)
      } else if (matchBinding(e, 'ai.toggle')) {
        // 패널 열림 상태가 여기 있으므로 토글도 여기서 받는다. ai.ask(선택 프리필)는 선택 텍스트를
        // 아는 MainArea 가 받아 onAskAi 로 올려 준다 — 같은 상태를 두 곳에서 쓰기 위한 분담이다.
        e.preventDefault()
        setAiOpen((o) => !o)
      } else if (matchBinding(e, 'explorer.toggle')) {
        e.preventDefault()
        setExplorerOpen((o) => !o)
      } else if (matchBinding(e, 'ai.cli')) {
        // F27 진입점 ② — 아무것도 정해지지 않은 빈 창(마지막에 쓴 조합이 채워진다).
        e.preventDefault()
        openAiCli()
      } else if (matchBinding(e, 'palette.all')) {
        // F31 통합 검색. 여기서 받는 이유는 프로필·즐겨찾기 목록이 이 컴포넌트에 있어서다.
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openConnManager, updateSidebar, openAiCli])

  // F14: 터미널 Ctrl+V 로 넘어온 파일 업로드가 시작되면 [파일] 탭을 펼친다 —
  // 전송 큐(진행률·취소)가 그 안에 있어서 접혀 있으면 아무 일도 안 일어난 것처럼 보인다.
  const revealFiles = useCallback(
    () => updateSidebar({ collapsed: false, activeTab: 'file' }),
    [updateSidebar]
  )

  // R4.3 사이드바 폭 드래그. 라이브러리 없이 mousemove/mouseup 한 쌍만 쓴다. 끄는 동안은 preview 로
  // 화면만 바꾸고(저장 없음), 놓을 때 한 번만 영속한다 — 드래그마다 디스크를 때리지 않기 위해서다.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sidebar.width
      let width = startW
      setResizing(true)
      const onMove = (ev: MouseEvent) => {
        width = clampSidebarWidth(startW + ev.clientX - startX)
        previewSidebar(width)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        setResizing(false)
        updateSidebar({ width })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [sidebar.width, previewSidebar, updateSidebar]
  )

  // R4.1 메뉴바 명령(단축키가 없는 항목만 여기로 온다 — 나머지는 keymap 핸들러가 받는다).
  const onMenuCommand = useCallback(
    (id: MenuCommandId) => {
      switch (id) {
        case 'app.quit':
          void window.ev?.window.close()
          return
        case 'font.zoomIn':
          mainRef.current?.zoomFont(1)
          return
        case 'font.zoomOut':
          mainRef.current?.zoomFont(-1)
          return
        case 'help.cheatsheet':
          mainRef.current?.openCheatsheet()
          return
        case 'ai.bootstrap':
          setBootstrapOpen(true)
          return
        case 'help.about':
          void ask({
            title: t('about.title'),
            message: t('about.msg'),
            detail: [
              { label: t('about.version'), value: `v${version}` },
              { label: t('about.platform'), value: navigator.userAgent.includes('Mac') ? 'macOS' : 'Windows' }
            ],
            confirmLabel: t('dlg.ok'),
            cancelLabel: null
          })
          return
      }
    },
    [ask, version]
  )

  // 연결 실패를 사유별 커스텀 다이얼로그로 보여준다(네이티브 alert 금지).
  // 인증 실패·고아 비밀은 "비밀번호 다시 입력"(연결 관리자), 호스트키 불일치는 "호스트키 재설정"으로 이어준다.
  const showConnectFailure = useCallback(
    async (profileId: string, res: ConnectFailure) => {
      const p = await lookup(profileId)
      const detail: { label: string; value: string }[] = []
      if (p) detail.push({ label: t('conn.fail.server'), value: `${p.username}@${p.host}:${p.port}` })
      if ('message' in res) detail.push({ label: t('conn.fail.detail'), value: res.message })
      if (res.reason === 'hostKeyMismatch') {
        detail.push({ label: t('conn.hostkey.saved'), value: res.knownFingerprint })
        detail.push({ label: t('conn.hostkey.received'), value: res.fingerprint })
      }
      const canReauth = res.reason === 'auth' || res.reason === 'orphanSecret'
      const r = await ask({
        title: connectErrorTitle(res),
        message: connectErrorMessage(res),
        detail,
        ...(res.reason === 'hostKeyMismatch' ? { tone: 'danger' as const } : {}),
        confirmLabel: t('dlg.ok'),
        cancelLabel: null,
        ...(canReauth ? { altLabel: t('conn.fail.reauth') } : {}),
        ...(res.reason === 'hostKeyMismatch' ? { altLabel: t('conn.menu.server.forgetHostKey') } : {})
      })
      if (r !== 'alt') return
      if (canReauth) openConnManager({ mode: 'select', profileId })
      else await window.ev.ssh.forgetHostKey(profileId)
    },
    [ask, lookup, openConnManager]
  )

  // F25: RDP 프로필은 기본적으로 **앱 안에서** 연다(내장 RDP 뷰). OS 클라이언트 외부 실행은
  // 우클릭 [외부 클라이언트로 열기]로 남겨 둔다(폴백 — 다중 모니터·RDP 파일 등은 OS 쪽이 강하다).
  const openRdpProfile = useCallback(
    async (profileId: string): Promise<boolean> => {
      setActiveProfileId(profileId)
      const p = await lookup(profileId)
      if (!p || p.type !== 'rdp') return false
      // RDP 는 서버당 세션 하나뿐이다 — 두 번째로 붙으면 서버가 기존 세션을 끊는다.
      // 이미 열려 있으면 새로 만들지 말고 그 탭으로 간다.
      const open = sessions.sessions.find((s) => s.profileId === profileId)
      if (open) {
        selectSession(open.id)
        return true
      }
      // F25: 터미널 세션과 같은 탭 목록에 편입한다 — 탭 전환·분할 칸 배치가 그대로 통한다.
      const id = sessions.openRdp(profileId, p.name, p.name)
      selectSession(id)
      return true
    },
    [lookup, sessions, selectSession]
  )

  // W4sat F21 의 "OS 클라이언트 외부 실행" 폴백은 없앴다(2026-08-09 준영님 결정 — A-40).
  // F25 로 더블클릭이 앱 내장 뷰가 된 뒤로 부를 곳이 없었고, mstsc 를 쓸 이유도 없다.

  // 작업 프로필 선택 → 그 서버로 접속 + 그 폴더로 이동. 로컬이면 그 폴더에서 새 셸을 연다.
  const openWorkProfile = useCallback(
    async (w: WorkProfile) => {
      setWorkOpen(false)
      if (!w.profileId) {
        await sessions.restoreLocal({
          type: 'local',
          title: w.name,
          serverKey: 'localhost',
          cwd: w.path,
          profileId: null,
          shell: undefined
        })
        return
      }
      await connectProfileRef.current?.(w.profileId, undefined, w.path)
    },
    [sessions]
  )

  // 지금 보고 있는 위치를 작업 프로필로 저장 — 이름만 물어본다(대상 서버·경로는 화면이 이미 안다).
  const saveWorkProfile = useCallback(
    async (path: string) => {
      const name = await askText({
        title: t('work.save.title'),
        message: t('work.save.msg'),
        detail: [{ label: t('conn.fail.server'), value: activeSession?.serverKey ?? t('conn.group.local') }, { label: t('statusbar.cwd'), value: path }],
        input: { placeholder: t('work.save.placeholder'), value: path.split(/[\/]/).filter(Boolean).pop() ?? '' },
        confirmLabel: t('work.save.btn')
      })
      if (!name) return
      // 활성 세션이 SSH 면 그 프로필, 로컬이면 null(= 로컬 셸을 그 폴더에서 연다).
      work.add(name, activeSession?.type === 'ssh' ? (activeProfileId ?? null) : null, path)
    },
    [askText, work, activeSession, activeProfileId]
  )

  const renameWorkProfile = useCallback(
    async (id: string) => {
      const cur = work.list.find((w) => w.id === id)
      if (!cur) return
      const name = await askText({
        title: t('work.rename'),
        message: t('work.rename.msg'),
        input: { placeholder: t('work.save.placeholder'), value: cur.name },
        confirmLabel: t('work.save.btn')
      })
      if (name) work.rename(id, name)
    },
    [askText, work]
  )

  const deleteWorkProfile = useCallback(
    async (id: string) => {
      const cur = work.list.find((w) => w.id === id)
      if (!cur) return
      const r = await ask({
        title: t('work.del.title'),
        message: t('work.del.msg'),
        detail: [{ label: t('work.title'), value: cur.name }],
        tone: 'danger',
        confirmLabel: t('work.delete')
      })
      if (r === 'confirm') work.remove(id)
    },
    [ask, work]
  )

  // 트리·모달 공통 접속 경로: 호스트키 최초 접속(hostKeyNew)은 커스텀 모달로 확인 후 재시도.
  // 성공 여부를 반환해 호출측(연결 관리자)이 닫기 여부를 정한다.
  const connectProfile = useCallback(
    // startPath 를 주면 접속 직후 그 폴더로 이동한다(작업 프로필). cd 한 줄은 화면에 보인다 —
    // 사용자가 시킨 이동이라 숨길 이유가 없고, 오히려 "여기로 왔다"는 표시가 된다.
    // onSession: 새로 만들어진 세션 id 를 호출측에 알린다(F27 — 그 세션에 이어서 명령을 넣어야 한다).
    // 반환값을 boolean 에서 바꾸지 않은 이유는 호출측이 넷이고 전부 성공 여부만 보기 때문이다.
    async (
      profileId: string,
      acceptHostKey?: boolean,
      startPath?: string,
      onSession?: (sessionId: string) => void
    ): Promise<boolean> => {
      const target = await lookup(profileId)
      if (target?.type === 'rdp') return openRdpProfile(profileId)
      setActiveProfileId(profileId)
      const res = await connect(profileId, acceptHostKey)
      if (res.ok) {
        const p = await lookup(profileId)
        const name = p?.name ?? 'ssh'
        // 탭 이름은 main 이 정한다(같은 서버 다중 세션은 ·2, ·3 — R2.1). serverKey 는 그룹 키라 프로필명 그대로.
        // profileId 를 함께 실어야 파일 탐색기가 "이 서버 탭"에 붙일 세션을 찾을 수 있다(이름은 바뀔 수 있다).
        sessions.adopt(res.id, res.title ?? name, name, 'ssh', profileId)
        selectSession(res.id) // 접속 즉시 포커스 패널에 SSH 표시(트리·탭·패널 동기).
        onSession?.(res.id)
        if (startPath) window.ev.session.input(res.id, cdCommand(startPath))
        // 접속하면 바로 원격 파일이 보이게 [파일] 탭으로 넘긴다 — 접속 직후 하는 일이 대개 그거다.
        // 부팅 복원은 이 경로를 안 타므로 저장해 둔 탭이 그대로 살아난다(F6).
        revealFiles()
        return true
      }
      if (res.reason === 'hostKeyNew') {
        const p = await lookup(profileId)
        const r = await ask({
          title: t('conn.hostkey.title'),
          message: t('conn.hostkey.new'),
          detail: [
            { label: t('conn.fail.server'), value: p ? `${p.username}@${res.hostId}` : res.hostId },
            { label: t('conn.hostkey.alg'), value: res.algorithm },
            { label: t('conn.hostkey.fp'), value: res.fingerprint }
          ],
          confirmLabel: t('conn.hostkey.trustBtn'),
          cancelLabel: t('dlg.cancel')
        })
        if (r === 'confirm') return await connectProfile(profileId, true, startPath, onSession)
        return false
      }
      await showConnectFailure(profileId, res)
      return false
    },
    [connect, lookup, sessions, selectSession, ask, showConnectFailure, revealFiles]
  )

  // openWorkProfile 이 connectProfile 보다 위에 선언돼 있어 ref 로 잇는다(선언 순서 때문이지
  // 다른 이유는 없다 — 값은 매 렌더 최신으로 갱신된다).
  const connectProfileRef = useRef<typeof connectProfile | null>(null)
  connectProfileRef.current = connectProfile

  // F27: 접속 → (없으면 폴더 만들기) → CLI 확인 → 셸이 준비되면 그 한 줄. 어느 단계에서 멈추든
  // **왜 멈췄는지 말한다** — 이 흐름의 실패는 전부 "아무 일도 안 일어남"으로 보이기 때문이다.
  const launchAiCli = useCallback(
    async (r: AiCliLaunchRequest) => {
      setAiCliOpen(false)
      // 늘 새 세션을 연다. CLI 가 터미널을 점유하므로 하던 작업 세션을 빼앗으면 안 된다
      // (그래서 server.connect 처럼 "열린 세션 재사용"을 하지 않는다).
      // 준비 신호는 **접속하자마자** 듣기 시작한다. 배너와 첫 cwd 는 아래 폴더 만들기·설치 확인을
      // 하는 사이에 이미 지나가 버려서, 그 뒤에 구독하면 아무것도 못 듣고 상한까지 기다리게 된다
      // (실측: 매 실행 8초 지연 — e2e 가 잡아냈다).
      const started: { id: string | null; ready: Promise<unknown> | null } = { id: null, ready: null }
      const ok = await connectProfileRef.current?.(r.profileId, undefined, undefined, (id) => {
        started.id = id
        started.ready = waitShellReady(id)
      })
      const sid = started.id
      if (!ok || sid === null) return // 실패 안내는 connectProfile 이 이미 띄웠다.

      if (r.mkdir) {
        const made = await ensureRemoteDir(sid, r.path)
        if (!made.ok) {
          await ask({
            title: t('aicli.err.mkdir.title'),
            message: made.message,
            detail: [{ label: t('aicli.path'), value: r.path }],
            confirmLabel: t('dlg.ok'),
            cancelLabel: null
          })
          return
        }
      }

      // 없는 CLI 를 실행하면 터미널에 `command not found` 한 줄만 남아 왜 안 되는지 알 수 없다.
      const bin = binOf(r.cli, r.bin)
      if (bin === null || !(await cliInstalled(sid, bin))) {
        await ask({
          title: t('aicli.err.missing.title'),
          message: t('aicli.err.missing.msg'),
          detail: [{ label: t('aicli.cli'), value: bin ?? r.bin ?? '' }],
          confirmLabel: t('dlg.ok'),
          cancelLabel: null
        })
        return
      }

      // 프롬프트가 그려지기 전에 밀어 넣으면 삼켜진다(aiCliLaunch.waitShellReady 주석 참고).
      // 대개 여기 올 때쯤 이미 끝나 있다 — 위 왕복이 그 시간을 벌어 준다.
      await started.ready
      // CR 로 끝낸다 — cdCommand 와 같은 규칙(LF 만 보내면 conpty·일부 셸이 줄을 실행하지 않는다).
      window.ev.session.input(sid, r.cmd + '\r')
      // F30: 이 세션에서 어떤 AI 가 도는지 기록한다 — AI 세션 패널이 "조용한지"를 판정할 대상이다.
      // 성공한 실행만 등록한다(위에서 전부 return 으로 빠져나갔다).
      registerAiRun({ sessionId: sid, cli: r.cli, path: r.path, startedAt: Date.now() })
      // 최근 목록은 **성공한 조합만** 쌓는다.
      aiCliRecent.record({
        profileId: r.profileId,
        path: r.path,
        cli: r.cli,
        ...(r.bin ? { bin: r.bin } : {}),
        flags: r.flags
      })
    },
    [ask, aiCliRecent]
  )

  // E2E seam 바인딩(위 안내 참고): 실 connectProfile 을 노출. 프로덕션 동작엔 영향 없음.
  useEffect(() => {
    ;(window as unknown as { __evConnect?: (id: string) => Promise<boolean> }).__evConnect = connectProfile
  }, [connectProfile])

  // F7 E2E seam: main 이 이미 adopt 한 SSH 세션(새 연결 금지)을 렌더러 스토어에 편입한다.
  // 프로덕션에도 존재하나 아무도 호출하지 않는다(트리 원클릭 접속이 정식 경로).
  useEffect(() => {
    ;(
      window as unknown as {
        __evAdopt?: (id: string, title: string, serverKey: string, type?: SessionType) => void
      }
    ).__evAdopt = (id, title, serverKey, type = 'ssh') => {
      // type 을 무시하고 늘 'ssh' 로 편입하던 버그가 있었다 — 로컬 세션이 SSH 로 잡히면 windowsMode 가
      // 꺼져 conpty 리플로우 증상이 하네스에서 재현되지 않는다.
      sessions.adopt(id, title, serverKey, type)
      selectSession(id)
    }
  }, [sessions, selectSession])

  // F6 복원·재시도용 SSH 재접속: 프로필로 접속 → 성공 시 세션 편입 + 새 id 반환, 실패 시 사유.
  // 복원은 사용자 프롬프트 없이 진행하되, 호스트키 불일치(MITM)는 F3 정책대로 차단(오류로 반환).
  const sshRestore = useCallback(
    async (profileId: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
      setActiveProfileId(profileId)
      const res = await connect(profileId)
      if (res.ok) {
        const p = profiles.find((x) => x.id === profileId)
        const name = p?.name ?? 'ssh'
        // 스냅샷에 사용자가 바꿔 둔 이름이 있으면 복원 쪽(MainArea)이 곧바로 rename 으로 덮어쓴다(R2.1).
        sessions.adopt(res.id, res.title ?? name, name, 'ssh', profileId)
        return { ok: true, id: res.id }
      }
      return { ok: false, reason: res.reason }
    },
    [connect, profiles, sessions]
  )

  // 세션 복제(F4c 라디얼/팔레트): ssh 세션은 같은 프로필로 새 접속(connectProfile 재사용).
  // serverKey 가 프로필명과 일치하므로 이름으로 프로필을 찾아 재접속한다.
  const duplicateSession = useCallback(
    (session: { serverKey: string }) => {
      const p = profiles.find((x) => x.name === session.serverKey)
      if (p) void connectProfile(p.id)
    },
    [profiles, connectProfile]
  )

  // R6: 그룹 안의 모든 프로필을 다른 그룹으로 옮긴다(이름 변경·그룹 삭제 공통).
  // 비밀은 건드리지 않는다 — secret 미지정 저장은 vault 의 기존 비밀을 그대로 둔다(ProfileStore 계약).
  const moveGroup = useCallback(
    async (from: string, to: string | undefined) => {
      for (const p of profiles) {
        if (p.group !== from) continue
        await save(
          p.type === 'rdp'
            ? { id: p.id, type: 'rdp', name: p.name, host: p.host, port: p.port, username: p.username, group: to }
            : {
                id: p.id,
                type: 'ssh',
                name: p.name,
                host: p.host,
                port: p.port,
                username: p.username,
                authType: p.auth.type,
                keyPath: p.auth.type === 'key' ? p.auth.keyPath : undefined,
                group: to
              }
        )
      }
    },
    [profiles, save]
  )

  // 프로필 복제 — 비밀은 vault 밖으로 나오지 않으므로 복사하지 않는다(사본을 열어 재입력받는다).
  // 사이드바 트리 우클릭(server.duplicate) 과 FB-ui2 연결 관리자 좌측 목록 우클릭이 공유한다 —
  // 호출 후의 "그다음"(모달을 열지/이미 열린 폼을 갈아탈지)만 호출측이 다르게 정한다.
  const duplicateProfile = useCallback(
    (p: ConnectionProfile) =>
      save(
        p.type === 'rdp'
          ? { type: 'rdp', name: `${p.name} ${t('conn.menu.copySuffix')}`, host: p.host, port: p.port, username: p.username, group: p.group }
          : {
              type: 'ssh',
              name: `${p.name} ${t('conn.menu.copySuffix')}`,
              host: p.host,
              port: p.port,
              username: p.username,
              authType: p.auth.type,
              keyPath: p.auth.type === 'key' ? p.auth.keyPath : undefined,
              group: p.group
            }
      ),
    [save]
  )

  // 프로필 삭제 확인 + 실 삭제(vault 비밀도 함께 지워진다 — ProfileStore 계약). 트리 우클릭과
  // FB-ui2 연결 관리자 좌측 목록 우클릭이 공유한다 — 확인 문구가 두 곳에서 갈리지 않게 한다.
  const deleteProfile = useCallback(
    async (p: ConnectionProfile) => {
      const r = await ask({
        title: t('conn.del.title'),
        message: t('conn.del.msg'),
        detail: [{ label: t('conn.fail.server'), value: `${p.name} · ${p.username}@${p.host}:${p.port}` }],
        tone: 'danger',
        confirmLabel: t('conn.del.btn'),
        cancelLabel: t('dlg.cancel')
      })
      if (r === 'confirm') await remove(p.id)
    },
    [ask, remove]
  )

  // 사이드바 트리 우클릭 액션 배선(액션 정의는 interactions/actions.tsx 레지스트리 한 곳).
  const onTreeAction = useCallback(
    async (id: TreeActionId, target: TreeTarget) => {
      // 대상과 무관한 생성 액션(사이드바 빈 영역 / 로컬 그룹 메뉴).
      if (id === 'local.new') {
        newLocal()
        return
      }
      if (id === 'ssh.open') {
        openConnManager(null)
        return
      }
      if (id === 'work.open') {
        setWorkOpen(true)
        return
      }
      if (id === 'group.new') {
        // 프로필 없는 빈 그룹을 먼저 만들고 나중에 연결을 채우는 흐름. 목록에만 추가하면 트리에 뜬다.
        const name = await askText({
          title: t('conn.group.new.title'),
          message: t('conn.group.new.msg'),
          input: { placeholder: t('conn.group.new.placeholder') },
          confirmLabel: t('conn.group.new.btn'),
          cancelLabel: t('dlg.cancel')
        })
        if (name && !groups.includes(name)) saveGroups([...storedGroups, name])
        return
      }
      if (target.kind === 'session') {
        if (id === 'session.focus') selectSession(target.sessionId)
        else if (id === 'session.rename') mainRef.current?.beginRename(target.sessionId)
        else if (id === 'session.close') mainRef.current?.closeSession(target.sessionId)
        // FB-monitor(F19 tmux 후속): [모니터] 탭 TmuxBar 가 하던 일 그대로(session.input 매크로) —
        // 대상만 우클릭한 트리 세션으로 바뀐다. 이름이 필요한 건 new 뿐(attach 는 서브메뉴가 이미
        // 실제 세션 이름을 알고 있어 다시 묻지 않는다).
        else if (id === 'session.tmux.new') {
          const name = await askText({
            title: t('tmux.name.title'),
            message: t('tmux.name.new.msg'),
            input: { placeholder: t('tmux.name.placeholder') },
            confirmLabel: t('tmux.name.btn'),
            cancelLabel: t('dlg.cancel')
          })
          const input = name ? buildTmuxInput({ kind: 'new', name }) : null
          if (input) window.ev.session.input(target.sessionId, input)
        } else if (id === 'session.tmux.detach' || id === 'session.tmux.prevWindow' || id === 'session.tmux.nextWindow') {
          const kind = id === 'session.tmux.detach' ? 'detach' : id === 'session.tmux.prevWindow' ? 'prevWindow' : 'nextWindow'
          const input = buildTmuxInput({ kind })
          if (input) window.ev.session.input(target.sessionId, input)
        } else if (id.startsWith('session.tmux.attach:')) {
          const name = id.slice('session.tmux.attach:'.length)
          const input = buildTmuxInput({ kind: 'attach', name })
          if (input) window.ev.session.input(target.sessionId, input)
        }
        return
      }
      if (target.kind === 'group') {
        const isNone = target.group === noneGroup() // "기타" = 그룹 미지정 자리(실제 그룹 아님)
        if (id === 'group.newConn') {
          openConnManager({ mode: 'new', group: isNone ? undefined : target.group })
          return
        }
        if (isNone) return // 메뉴에 뜨지도 않지만, 눌러도 "기타"라는 그룹을 만들지 않는다.
        if (id === 'group.rename') {
          const name = await askText({
            title: t('conn.group.rename.title'),
            message: t('conn.group.rename.msg'),
            input: { value: target.group },
            confirmLabel: t('conn.group.rename.btn'),
            cancelLabel: t('dlg.cancel')
          })
          if (!name || name === target.group) return
          await moveGroup(target.group, name)
          saveGroups([...storedGroups.filter((g) => g !== target.group), name])
          return
        }
        if (id === 'group.delete') {
          const count = profiles.filter((p) => p.group === target.group).length
          const r = await ask({
            title: t('conn.group.del.title'),
            message: t('conn.group.del.msg'),
            detail: [
              { label: t('conn.field.group'), value: target.group },
              { label: t('conn.profiles'), value: `${count}` }
            ],
            tone: 'danger',
            confirmLabel: t('conn.group.del.btn'),
            cancelLabel: t('dlg.cancel')
          })
          if (r !== 'confirm') return
          // 프로필은 지우지 않는다 — 그룹만 없애고 "기타"로 내려보낸다.
          await moveGroup(target.group, undefined)
          saveGroups(storedGroups.filter((g) => g !== target.group))
        }
        return
      }
      if (target.kind !== 'server') return
      const p = profiles.find((x) => x.id === target.profileId)
      if (!p) return
      switch (id) {
        case 'server.connect': {
          // 연결 = 이미 열린 세션이 있으면 그 세션으로(중복 접속 방지), 없으면 새로 접속.
          const open = sessions.sessions.find((s) => s.serverKey === p.name)
          if (open) selectSession(open.id)
          else void connectProfile(p.id)
          return
        }
        case 'server.newSession':
          void connectProfile(p.id) // 무조건 새 세션
          return
        case 'aicli.start':
          // F27 진입점 ④ — 서버만 정해진 채로 연다(폴더는 최근 조합이 채워 준다).
          openAiCli({ profileId: p.id })
          return
        case 'server.edit':
          openConnManager({ mode: 'select', profileId: p.id })
          return
        case 'server.duplicate': {
          const copy = await duplicateProfile(p)
          openConnManager({ mode: 'select', profileId: copy.id })
          return
        }
        case 'server.forgetHostKey': {
          const r = await ask({
            title: t('conn.menu.server.forgetHostKey'),
            message: t('conn.hostkey.forgetMsg'),
            detail: [{ label: t('conn.fail.server'), value: `${p.host}:${p.port}` }],
            confirmLabel: t('conn.hostkey.forgetBtn'),
            cancelLabel: t('dlg.cancel')
          })
          if (r === 'confirm') await window.ev.ssh.forgetHostKey(p.id)
          return
        }
        case 'server.delete':
          await deleteProfile(p)
          return
      }
    },
    [
      profiles,
      selectSession,
      openConnManager,
      sessions,
      connectProfile,
      duplicateProfile,
      deleteProfile,
      ask,
      askText,
      newLocal,
      groups,
      storedGroups,
      saveGroups,
      moveGroup,
      openAiCli
    ]
  )

  // FB-ui2(FB-0006): 우측 액티비티 바 상태·토글. 항목은 서로 배타적이지 않다(기존 미니 프리뷰/
  // 아라 패널 규칙과 같음) — 각자 자기 open 상태를 토글할 뿐이다. [설정]만 진짜 소유자가 MainArea라
  // dispatchAction 으로 같은 keydown 경로를 태운다(타이틀바 기어가 하던 것과 동일 — 새 배선 없음).
  const activityState = useMemo(
    () => ({
      ai: aiOpen,
      monitor: monitorOpen,
      sys: sysOpen,
      aisess: aiSessOpen,
      log: logOpen,
      preview: previewOpen,
      explorer: explorerOpen,
      console: consoleOpen,
      settings: settingsActive
    }),
    [
      aiOpen,
      monitorOpen,
      sysOpen,
      aiSessOpen,
      logOpen,
      previewOpen,
      explorerOpen,
      consoleOpen,
      settingsActive
    ]
  )
  const onActivityToggle = useCallback((id: ActivityId) => {
    if (id === 'ai') setAiOpen((o) => !o)
    else if (id === 'monitor') setMonitorOpen((o) => !o)
    else if (id === 'sys') setSysOpen((o) => !o)
    else if (id === 'aisess') setAiSessOpen((o) => !o)
    else if (id === 'log') setLogOpen((o) => !o)
    else if (id === 'preview') setPreviewOpen((o) => !o)
    else if (id === 'explorer') setExplorerOpen((o) => !o)
    else if (id === 'console') setConsoleOpen((o) => !o)
    else if (id === 'settings') dispatchAction('settings.open')
  }, [])

  return (
    <div className="app">
      <TitleBar
        onCommand={onMenuCommand}
        // F31 통합 검색창 — 타이틀바 가운데에 박아 넣는다. 실행은 전부 **원래 길**로 돌려보낸다
        // (dispatchAction / 메뉴 명령 / connectProfile) — 팔레트 전용 배선을 만들지 않는다.
        omni={
          <CommandPalette
            open={paletteOpen}
            onOpen={() => setPaletteOpen(true)}
            onClose={() => setPaletteOpen(false)}
            profiles={profiles}
            workProfiles={work.list}
            onRun={(run) => {
              if (run.do === 'action') dispatchAction(run.action)
              else if (run.do === 'command') onMenuCommand(run.command)
              else if (run.do === 'connect') void connectProfile(run.profileId)
              else {
                const w = work.list.find((x) => x.id === run.workId)
                if (w) void openWorkProfile(w)
              }
            }}
          />
        }
      />
      {/* --sidebar-w 를 여기서 덮어써 .sidebar 와 .sb-toggle(접기 손잡이) 위치가 함께 따라온다. */}
      <div
        className={'middle' + (resizing ? ' resizing' : '')}
        // 탐색기는 이제 떠 있는 창이라 본문을 가리지 않는다 — 터미널을 보면서 파일을 만질 수 있다
        // (예전 전체화면 모드는 여기서 display:none 으로 본문을 통째로 숨겼다).
        style={{ ['--sidebar-w' as string]: `${sidebar.width}px` }}
      >
        <Sidebar
          active={sidebar.activeTab}
          onSwitch={(activeTab) => updateSidebar({ activeTab })}
          collapsed={sidebar.collapsed}
          profiles={profiles}
          groups={groups}
          conn={conn}
          activeProfileId={activeProfileId}
          sessions={sessions.sessions}
          activeSessionId={sessions.activeId}
          onNewConn={() => openConnManager({ mode: 'new' })}
          onConnect={(id) => void connectProfile(id)}
          workProfiles={work.list}
          onOpenWork={(w) => void openWorkProfile(w)}
          onSelectSession={selectSession}
          onTreeAction={(id, target) => void onTreeAction(id, target)}
          onTmuxQuery={(sessionId) => window.ev.tmux.list(sessionId)}
          cwdBy={cwdBy}
          onCloseSession={(id: string) => mainRef.current?.closeSession(id)}
          // F25: rdp 세션에는 파일 트리를 붙이지 않는다(SFTP·로컬 fs 대상이 아니다).
          fileSession={
            activeSession && activeSession.type !== 'rdp'
              ? { id: activeSession.id, type: activeSession.type }
              : null
          }
          fileCwd={activeCwd}
          onSaveWork={(absPath: string) => void saveWorkProfile(absPath)}
          // F27 진입점 ③ — 트리에서 고른 폴더가 그대로 채워진다. 대상 서버는 지금 그 트리가 보고 있는
          // 세션의 프로필이다(SSH 세션에서만 메뉴에 뜬다 — FileTree.canAiCli).
          onAiCli={(absPath) => openAiCli({ profileId: activeSession?.profileId, path: absPath })}
          onTailFile={(absPath) => {
            if (activeSession) mainRef.current?.openLogTail(activeSession.id, absPath)
          }}
          onRevealFiles={revealFiles}
          ask={ask}
          askText={askText}
          onCdTerminal={(absPath) => {
            // 트리→터미널 동기: 로컬·SSH 모두 cd 전송(R7 — 로컬 셸도 파일 탭을 쓴다).
            if (activeSession) window.ev.session.input(activeSession.id, cdCommand(absPath))
          }}
        />
        {/* 사이드바-메인 경계 드래그(R4.3). 접혀 있으면 끌 폭이 없으므로 손잡이도 없다. */}
        {!sidebar.collapsed && (
          <div className="sb-resizer" role="separator" title={t('sidebar.resize')} onMouseDown={startResize} />
        )}
        <div
          className={'sb-toggle' + (sidebar.collapsed ? ' collapsed' : '')}
          title={t('sidebar.toggle')}
          onClick={() => updateSidebar((s) => ({ collapsed: !s.collapsed }))}
        >
          {sidebar.collapsed ? '›' : '‹'}
        </div>
        <MainArea
          ref={mainRef}
          sessions={sessions}
          version={version}
          onDuplicateSession={duplicateSession}
          sshRestore={sshRestore}
          onOpenConnManager={() => openConnManager(null)}
          onOpenAiCli={() => openAiCli()}
          activeCwd={activeCwd}
          ask={ask}
          onAskAi={(text) => {
            setAiOpen(true)
            if (text) setAiPrefill({ text, at: Date.now() })
          }}
          onSettingsOpenChange={setSettingsActive}
          onActivityItems={setActivityItems}
        />
        <MiniPreview
          open={previewOpen}
          sessions={sessions.sessions}
          activeId={sessions.activeId}
          onSelect={selectSession}
        />
        {/* FB-ui2(FB-0007② 변경): 좌측 사이드바 [모니터] 탭에서 이관 — 데이터·폴링은 같은 telemetry
            구독을 그대로 쓴다(중복 폴링 없음). */}
        <MonitorPanel
          open={monitorOpen}
          onClose={() => setMonitorOpen(false)}
          ports={telemetry.ports}
          forwards={telemetry.forwards}
          sessionId={activeSession?.id ?? null}
          isSsh={activeSession?.type === 'ssh'}
          onRefresh={telemetry.refresh}
          onForwardsChanged={telemetry.refreshForwards}
        />
        {/* F30 AI 세션 — 어느 AI 가 조용한가. 패널이 닫혀 있어도 안에서 계속 센다
            (액티비티 바 점과 OS 알림이 그 결과를 쓴다 — 닫아 두면 안 보이는 게 D안의 급소였다). */}
        <AiSessionsPanel
          open={aiSessOpen}
          onClose={() => setAiSessOpen(false)}
          onGoTo={selectSession}
          onQuietChange={setAiQuiet}
        />
        {/* F29 시스템 모니터 — 자원 그래프. CPU·메모리·GPU 는 위 telemetry 구독을 그대로 받는다
            (새 폴러 금지). 디스크만 패널이 느린 주기로 따로 읽는다(df 는 무겁고 초 단위로 안 변한다). */}
        <SysMonitorPanel
          open={sysOpen}
          onClose={() => setSysOpen(false)}
          sessionId={activeSession?.id ?? null}
          isSsh={activeSession?.type === 'ssh'}
          serverName={activeSession?.title ?? ''}
          stats={telemetry.stats}
          history={sysHistory}
        />
        {/* 세션 CLI 내역. 모니터와 같은 우측 레일 — 둘 다 열어 둘 수 있다(서로 배타적이지 않다). */}
        <LogPanel
          open={logOpen}
          onClose={() => setLogOpen(false)}
          sessionId={activeSession?.id ?? null}
          sessionTitle={activeSession?.title ?? ''}
        />
        {/* 미니 프리뷰 바깥(가장 오른쪽) 형제. 폭 고정 — 사이드바 리사이저를 복제할 이유가 없다. */}
        <AiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          prefill={aiPrefill}
          onOpenBootstrap={() => setBootstrapOpen(true)}
          session={
            activeSession
              ? {
                  id: activeSession.id,
                  // 호스트명·프로필명은 넣지 않는다 — SSH 라는 사실만 알린다(설계 §3.5).
                  env: {
                    os: navigator.userAgent.includes('Mac') ? 'darwin' : 'win32',
                    sessionType: activeSession.type,
                    ...(activeCwd ? { cwd: activeCwd } : {})
                  }
                }
              : null
          }
        />
        {/* FB-ui2(FB-0006): 우측 최외곽 고정 — 위 우측 레일들 바깥. */}
        <ActivityBar
          items={activityItems}
          state={activityState}
          onToggle={onActivityToggle}
          badges={{ aisess: aiQuiet > 0 }}
        />
      </div>
      {explorerOpen && (
        <ExplorerView
          sessions={sessions.sessions}
          profiles={profiles}
          workProfiles={work.list}
          onConnect={(id) => void connectProfile(id)}
          onClose={() => setExplorerOpen(false)}
          ask={ask}
          askText={askText}
          reveal={explorerReveal}
        />
      )}
      {/* F26: 탐색기와 같은 떠 있는 창. 대상은 활성 세션 하나다 — 창 안에서 서버를 고르지 않는다
          (탐색기와 달리 프로세스·서비스는 "지금 붙어 있는 서버"의 것이라야 헷갈리지 않는다). */}
      {consoleOpen && (
        <ServerConsoleView
          sessionId={activeSession?.id ?? null}
          isSsh={activeSession?.type === 'ssh'}
          serverName={activeSession?.serverKey ?? ''}
          onClose={() => setConsoleOpen(false)}
          ask={ask}
          onAskAi={(text) => {
            setAiOpen(true)
            setAiPrefill({ text, at: Date.now() })
          }}
          // 디스크 창에서 파고든 폴더를 그대로 탐색기 창에 넘긴다 — 새 창을 만들지 않고 기존
          // 탐색기 진입점을 쓴다. 프로필이 없는 세션(복원 중 등)은 열 곳이 없으므로 아무 일도 안 한다.
          onOpenExplorer={(path) => {
            const profileId = activeSession?.profileId
            if (!profileId) return
            setExplorerOpen(true)
            setExplorerReveal({ profileId, path, at: Date.now() })
          }}
          // R3: 파일·로그·포트·터미널 칸은 콘솔 안에 다시 그리지 않고 **기존 진입점**을 부른다.
          // 부른 뒤 콘솔은 닫는다 — 방금 연 창을 콘솔이 덮고 있으면 한 번 더 치워야 한다.
          // F28 R2 컨테이너 접속 — `docker exec -it` 는 대화형이라 exec 채널로는 못 한다.
          // AI CLI 실행(위 launchAiCli)과 같은 채널로 지금 세션 터미널에 보낸다.
          onSendInput={(text) => {
            const sid = activeSession?.id
            if (sid) window.ev?.session.input(sid, text)
          }}
          onLaunch={(id) => {
            if (id === 'files') {
              const profileId = activeSession?.profileId
              if (!profileId) return
              setExplorerOpen(true)
              setExplorerReveal({ profileId, path: '', at: Date.now() })
            } else if (id === 'log') setLogOpen(true)
            else if (id === 'port') setMonitorOpen(true)
            else if (id === 'term') dispatchAction('session.new')
            setConsoleOpen(false)
          }}
        />
      )}
      <StatusBar
        version={version}
        session={activeSession}
        profile={activeProfile}
        conn={conn}
        cwd={activeCwd}
        sessionCount={sessions.sessions.length}
        stats={telemetry.stats}
      >
        <McpIndicator getSessionTitle={(id) => sessions.sessions.find((s) => s.id === id)?.title ?? id} />
      </StatusBar>
      <ConnectionModal
        open={modalOpen}
        request={modalReq}
        profiles={profiles}
        groups={groups}
        onClose={() => setModalOpen(false)}
        onSave={save}
        onConnect={connectProfile}
        onDuplicate={duplicateProfile}
        onDelete={deleteProfile}
      />
      <AiBootstrapModal
        open={bootstrapOpen}
        hasSsh={activeSession?.type === 'ssh'}
        onClose={() => setBootstrapOpen(false)}
        onSubmit={(prompt) => {
          setAiOpen(true)
          setAiPrefill({ text: prompt, at: Date.now(), autoSend: true })
        }}
      />
      <AiCliModal
        open={aiCliOpen}
        profiles={profiles}
        recent={aiCliRecent.list}
        prefill={aiCliPrefill}
        onClose={() => setAiCliOpen(false)}
        onSubmit={(r) => void launchAiCli(r)}
      />
      <WorkProfileModal
        open={workOpen}
        list={work.list}
        profiles={profiles}
        onClose={() => setWorkOpen(false)}
        onPick={(w) => void openWorkProfile(w)}
        onRename={(id) => void renameWorkProfile(id)}
        onDelete={(id) => void deleteWorkProfile(id)}
      />
      {dialog.node}
    </div>
  )
}
