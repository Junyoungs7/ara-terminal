import { AI_ENTRY, ARA_CHAT } from '@shared/features'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TitleBar } from './TitleBar'
import { Sidebar, SidebarRail } from './Sidebar'
import { MainArea, type MainAreaHandle } from './MainArea'
import { MiniPreview } from './MiniPreview'
import { AiPanel } from './AiPanel'
import { AraChatPanel } from './AraChatPanel'
import { AiBootstrapModal } from './AiBootstrapModal'
import { WorkProfileModal } from './WorkProfileModal'
import { ActivityBar } from './ActivityBar'
import { PortMonitor } from './PortMonitor'
import { BottomPanel } from './BottomPanel'
import { LogPanel } from './LogPanel'
import { PastLogPanel } from './PastLogPanel'
import { StatusBar } from './StatusBar'
import { McpIndicator } from './McpIndicator'
import { ConnectionModal, type ConnModalRequest } from './ConnectionModal'
import { WorkbenchView } from './WorkbenchView'
import { ServerTool } from './ServerTool'
import { CommandPalette } from './CommandPalette'
import { useDialog } from './Dialog'
import { useSessions } from '../store/sessions'
import { useProfiles, connectErrorTitle, connectErrorMessage, type ConnectFailure } from '../store/profiles'
import { clampSidebarWidth, nextSidebar, useSidebar } from '../store/sidebar'
import { useWorkProfiles } from '../store/workProfiles'
import { useAiCliRecent } from '../store/aiCliRecent'
import { AI_CLI_LOCAL, aiCliFlagsOf, buildLaunch, shellFor } from '../../shared/aiCli'
import { CLEAR_LINE } from '../../shared/shellInput'
import { useTelemetry } from '../store/telemetry'
import { useStatsHistory } from '../store/sysMonitor'
import { aiRuns, registerAiRun } from '../store/aiSessions'
import { benchRows as buildBenchRows, useAiWorkbench } from '../store/aiWorkbench'
import { childrenOf, type AiSessionState } from '@shared/aiSession'
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
  isBottomId,
  isRailId,
  type BottomId,
  type ConnectionProfile,
  type WorkProfile,
  type McpApprovalDecision,
  type McpApprovalRequest,
  type RailId,
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
  // 우측 레일 — **한 번에 하나만** 열린다(#79, 2026-08-14 준영님 결정).
  //
  // 왜: 여섯 개가 서로 배타적이 아니었고 전부 폭 고정(flex: 0 0)이라 터미널만 줄어들었다.
  // 셋만 열어도 1920 화면에서 터미널이 632px — 14px 고정폭 80칸(약 672px)이 안 나오고,
  // 여섯을 다 열면 필요 폭이 2056px 이라 터미널이 아예 사라졌다(overflow:hidden 이 조용히 잘랐다).
  // 단일 레일이면 터미널이 뺏기는 폭이 최대 하나(360px)로 고정돼 가드 로직이 필요 없다.
  //
  // 닫아도 상태는 남는다 — 패널들은 `if (!open) return null` 이고 여기서 **항상 렌더**하므로
  // 컴포넌트 인스턴스가 죽지 않는다(useState 유지). AI 대화는 더 강해서, 렌더러가 아니라
  // main 의 AraSession.turns 에 산다. 닫히면 각 패널의 useEffect 가 폴링을 멈춘다.
  //
  // 세션 수명 동안만 사는 토글이라 workspace.json 에 저장하지 않는다(레이아웃 설정이 아니다).
  const [rail, setRail] = useState<RailId | null>(null)
  /**
   * 숨긴 기능의 레일은 열리지 않는다 — 부르는 자리마다 조건을 다는 대신 **여는 문 하나**를 막는다
   * (features.AI_ENTRY). 표·탐색기의 [아라에게 묻기]처럼 여기로 오는
   * 길이 여럿이라, 문에서 막는 편이 빠뜨릴 자리가 없다.
   */
  const railAllowed = useCallback((id: RailId) => AI_ENTRY || id !== 'ai', [])
  const toggleRail = useCallback(
    (id: RailId) => setRail((cur) => (railAllowed(id) ? (cur === id ? null : id) : cur)),
    [railAllowed]
  )
  const openRail = useCallback((id: RailId) => railAllowed(id) && setRail(id), [railAllowed])
  // 자기 자신일 때만 닫는다 — 이미 다른 레일로 넘어간 뒤 늦게 도착한 onClose 가 그것까지 닫으면 안 된다.
  const closeRail = useCallback((id: RailId) => setRail((cur) => (cur === id ? null : cur)), [])

  // #78(2026-08-15): 하단 패널 — 터미널 **아래**. 세로만 먹으니 우측 레일과 같이 열려도 된다
  // (레일이 하나만 열리는 #79 규칙은 우측에만 적용된다). 포트·세션 기록이 여기로 내려왔다 —
  // 가로가 필요한 표를 280~340px 세로 레일에 넣고 있던 것이 애초에 안 맞았다.
  const [bottom, setBottom] = useState<BottomId | null>(null)
  const toggleBottom = useCallback((id: BottomId) => setBottom((cur) => (cur === id ? null : id)), [])
  const openBottom = useCallback((id: BottomId) => setBottom(id), [])
  // 2026-08-17(준영님 정정, IntelliJ 툴윈도우 방식): 하단바 전체를 켜고 끄는 토글.
  // 다시 켤 때 **보던 탭으로 돌아온다** — 늘 [포트]로 되돌아가면 매번 다시 고르게 된다.
  const lastBottom = useRef<BottomId>('monitor')
  if (bottom) lastBottom.current = bottom
  const toggleBottomBar = useCallback(() => setBottom((cur) => (cur ? null : lastBottom.current)), [])

  const previewOpen = rail === 'preview'
  const aiOpen = rail === 'ai'
  // #125: 아라 대화를 **한 번이라도 열었나**. 아래 렌더 참고 — 첫 열림 전까지는 붙이지 않는다.
  const araEver = useRef(false)
  if (aiOpen) araEver.current = true
  const aiSessOpen = rail === 'aisess'
  // #86: 지난 세션 — 우측 레일(세션 목록은 세로 카드다). 현재 기록은 하단 [세션 기록]이다.
  const pastLogOpen = rail === 'pastlog'
  const monitorOpen = bottom === 'monitor'
  // #83: 시스템 모니터는 **서버 자원**이라 아래다(§4.8 — 내용이 자리를 정한다).
  const sysOpen = bottom === 'sys'
  const logOpen = bottom === 'log'
  // 우클릭 메뉴 [AI에게 질문] 이 넘긴 선택 텍스트. at 이 함께 와야 같은 문자열을 다시 골라도 반영된다.
  // autoSend: F17 부트스트랩 전용(조립된 질문을 즉시 보낸다 — AiPanel.prefill 참고).
  const [aiPrefill, setAiPrefill] = useState<{ text: string; at: number; autoSend?: boolean } | null>(null)
  // F17 AI 부트스트랩 폼. 열림 상태만 여기 있고, 폼 값은 모달 안에만 산다(경로·이름이 렌더러
  // 상태 트리 위로 올라오지 않는다 — F16 이 API 키를 다루는 것과 같은 절제).
  const [bootstrapOpen, setBootstrapOpen] = useState(false)
  // F27 AI CLI. **창은 2026-08-18 에 없앴다**(준영님 확정) — 창이 묻던 넷 중 서버·폴더는
  // 화면이 이미 알고, CLI 는 우클릭 [AI 실행 ▸] 이 고르며, 플래그는 마지막 값을 재사용한다.
  // 최근 목록은 남는다: 그게 "마지막에 쓴 CLI·플래그"의 유일한 기억이다.
  const aiCliRecent = useAiCliRecent()
  // 단축키 핸들러가 이 함수보다 위에서 선언돼 ref 로 잇는다(connectProfileRef 와 같은 이유 —
  // 선언 순서 때문이지 다른 이유는 없다).
  const runAiCliRef = useRef<((cli?: 'claude' | 'codex' | 'gemini', atPath?: string, forSessionId?: string) => void) | null>(
    null
  )

  // F30 AI 세션 패널의 액티비티 바 점(조용한 AI 개수). 열림 상태는 위 rail 이 갖는다.
  const [aiQuiet, setAiQuiet] = useState(0)
  // 조용한 세션 id 들 — AiSessionsPanel 이 재고 있는 값을 그대로 받아 쓴다(중복 계산 금지).
  const [quietIds, setQuietIds] = useState<Set<string>>(new Set())
  // #129 작업대 목록 — 껐다 켜도 남는다. 살아 있는지는 F30 의 실행 기록·세션 목록과 맞춰 본다.
  const bench = useAiWorkbench()
  // 작업 프로필(서버+폴더 즐겨찾기). 트리에 행을 만들지 않고 팝업 목록으로만 보여 준다.
  const [workOpen, setWorkOpen] = useState(false)
  const work = useWorkProfiles()
  // FB-ui2: 설정 창 열림 상태의 실제 주인은 MainArea(Ctrl+, keydown 이 거기 배선돼 있다) — 액티비티
  // 바의 활성 표시만을 위한 미러(MainArea.onSettingsOpenChange 가 채운다).
  const [settingsActive, setSettingsActive] = useState(false)
  // 명령어 북도 같은 미러다(2026-08-22 제보 9번으로 액티비티 바 항목이 됐다).
  const [cmdbookActive, setCmdbookActive] = useState(false)
  // 우측 액티비티 바에 그릴 항목(설정에서 끄고 켜고 옮긴 결과). prefs 의 주인은 MainArea 라
  // 거기서 올려 준다 — settingsActive 미러와 같은 방식.
  const [activityItems, setActivityItems] = useState<ActivityId[]>(() => [...ACTIVITY_ITEMS])
  // 설정 [AI] 의 CLI 기본 플래그. 같은 미러다 — 최근 조합이 없을 때 우클릭 [AI 실행 ▸] 이 쓴다.
  const [aiCliFlags, setAiCliFlags] = useState<Record<string, string[]>>(() => aiCliFlagsOf(undefined))
  // W4sat F20: 탐색기 전체화면 모드. .middle 은 언마운트하지 않는다(display:none 만) — 터미널
  // 세션·레이아웃이 살아 있어야 나갈 때 보존된다(스펙 요구사항). 미니 프리뷰·아라 패널과 같은 규칙으로
  // 세션 수명 동안만 사는 토글이라 workspace.json 에 저장하지 않는다.
  const [explorerOpen, setExplorerOpen] = useState(false)
  // F26 R2: 디스크 창의 [탐색기로 열기]. 탐색기에 "이 서버의 이 폴더로 가라"를 한 번 건네는 신호다
  // (at 은 같은 경로를 두 번 눌러도 다시 열리게 하는 표식 — aiPrefill 과 같은 모양).
  const [explorerReveal, setExplorerReveal] = useState<{ profileId: string; path: string; at: number } | null>(null)
  // F26 서버 콘솔(런치패드 + 프로세스 창). 탐색기와 같은 떠 있는 창이라 같은 규칙 —
  // 세션 수명 동안만 사는 토글이라 workspace.json 에 저장하지 않는다.
  // #74 후속(2026-08-14): 떠 있는 창은 닫아도 언마운트하지 않지만, **열기 전에는 만들지도 않는다.**
  // 처음부터 마운트했더니 숨은 탐색기의 FileTree 가 DOM 에 남아 사이드바 [파일] 트리와 겹쳤다
  // (`.sftp-wrap .ftree` 가 2개 → e2e 18건 실패). 눈에 안 보이는 트리가 붙여넣기 대상·업로더
  // 같은 **전역 등록**을 가로챌 수 있다는 게 더 큰 문제다 — 그건 화면 없이 조용히 틀리는 종류다.
  // 한 번 열면 그다음부터는 계속 살아 있어 탭·정렬·검색이 남는다(#74 가 노린 것).
  const [explorerMounted, setExplorerMounted] = useState(false)
  useEffect(() => {
    if (explorerOpen) setExplorerMounted(true)
  }, [explorerOpen])
  // F31 통합 검색(F1 · 타이틀바 돋보기). 목록은 기존 표(KEYMAP·MENUBAR·프로필)에서 만들어진다.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 연결 관리자를 어떤 상태로 열지(트리 "정보 수정" → 해당 프로필 / 그룹 "새 연결" → 그룹 기본값).
  const [modalReq, setModalReq] = useState<ConnModalRequest>(null)

  // 앱 전역 확인/경고 다이얼로그(window.confirm/alert 대체). 한 인스턴스를 모두가 공유한다.
  const dialog = useDialog()
  const ask = dialog.ask
  const askText = dialog.askText

  const sessions = useSessions()

  // 2026-08-24 준영님: "세션창 생기면 자동으로 하단바가 열리고 하단에 딱 붙어있게."
  // **첫 세션이 생길 때 한 번만** 연다(0개 → 1개). 세션을 열 때마다 열면, 방금 닫은 사람 앞에서
  // 탭 하나 열 때마다 도로 올라온다 — 사용자가 끈 것을 앱이 되돌리면 안 된다.
  const hadSession = useRef(false)
  useEffect(() => {
    const has = sessions.sessions.length > 0
    if (has && !hadSession.current) setBottom((cur) => cur ?? lastBottom.current)
    hadSession.current = has
  }, [sessions.sessions.length])

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

  // 작업대 줄. 살아 있는 세션 찾기는 **F30 실행 기록**(어느 터미널에서 무엇이 도는가)을 통해서다 —
  // 같은 사실을 두 곳에서 다르게 세지 않는다.
  const benchList = useMemo(() => {
    const runs = aiRuns()
    const alive = new Set(sessions.sessions.map((x) => x.id))
    return buildBenchRows(bench.list, {
      sessionOf: (b) => runs.find((r) => alive.has(r.sessionId) && r.path === b.cwd && r.cli === b.engine)?.sessionId ?? null,
      isQuiet: (sid) => quietIds.has(sid),
      pathExists: (b) => bench.paths[b.cwd],
      profileExists: (id) => profiles.some((p) => p.id === id)
    })
  }, [bench.list, bench.paths, sessions.sessions, profiles, quietIds])

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
  // [파일] 탭으로 넘기는 일은 **MainArea.openLocal** 이 한다 — 셸을 여는 길이 거기로 모인다
  // (탭바 ＋ · Ctrl+` · 복제). 여기서 또 부르면 두 번 부르는 것일 뿐이다.
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
  // 2026-08-18 제보 ③: 상태바 게이지가 그래프가 되면서 이력이 **늘** 필요해졌다.
  // 하단 [시스템 모니터]가 열렸을 때만 쌓던 것을 항상 쌓는다 — 대신 **이력은 하나뿐이고**
  // 둘이 나눠 쓴다(폴러는 원래부터 활성 세션 하나다). 값 60개짜리라 비용은 없다.
  const sysHistory = useStatsHistory(telemetry.stats, activeId, true)

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
        // 레일의 [파일] 아이콘을 누른 것과 **같다**(2026-08-19). 예전엔 이미 파일이면 [연결] 로
        // 넘겼는데, 그러면 같은 패널을 여닫는 규칙이 자리마다 달라진다 — 규칙은 하나여야 한다.
        e.preventDefault()
        updateSidebar((s) => nextSidebar(s, 'file'))
      } else if (matchBinding(e, 'preview.toggle')) {
        e.preventDefault()
        toggleRail('preview')
      } else if (matchBinding(e, 'ai.toggle')) {
        // 패널 열림 상태가 여기 있으므로 토글도 여기서 받는다. ai.ask(선택 프리필)는 선택 텍스트를
        // 아는 MainArea 가 받아 onAskAi 로 올려 준다 — 같은 상태를 두 곳에서 쓰기 위한 분담이다.
        e.preventDefault()
        toggleRail('ai')
      } else if (matchBinding(e, 'explorer.toggle')) {
        e.preventDefault()
        setExplorerOpen((o) => !o)
      } else if (matchBinding(e, 'ai.cli')) {
        // F27 진입점 ② — 아무것도 정해지지 않은 빈 창(마지막에 쓴 조합이 채워진다).
        e.preventDefault()
        runAiCliRef.current?.()
      } else if (matchBinding(e, 'palette.all')) {
        // F31 통합 검색. 여기서 받는 이유는 프로필·즐겨찾기 목록이 이 컴포넌트에 있어서다.
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openConnManager, updateSidebar])

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
          if (!AI_ENTRY) return // 아라 대화가 꺼진 판에서는 갈 곳이 없다(features.ts)
          setBootstrapOpen(true)
          return
        case 'panel.console':
          // #91: 서버 콘솔은 [서버 작업대] 창에 흡수됐다 — 같은 창을 연다.
          setExplorerOpen((o) => !o)
          return
        case 'panel.ports':
          toggleBottom('monitor')
          return
        case 'panel.sysmon':
          toggleBottom('sys')
          return
        case 'panel.aisessions':
          toggleRail('aisess')
          return
        case 'panel.log':
          toggleBottom('log')
          return
        case 'panel.ps':
          toggleBottom('ps')
          return
        case 'panel.svc':
          toggleBottom('svc')
          return
        case 'panel.disk':
          toggleBottom('disk')
          return
        case 'panel.pkg':
          toggleBottom('pkg')
          return
        case 'panel.ctr':
          toggleBottom('ctr')
          return
        case 'panel.pastlog':
          toggleRail('pastlog')
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

  /**
   * 2026-08-18 제보 ⑤: 우클릭 [AI 실행 ▸ Claude] — **창을 띄우지 않는다.**
   *
   * 창이 묻던 넷 중 서버·폴더는 화면이 이미 안다(지금 세션·지금 cwd). 나머지 둘(CLI·플래그)에서
   * CLI 는 누른 항목이고, 플래그는 **그 CLI 로 마지막에 시작할 때 쓴 값**을 재사용한다 —
   * 준영님은 늘 같은 조합을 쓰시는데 매번 고르게 하고 있었다.
   *
   * 최근 값이 없으면 플래그 없이 맨몸으로 띄운다(`claude` 한 줄). 그게 싫으면 창에서 한 번
   * 골라 주시면 그 뒤로는 기억한다 — 창은 **다르게 하고 싶을 때**만 필요하다.
   */
  const runAiCliNow = useCallback(
    (cli?: 'claude' | 'codex' | 'gemini', atPath?: string, forSessionId?: string) => {
      const sess = forSessionId ? sessions.sessions.find((x) => x.id === forSessionId) : activeSession
      const sid = sess?.id
      const path = atPath ?? (sid ? cwdBy[sid] : undefined)
      if (!sid || !path) {
        // 폴더를 모르는 세션(막 뜬 셸)에서는 아무 데서나 띄우지 않는다 — 어디서 도는지 모르는
        // AI 를 만드느니 안내하고 만다(창이 있던 시절에는 여기서 물었다).
        mainRef.current?.toast(t('aicli.noCwd'))
        return
      }
      // CLI 를 안 주면 마지막에 쓴 것. 그것도 없으면 claude(사내 기본).
      cli = cli ?? ((aiCliRecent.list[0]?.cli as 'claude' | 'codex' | 'gemini' | undefined) ?? 'claude')
      const target = sess?.type === 'ssh' ? (sess.profileId ?? AI_CLI_LOCAL) : AI_CLI_LOCAL
      const last = aiCliRecent.list.find((r) => r.cli === cli && r.profileId === target)
      // 최근에 쓴 조합이 있으면 그대로, 없으면 **설정 [AI] 의 기본 플래그**(2026-08-20 · A-79).
      // 예전엔 여기가 `?? []` 라 처음 쓰는 사람에게 맨몸 `claude` 가 떴다 — 창을 없애면서
      // 플래그를 고를 자리가 사라진 것을 못 메운 자리였다.
      const flags = last?.flags ?? aiCliFlags[cli] ?? []
      const line = buildLaunch({
        cli,
        flags,
        path,
        // 원격은 늘 posix. 로컬은 그 세션이 실제로 무슨 셸인지에 달렸다(#90 과 같은 판정).
        shell: sess?.type === 'ssh' ? 'posix' : shellFor('powershell', 'win32')
      })
      if (!line) return
      // 치던 줄을 비우고 보낸다 — 제보 7번(tmux)과 같은 사고가 여기서도 난다: 반쯤 친 명령 뒤에
      // `cd '…' && claude …` 가 이어붙으면 엉뚱한 한 줄이 실행된다.
      window.ev?.session.input(sid, CLEAR_LINE + line + '\n')
      aiCliRecent.record({ profileId: target, path, cli, flags })
      // F30: 이 세션에서 AI 가 돈다고 알린다 — [AI 세션] 패널의 "조용한 AI" 판정이 이 등록에
      // 걸려 있다. 창이 하던 일인데, 창을 없애면서 같이 사라질 뻔했다(타입 검사가 잡았다).
      registerAiRun({ sessionId: sid, cli, path, startedAt: Date.now() })
      // #129: 여기가 **작업대를 만드는 유일한 문**이다(설계 §10.6 — 만들고 잊지 않는다).
      bench.record({
        kind: sess?.type === 'ssh' ? 'remote' : 'local',
        ...(sess?.type === 'ssh' && sess.profileId ? { profileId: sess.profileId } : {}),
        cwd: path,
        engine: cli,
        // 플래그에 그 인자가 들어 있으면 켜진 것이다 — 화면이 그 사실을 상시 표시한다(§6 확정 2).
        skipPerms: flags.some((f) => f.includes('dangerously-skip-permissions'))
      })
    },
    [activeSession, cwdBy, aiCliRecent, sessions, aiCliFlags, bench]
  )
  runAiCliRef.current = runAiCliNow

  /**
   * #129 작업대를 연다 — **살아 있으면 그 탭으로, 아니면 그 자리에서 다시 띄운다.**
   * 다시 띄우는 길은 처음 만들 때와 **같은 함수**(runAiCliNow)를 지난다. 두 벌로 갈리면
   * "처음엔 되는데 되살리면 플래그가 다르다" 같은 것이 생긴다.
   */
  const openBench = useCallback(
    async (b: AiSessionState, sessionId: string | null) => {
      if (sessionId) {
        selectSession(sessionId)
        return
      }
      const cli = b.engine === 'custom' ? 'claude' : b.engine
      if (b.kind === 'remote' && b.profileId) {
        // 접속이 끝나면 그 세션에서 CLI 를 띄운다 — 접속 전에 보내면 셸이 아직 없다.
        await connectProfileRef.current?.(b.profileId, undefined, b.cwd, (sid) => runAiCliRef.current?.(cli, b.cwd, sid))
        return
      }
      const sid = await sessions.restoreLocal({
        type: 'local',
        title: b.title,
        serverKey: 'localhost',
        cwd: b.cwd,
        profileId: null,
        shell: undefined
      })
      if (sid) runAiCliRef.current?.(cli, b.cwd, sid)
    },
    [sessions, selectSession]
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
      onSession?: (sessionId: string) => void,
      /** 그 자리에서 받은 비밀번호(저장하지 않는다 — 아래 orphanSecret 분기에서만 채워진다). */
      password?: string
    ): Promise<boolean> => {
      const target = await lookup(profileId)
      if (target?.type === 'rdp') return openRdpProfile(profileId)
      setActiveProfileId(profileId)
      const res = await connect(profileId, acceptHostKey, password)
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
        if (r === 'confirm') return await connectProfile(profileId, true, startPath, onSession, password)
        return false
      }
      // 저장해 둔 비밀번호가 없다(또는 vault 에서 사라졌다). 예전엔 여기서 "연결 관리자에서 다시
      // 입력하세요"로 끝났는데, 그러면 **비밀번호를 저장하지 않고 쓰는 길이 아예 없다** — RDP 는
      // 접속할 때 물어보는 화면(rdp-creds)이 있는데 SSH 에는 없었다(준영님 제보 18번).
      // 여기서 받아 이번 접속에만 쓴다. 저장은 하지 않는다 — 저장하려면 연결 관리자의 [저장]이다.
      // password 를 이미 들고 온 재시도라면 이 분기로 다시 오지 않는다(main 이 그 값을 우선한다).
      if (res.reason === 'orphanSecret') {
        const p = await lookup(profileId)
        const pw = await askText({
          title: t('conn.pw.title'),
          message: t('conn.pw.msg'),
          detail: p ? [{ label: t('conn.fail.server'), value: `${p.username}@${p.host}:${p.port}` }] : [],
          input: { placeholder: t('conn.pw.placeholder'), password: true },
          confirmLabel: t('conn.pw.connect'),
          cancelLabel: t('dlg.cancel')
        })
        if (!pw) return false
        return await connectProfile(profileId, acceptHostKey, startPath, onSession, pw)
      }
      await showConnectFailure(profileId, res)
      return false
    },
    [connect, lookup, sessions, selectSession, ask, askText, showConnectFailure, revealFiles]
  )

  // openWorkProfile 이 connectProfile 보다 위에 선언돼 있어 ref 로 잇는다(선언 순서 때문이지
  // 다른 이유는 없다 — 값은 매 렌더 최신으로 갱신된다).
  const connectProfileRef = useRef<typeof connectProfile | null>(null)
  connectProfileRef.current = connectProfile

  // F27 launchAiCli 는 2026-08-18 에 사라졌다(창과 함께). 그 함수가 하던 접속·폴더 만들기·
  // CLI 설치 확인은 **창이 있어야만 성립하던 절차**다 — 이제는 이미 붙어 있는 세션의 그 폴더에
  // 한 줄 보낼 뿐이라(runAiCliNow) 접속도 이동도 필요 없다. 잃은 것은 "없는 폴더 만들기"와
  // "CLI 설치 여부 확인" 둘 — 전자는 mkdir 를 직접 치면 되고, 후자는 command not found 가
  // 터미널에 그대로 보인다(우리가 미리 확인해 주던 것을 셸이 말해 준다).

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

  // 세션 복제(F4c 우클릭 메뉴): ssh 세션은 같은 프로필로 새 접속(connectProfile 재사용).
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
      // 2026-08-17 제보 ①: 즐겨찾기 행. 열기·이름 변경·삭제는 **작업 프로필 팝업이 쓰던 함수
      // 그대로**다 — 그 팝업에만 있어서 트리에서는 지울 길이 없었을 뿐, 동작은 처음부터 있었다.
      if (target.kind === 'work') {
        const w = work.list.find((x) => x.id === target.workId)
        if (!w) return
        if (id === 'work.goto') await openWorkProfile(w)
        else if (id === 'work.rename') await renameWorkProfile(w.id)
        else if (id === 'work.delete') await deleteWorkProfile(w.id)
        return
      }
      if (target.kind === 'session') {
        if (id === 'session.focus') selectSession(target.sessionId)
        // 제보 ①: 세션 메뉴 보강. 셋 다 **그 세션의 폴더**를 쓴다 — 서버 행에서 열면 폴더를
        // 다시 골라야 하는데, 세션은 이미 거기 서 있다.
        else if (id === 'session.duplicate') {
          const sess = sessions.sessions.find((x) => x.id === target.sessionId)
          if (sess) duplicateSession(sess)
        } else if (id === 'aicli.start') {
          // 창이 없어졌다(2026-08-18) — 그 세션의 폴더에서 마지막에 쓴 CLI 로 바로 띄운다.
          runAiCliNow(undefined, cwdBy[target.sessionId], target.sessionId)
        } else if (id === 'work.save') {
          const path = cwdBy[target.sessionId]
          // 폴더를 아직 모르는 세션(막 뜬 셸·RDP)은 저장할 위치가 없다 — 조용히 넘긴다.
          if (path) await saveWorkProfile(path)
        }
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
      runAiCliNow
    ]
  )

  // FB-ui2(FB-0006): 우측 액티비티 바 상태·토글. **레일 여섯은 서로 배타적이다**(#79) — 위 rail
  // 하나가 주인이라 다른 것을 누르면 앞엣것이 닫힌다. 떠 있는 창(탐색기·콘솔)은 레일이 아니라
  // 그대로 각자 토글한다. [설정]만 진짜 소유자가 MainArea라
  // dispatchAction 으로 같은 keydown 경로를 태운다(타이틀바 기어가 하던 것과 동일 — 새 배선 없음).
  const activityState = useMemo(
    () => ({
      ai: aiOpen,
      monitor: monitorOpen,
      sys: sysOpen,
      // #84: 하단 탭 다섯 — 열린 것 하나만 활성이다(하단도 한 번에 하나만 그린다).
      ps: bottom === 'ps',
      svc: bottom === 'svc',
      disk: bottom === 'disk',
      pkg: bottom === 'pkg',
      ctr: bottom === 'ctr',
      k8s: bottom === 'k8s',
      aisess: aiSessOpen,
      log: logOpen,
      pastlog: pastLogOpen,
      preview: previewOpen,
      explorer: explorerOpen,
      cmdbook: cmdbookActive,
      settings: settingsActive
    }),
    [
      aiOpen,
      monitorOpen,
      sysOpen,
      bottom,
      aiSessOpen,
      logOpen,
      pastLogOpen,
      previewOpen,
      explorerOpen,
      cmdbookActive,
      settingsActive
    ]
  )
  const onActivityToggle = useCallback((id: ActivityId) => {
    if (isRailId(id)) toggleRail(id)
    else if (isBottomId(id)) toggleBottom(id)
    else if (id === 'explorer') setExplorerOpen((o) => !o)
    // 설정·명령어 북은 오버레이다 — 단축키와 **같은 길**로 보낸다(바 전용 배선을 만들지 않는다).
    else if (id === 'settings') dispatchAction('settings.open')
    else if (id === 'cmdbook') dispatchAction('commandBook.toggle')
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
      {/* --sidebar-w 를 여기서 덮어써 .sidebar 와 폭 손잡이(.sb-resizer) 위치가 함께 따라온다. */}
      <div
        className={'middle' + (resizing ? ' resizing' : '')}
        // 탐색기는 이제 떠 있는 창이라 본문을 가리지 않는다 — 터미널을 보면서 파일을 만질 수 있다
        // (예전 전체화면 모드는 여기서 display:none 으로 본문을 통째로 숨겼다).
        style={{ ['--sidebar-w' as string]: `${sidebar.width}px` }}
      >
        {/* 좌측 아이콘 레일 — 사이드바 자체의 여닫이(2026-08-19). 사이드바가 접혀도 남아 있어야
            한다: 여기가 다시 여는 유일한 자리다(옛 `‹`/`›` 손잡이를 없앤 이유가 그것과 겹쳤다). */}
        <SidebarRail
          active={sidebar.activeTab}
          collapsed={sidebar.collapsed}
          fileEnabled={!!activeSession && activeSession.type !== 'rdp'}
          onPick={(tab) => updateSidebar((s) => nextSidebar(s, tab))}
        />
        <Sidebar
          active={sidebar.activeTab}
          collapsed={sidebar.collapsed}
          profiles={profiles}
          groups={groups}
          conn={conn}
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
              ? { id: activeSession.id, type: activeSession.type, serverKey: activeSession.serverKey }
              : null
          }
          fileCwd={activeCwd}
          onSaveWork={(absPath: string) => void saveWorkProfile(absPath)}
          // F27 진입점 ③ — 트리에서 고른 폴더가 그대로 채워진다. 대상 서버는 지금 그 트리가 보고 있는
          // 세션의 프로필이다(SSH 세션에서만 메뉴에 뜬다 — FileTree.canAiCli).
          onAiCli={(absPath) => runAiCliNow(undefined, absPath)}
          // #88 R1: 아라 연결점 — 작업대와 같은 동작이어야 한다(같은 트리, 같은 메뉴).
          onTerminalHere={(absPath) => {
            const pid = activeSession?.profileId
            if (pid) void connectProfile(pid, undefined, absPath)
            else
              void sessions.restoreLocal({
                type: 'local',
                title: absPath.split(/[\/]/).pop() || 'shell',
                serverKey: 'localhost',
                cwd: absPath,
                profileId: null,
                shell: undefined
              })
          }}
          onAskAiPaths={(paths: string[]) => {
            openRail('ai')
            setAiPrefill({ text: paths.join('\n'), at: Date.now() })
          }}
          onTailFile={(absPath) => {
            if (activeSession) mainRef.current?.openLogTail(activeSession.id, absPath)
          }}
          onRevealFiles={revealFiles}
          ask={ask}
          askText={askText}
          benchRows={benchList}
          onBenchOpen={(b, sid) => void openBench(b, sid)}
          onBenchRemove={(b) => {
            // 분리 세션(worktree)의 부모를 지우면 자식도 함께 사라진다 — 먼저 알린다(§10.3 규칙 4).
            const kids = childrenOf(bench.list, b.id)
            if (kids.length === 0) {
              bench.remove(b.id)
              return
            }
            void ask({
              title: t('bench.remove'),
              message: t('bench.remove.kids').replace('{n}', String(kids.length)).replace('{t}', b.title),
              confirmLabel: t('bench.remove'),
              tone: 'danger'
            }).then((r) => r === 'confirm' && bench.remove(b.id))
          }}
          onNewBench={() => runAiCliNow()}
          onCdTerminal={(absPath) => {
            // 트리→터미널 동기: 로컬·SSH 모두 cd 전송(R7 — 로컬 셸도 파일 탭을 쓴다).
            if (activeSession) window.ev.session.input(activeSession.id, cdCommand(absPath))
          }}
        />
        {/* 사이드바-메인 경계 드래그(R4.3). 접혀 있으면 끌 폭이 없으므로 손잡이도 없다. */}
        {!sidebar.collapsed && (
          <div className="sb-resizer" role="separator" title={t('sidebar.resize')} onMouseDown={startResize} />
        )}
        <MainArea
          ref={mainRef}
          sessions={sessions}
          // #78: 하단 패널. 상태는 여기 있고 화면 자리는 .main 안이라 노드로 내려보낸다.
          bottom={
            <BottomPanel
              tab={bottom}
              // 탭은 **갈아타기**다(끄지 않는다) — 끄는 자리는 액티비티 바의 [하단바] 토글과
              // 이 패널의 [×] 둘이다(IntelliJ 툴윈도우와 같은 규칙).
              onTab={setBottom}
              onClose={() => setBottom(null)}
              // #84: 탭이 여덟이라 좁을 수 있다 — 액티비티 바의 순서·숨김 설정을 그대로 쓴다
              // (하단만의 새 설정을 만들지 않는다). 설정에서 끈 도구는 탭에서도 사라진다.
              ids={activityItems.filter(isBottomId)}
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
                    ask={ask}
                  />
                ) : id === 'sys' ? (
                  // F29 시스템 모니터 — CPU·메모리·GPU 는 위 telemetry 구독을 그대로 받는다
                  // (새 폴러 금지). 디스크만 느린 주기로 따로 읽는다(df 는 무겁고 초 단위로 안 변한다).
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
                  // #84: 서버 콘솔에서 내려온 표 다섯. **서버는 세션 탭이 정한다** — 여기에
                  // 서버 선택 UI 는 없다. SSH 가 아니면 각 표가 자기 안내를 낸다(탭은 감추지
                  // 않는다 — 세션 종류마다 탭이 나타났다 사라지면 더 헷갈린다).
                  <ServerTool
                    id={id}
                    active={active}
                    sessionId={activeSession?.type === 'ssh' ? (activeSession?.id ?? null) : null}
                    isSsh={activeSession?.type === 'ssh'}
                    server={activeSession?.type === 'ssh' ? activeSession.serverKey : undefined}
                    ask={ask}
                    onAskAi={(text: string) => {
                      openRail('ai')
                      setAiPrefill({ text, at: Date.now() })
                    }}
                    // 디스크 표에서 파고든 폴더를 그대로 탐색기 창에 넘긴다 — 새 창을 만들지 않고
                    // 기존 진입점을 쓴다. 프로필이 없는 세션(복원 중 등)은 열 곳이 없다.
                    onOpenExplorer={(path: string) => {
                      const profileId = activeSession?.profileId
                      if (!profileId) return
                      setExplorerOpen(true)
                      setExplorerReveal({ profileId, path, at: Date.now() })
                    }}
                    // 컨테이너 접속(`docker exec -it`)은 대화형이라 exec 채널로 못 한다 —
                    // AI CLI 실행과 같은 채널로 지금 세션 터미널에 보낸다.
                    onSendInput={(text: string) => {
                      const sid = activeSession?.id
                      if (sid) window.ev?.session.input(sid, text)
                    }}
                  />
                )
              }
            </BottomPanel>
          }
          version={version}
          onDuplicateSession={duplicateSession}
          sshRestore={sshRestore}
          onOpenConnManager={() => openConnManager(null)}
          onOpenAiCli={() => runAiCliNow()}
          onRunAiCli={runAiCliNow}
          activeCwd={activeCwd}
          ask={ask}
          onAskAi={(text) => {
            openRail('ai')
            if (text) setAiPrefill({ text, at: Date.now() })
          }}
          onSettingsOpenChange={setSettingsActive}
          onCommandBookOpenChange={setCmdbookActive}
          onRevealFiles={revealFiles}
          onOpenLog={() => openBottom('log')}
          onActivityItems={setActivityItems}
          onAiCliFlags={setAiCliFlags}
          // 제보 11·32: 터미널 우클릭 [tmux ▸ 새 세션] 이 이름을 묻는다(트리 메뉴와 같은 창).
          askText={askText}
        />
        <MiniPreview
          open={previewOpen}
          sessions={sessions.sessions}
          activeId={sessions.activeId}
          onSelect={selectSession}
        />
        {/* F30 AI 세션 — 어느 AI 가 조용한가. 패널이 닫혀 있어도 안에서 계속 센다
            (액티비티 바 점과 OS 알림이 그 결과를 쓴다 — 닫아 두면 안 보이는 게 D안의 급소였다). */}
        <AiSessionsPanel
          open={aiSessOpen}
          onClose={() => closeRail('aisess')}
          onGoTo={selectSession}
          onQuietChange={setAiQuiet}
          onQuietIds={setQuietIds}
        />
        {/* #86 지난 세션 — 로그 폴더를 읽어 목록을 낸다(새 저장소 없음). 현재 세션 기록은
            하단 [세션 기록] 탭이고, 여기서 [진행 중] 줄을 누르면 그쪽으로 보낸다. */}
        <PastLogPanel
          open={pastLogOpen}
          onClose={() => closeRail('pastlog')}
          onOpenCurrent={() => {
            closeRail('pastlog')
            openBottom('log')
          }}
        />
        {/* #125 아라 대화 v2 — 같은 자리(ai 레일). **처음 열 때까지 붙이지 않는다**: 마운트하는
            순간 claude 프로세스가 뜨는데(≈20초) 앱 부팅마다 그걸 띄울 이유가 없다. 한 번 열면
            그 뒤로는 계속 렌더한다(닫혀도 `open=false` 로 null 만 반환) — 언마운트하면 대화 목록이
            날아가고 다시 열 때 엔진까지 새로 뜬다. lastBottom.current 와 같은 손버릇이다. */}
        {ARA_CHAT ? (
          (araEver.current || aiOpen) && (
            <AraChatPanel
              open={aiOpen}
              onClose={() => closeRail('ai')}
              active={activeSession ? { type: activeSession.type, cwd: activeCwd } : null}
              prefill={aiPrefill}
            />
          )
        ) : (
          <AiPanel
            open={aiOpen}
          onClose={() => closeRail('ai')}
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
        )}
        {/* FB-ui2(FB-0006): 우측 최외곽 고정 — 위 우측 레일들 바깥. */}
        <ActivityBar
          items={activityItems}
          state={activityState}
          onToggle={onActivityToggle}
          badges={{ aisess: aiQuiet > 0 }}
          bottomOpen={bottom !== null}
          onToggleBottomBar={toggleBottomBar}
        />
      </div>
      {/* #74: 떠 있는 창 둘은 **언마운트하지 않는다.** 조건부 렌더였을 때는 닫는 순간 탭·경로·
          표의 정렬·검색이 통째로 날아갔다(프로세스 표를 맞춰 놓고 잠깐 닫으면 처음부터였다).
          우측 레일이 상태를 지키는 것과 같은 이유로 여기도 열림 여부만 넘기고 창이 display:none
          으로 숨는다. 숨은 동안 원격 폴링이 돌지 않는 것은 각 창이 active 를 함께 내려서 막는다. */}
      {/* #91: 옛 [파일 탐색기] 창과 [서버 콘솔] 런치패드가 **한 창**이 됐다(서버 작업대).
          #74: 닫혀도 언마운트하지 않는다 — 대상·열린 도구·경로·표의 정렬이 남는다.
          숨은 동안 원격 폴링이 돌지 않는 것은 창이 visible 을 아래로 내려서 막는다. */}
      {explorerMounted && (
        <WorkbenchView
          visible={explorerOpen}
          sessions={sessions.sessions}
          profiles={profiles}
          workProfiles={work.list}
          onConnect={(id) => void connectProfile(id)}
          onClose={() => setExplorerOpen(false)}
          ask={ask}
          askText={askText}
          onAskAi={(text) => {
            openRail('ai')
            setAiPrefill({ text, at: Date.now() })
          }}
          onSendInput={(text) => {
            const sid = activeSession?.id
            if (sid) window.ev?.session.input(sid, text)
          }}
          onAiCli={(_profileId, path) => runAiCliNow(undefined, path)}
          onLaunch={(id, profileId, cwd) => {
            // ↗ 칸 — 창 밖에서 열린다. 포트·시스템은 **활성 세션**의 것이라(telemetry 를 두 번
            // 구독하지 않는다) 하단 그 탭을 열 뿐이다. 터미널은 그 서버로 새 세션.
            if (id === 'port') openBottom('monitor')
            else if (id === 'sys') openBottom('sys')
            else if (id === 'term') {
              // #88 R1: cwd 가 있으면 **그 폴더에서** 연다([여기서 터미널 열기]) — 탐색기에 없는
              // 것이고, 폴더를 찾은 다음 개발자가 실제로 하는 일이다.
              if (profileId) void connectProfile(profileId, undefined, cwd)
              else if (cwd) {
                void sessions.restoreLocal({
                  type: 'local',
                  title: cwd.split(/[\/]/).pop() || 'shell',
                  serverKey: 'localhost',
                  cwd,
                  profileId: null,
                  shell: undefined
                })
              } else dispatchAction('session.new')
              // 세션을 만드는 동작이라 터미널이 보여야 한다 — 이 칸만 창을 닫는다.
              setExplorerOpen(false)
            }
          }}
          reveal={explorerReveal}
          // 제보 ①: 작업대의 즐겨찾기도 사이드바와 같은 곳에 도착한다(두 자리, 한 동작).
          onWorkAction={(id, workId) => void onTreeAction(id, { kind: 'work', workId })}
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
        conn={conn}
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
          openRail('ai')
          setAiPrefill({ text: prompt, at: Date.now(), autoSend: true })
        }}
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
