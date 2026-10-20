import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react'
import { setUploadNotifier } from '../store/uploadBus'
import { t } from '../i18n'
import { TermTabbar } from './TermTabbar'
import { PaneGrid, type RestoreError } from './PaneGrid'
import { pickBackgroundSession, type Session, type useSessions } from '../store/sessions'
import { useLayout, toLayoutNode, allPanesRdp, type PairAxis } from '../store/layout'
import { matchBinding, matchArrow, matchNumber } from '../../shared/keymap'
import { ContextInteractions } from '../interactions/ContextInteractions'
import { aiCliRunOfKey, type ActionId } from '../interactions/actions'
import { getSelection } from '../terminal/termRegistry'
import { applyUiPrefs, prefsFrom } from '../terminal/termPrefs'
import { TerminalSearch } from './TerminalSearch'
import { SettingsDrawer, SIZE_MAX, SIZE_MIN } from './SettingsDrawer'
import { useFont } from '../store/font'
import { useUiPrefs } from '../store/uiPrefs'
import { WelcomeModal } from './WelcomeModal'
import { BootSplash, shouldShowBootSplash } from './BootSplash'
import {
  justUpdated,
  readSeenVersion,
  useUpdatePrompt,
  useUpdateState,
  writeSeenVersion
} from '../store/updateNotify'
import { UpdateProgress } from './UpdateProgress'

/**
 * #139: 이 창에서 부팅 인사를 이미 지났나. **모듈 변수**인 이유 — MainArea 는 떼어낸 창마다
 * 새로 마운트되지만, 인사는 앱을 켤 때 한 번이면 된다(탭을 새 창으로 뺄 때마다 인사하면 코미디다).
 */
let bootSplashShown = false
import { readClipboard, setClipboardNotifier, writeClipboard } from '../store/clipboardWrite'
import { planRestore } from '../store/restore'
import { setSessionState, useSessionStates } from '../store/sessionState'
import { setSpanNotifier } from '../store/rdpSpanOpen'
import { localUrl, planLink } from '../../shared/linkTarget'
import { CHANGELOG_URL } from '../../shared/links'
import { usableSize } from '../../shared/termSize'
import { aiCliOf, type AiCliId } from '../../shared/aiCli'
import { buildTmuxInput } from '../../shared/tmux'
import type { DialogResult, DialogSpec } from './Dialog'
import type { AiProvider, UiState } from '@shared/types'

// SSH 복원 결과 — Shell 의 connectProfile 을 감싼다. 성공 시 새 세션 id, 실패 시 사유.
/**
 * SSH 재접속 결과.
 *
 * 🔴 실패 사유가 **닫힌 목록**이다(`RestoreError['reason']` 과 같은 축) + `'shown'` 하나.
 * `'shown'` 은 **화면 문구가 아니라 신호**다 — `connectProfile` 이 이미 호스트키 창·비밀번호 창·
 * 실패 안내로 말했으니 호출측은 **조용히 넘어가라**는 뜻이다. 그래서 카드에도 토스트에도 닿으면
 * 안 되고, 두 호출측이 각각 그것을 거른다(안 걸렀던 것이 1.0.11 의 결함이었다).
 */
export type SshRestoreResult =
  | { ok: true; id: string }
  | { ok: false; reason: RestoreError['reason'] | 'shown' }

// 메인 영역: 터미널 탭바(서버 그룹) + 분할 그리드(F4a). 세션별 xterm 은 마운트 유지, 표시만 토글.
// 탭바·트리·패널이 sessions 스토어 하나를 공유(이중 상태 금지, F4b).
export type MainAreaHandle = {
  activateSession: (id: string) => void
  // 트리 우클릭 "세션 종료" — 탭 닫기와 같은 경로(레이아웃 정리 + destroy)를 재사용한다.
  closeSession: (id: string) => void
  // 새 로컬 셸 — 세션 생성과 패널 배치가 한 경로여야 한다(사이드바·트리도 이 핸들을 쓴다).
  newLocal: () => void
  // 트리 우클릭 "이름 변경" — 탭바의 인라인 편집을 연다(편집 UI 는 탭 한 곳에만 둔다).
  beginRename: (id: string) => void
  // R4.1 메뉴바: 단축키가 없는 항목은 여기로 온다(설정은 R5 에서 Ctrl+, 가 생겨 keydown 경로로 갔다).
  openCheatsheet: () => void
  zoomFont: (delta: number) => void
  // W1 F13: [파일] 탭에서 고른 원격 로그를 메인 영역 하단 뷰어로 연다(새 창 금지).
  /**
   * 2026-08-18: Shell 도 한 줄 안내가 필요해졌다(AI CLI 창을 없애면서 — 폴더를 모르는 세션에서
   * 그냥 넘어가면 "눌렀는데 아무 일도 안 남"이 된다). 토스트 구현을 Shell 에 또 만들지 않는다.
   */
  toast: (msg: string, action?: ToastAction) => void
  /** 아라 채팅 v2: 채팅 선택기에서 API 모델을 바꾼다 — 설정 ui.aiModels[provider] 를 고친다(prefs 주인이 여기다). */
  setAiModel: (provider: AiProvider, model: string) => void
}

/** R16: 토스트에 버튼 하나 — [내 신고] 새 소식의 [보기]. 버튼이 있으면 좀 더 오래 머문다. */
export type ToastAction = { label: string; run: () => void }

type MainAreaProps = {
  sessions: ReturnType<typeof useSessions>
  // ssh 세션 복제(같은 프로필 재접속). local 은 MainArea.open() 으로 처리. Shell 이 주입(F4c).
  onDuplicateSession?: (session: Session) => void
  // F6: 프로필로 SSH 재접속(복원·재시도). Shell 이 주입 — 성공 시 새 세션 id 반환.
  sshRestore?: (profileId: string, size?: { cols: number; rows: number }) => Promise<SshRestoreResult>
  // 탭바 ＋ 메뉴·빈 상태의 "SSH 연결…" → 연결 관리자 열기(Shell 소유).
  onOpenConnManager?: () => void
  // F27: 탭바 ＋ 메뉴의 "AI CLI 시작…" → 그 창 열기(창 상태도 Shell 소유 — onAskAi 와 같은 이유).
  onOpenAiCli?: () => void
  /**
   * 2026-08-18: 우클릭 [AI 실행 ▸ …] — **창 없이** 지금 세션·지금 폴더에서 바로 띄운다.
   * 플래그는 그 CLI 로 마지막에 시작할 때 쓴 값을 재사용한다(Shell 이 최근 목록을 갖고 있다).
   */
  onRunAiCli?: (cli: 'claude' | 'codex' | 'gemini') => void
  /**
   * 1.0.8 ②: 끊김 카드에서 그 AI 를 되살린다 — 성공하면 **새 세션 id**(카드 자리를 그것으로 갈아
   * 끼운다). sshRestore 와 같은 결의 주입이다: 띄우는 일은 Shell 이 하고(플래그·최근 목록이 거기
   * 있다), 화면 자리를 바꾸는 일은 여기서 한다.
   */
  /** sessionId: 카드가 얹힌 셸 — 거기 친다(2026-10-12). 돌려준 id 가 같으면 갈아 끼울 것이 없다. */
  onResumeAi?: (cli: AiCliId, cwd: string, sessionId?: string) => Promise<string | null>
  // R5 설정 창 [정보] 섹션에 찍을 앱 버전(Shell 이 app.getVersion 으로 이미 들고 있다).
  version: string
  // 활성 세션의 OSC7 cwd(Shell 이 구독). 저장 트리거로만 쓴다 — cwd 가 바뀌면 스냅샷의 세션 cwd 도
  // 다시 내려써야 재시작 복원이 마지막 폴더로 돌아온다.
  activeCwd?: string | null
  // F8: 링크 라우팅 실패(로컬 포트 점유)를 알릴 다이얼로그. Shell 의 단일 인스턴스를 받는다.
  ask?: (spec: DialogSpec) => Promise<DialogResult>
  /** 한 줄 입력이 필요한 액션(tmux 새 세션 이름). 트리 메뉴와 같은 다이얼로그를 쓴다. */
  askText?: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  // F16: 아라 패널 열기(+선택 텍스트 프리필). 패널 상태의 주인은 Shell 이라 handle 대신 prop 으로
  // 내려받는다(handle 은 Shell→MainArea 방향이므로 이쪽이 diff 가 작다 — 설계 §4.6).
  onAskAi?: (selection: string) => void
  /** 우클릭 [로그 저장] — 로그 패널을 연다(패널의 [내려받기]가 실제 저장을 한다). */
  onOpenLog?: () => void
  // FB-ui2: 설정 창의 열림 상태 주인은 이 컴포넌트다(Ctrl+, keydown 이 여기서 배선된다) — 우측
  // 액티비티 바가 "지금 열려 있나"를 표시하려면 그 값을 Shell 로 되돌려줘야 한다(미러 콜백,
  // onAskAi 와 반대 방향).
  onSettingsOpenChange?: (open: boolean) => void
  /** 액티비티 바 [명령어 북] 아이콘 활성 표시용 미러(설정과 같은 방식 — 상태 주인은 여기다). */
  onCommandBookOpenChange?: (open: boolean) => void
  /** 새 로컬 셸을 열면 사이드바를 [파일] 탭으로 — 사이드바 상태의 주인은 Shell 이라 요청만 한다. */
  onRevealFiles?: () => void
  /**
   * 2026-08-20: AI CLI 기본 플래그(설정 [AI]). onSettingsOpenChange 와 같은 미러 —
   * prefs 의 주인이 여기라, 실행하는 쪽(Shell.runAiCliNow)에 값을 올려 준다.
   */
  onAiCliFlags?: (flags: Record<string, string[]>) => void
  /** 아라 채팅 v2: API 모드 공급자·모델(설정 ui.aiProvider · ui.aiModels) 미러 — 채팅 선택기가 쓴다. */
  onAiApi?: (a: { provider: AiProvider; model: string }) => void
  /** #78: 터미널 **아래** 패널(포트·세션 기록). 상태의 주인은 Shell 이라 다 만들어진 노드를 받는다
      — 타이틀바가 통합 검색(omni)을 받는 것과 같은 방식이다. .main 안에 있어야 폭이 아니라
      세로를 먹는다(레일과 달리 터미널 80칸에 영향이 없다). */
  bottom?: React.ReactNode
  /**
   * F32: **떼어낸 창**인가. 본창이면 undefined.
   *
   * 이 플래그가 끄는 것 둘 — 둘 다 켜 두면 조용히 데이터를 망친다:
   *  ① **부트 복원**: 보조 창에서 또 돌면 저장된 세션이 **두 벌** 생긴다(main.tsx 머리주석이
   *     편집기·RDP 창에 대해 같은 경고를 남겨 뒀다 — 그때는 Shell 자체를 안 그려서 피했다).
   *  ② **스냅샷 저장**: 이 창은 세션 일부만 본다. 그대로 저장하면 본창이 가진 나머지 세션이
   *     스냅샷에서 사라진다(창별 저장은 R2 의 workspace v6 에서 붙인다).
   */
  detachedWinId?: string
}

let errSeq = 0
const nextErrorId = () => `restore-error:${(errSeq += 1)}`

export const MainArea = forwardRef<MainAreaHandle, MainAreaProps>(
  function MainArea(
    {
      sessions,
      onDuplicateSession,
      sshRestore,
      onOpenConnManager,
      onOpenAiCli,
      onRunAiCli,
      onResumeAi,
      version,
      activeCwd,
      ask,
      askText,
      onAskAi,
      onOpenLog,
      onSettingsOpenChange,
      onCommandBookOpenChange,
      onRevealFiles,
      onAiCliFlags,
      onAiApi,
      bottom,
      detachedWinId
    },
    ref
  ) {
    const {
      sessions: list,
      groups,
      activeId,
      mru,
      open,
      restoreLocal,
      close,
      select,
      rename,
      applyTitle,
      reorder
    } = sessions
    const layout = useLayout(null)
    // 세션 점(#166)이 바뀌면 다시 그린다 — 탭바와 칸 머리가 둘 다 이 컴포넌트 밑에 있다.
    // RDP 단계는 세션 목록도 레이아웃도 건드리지 않으므로 이 구독이 없으면 점이 멈춘다.
    useSessionStates()
    // 지금 목록의 최신 사본. **늦게 도착한 요청**이 자기가 만들어질 때의 낡은 목록을 보지 않게
    // destroySessions 가 여기서 읽는다(제보 ④ — store/sessions.ts 의 listRef 와 같은 이유).
    const listRef = useRef<Session[]>(list)
    listRef.current = list
    // 탭 인라인 편집 대상(R2.1). 시작점이 둘(탭 더블클릭 / 트리·탭 우클릭)이라 상태는 여기 하나만 둔다.
    const [editingId, setEditingId] = useState<string | null>(null)
    // ESC 취소 직후 blur 가 한 번 더 커밋을 부르는 것을 막는 가드(렌더 밖에서 판정해야 한다).
    const editRef = useRef<string | null>(null)
    // F6 부분 복원(C-4): SSH 재접속 실패 패널. sessionId(placeholder) → 오류 정보. 재시도 버튼 렌더.
    const [restoreErrors, setRestoreErrors] = useState<Map<string, RestoreError>>(new Map())
    const restoredRef = useRef(false) // 부트 복원 1회 가드(StrictMode 이중 마운트 방지).
    /**
     * F6 부트 복원이 **끝났나**. 아래 `session:opened` 리스너의 자물쇠다.
     *
     * 🔴 이 가드가 없으면 부팅이 깨진다(2026-09-10 실측). `session:opened` 는 main 이
     * `session:create` **응답보다 먼저** 보내는데도 렌더러에는 **늦게** 닿는다 — 복원 3개를 재 보니
     * `layout.restore()` 가 끝난 **뒤에** 마지막 `opened` 가 배달됐다. 지금은 그 핸들러가 layout 을
     * 안 건드려서 무해하지만, 리스너를 붙이는 순간 늦게 온 그것이 `showSession(마지막 세션)` 을
     * 불러 **저장해 둔 칸 대신 "마지막으로 만든 세션"이 뜬다.**
     *
     * ⚠️ 읽기로는 반대 결론이 났던 자리다("복원이 마지막이라 이긴다"). 하네스를 실앱과 **같은
     * 순서**로 고치고 나서야 뒤집혔다 — 순서가 다른 재현은 반증이 못 된다.
     *
     * 떼어낸 창은 복원 자체를 건너뛰므로(아래 `if (detachedWinId) return`) 처음부터 열어 둔다.
     */
    const [restoreDone, setRestoreDone] = useState(Boolean(detachedWinId))
    /**
     * 🔴 **복원이 만든 세션의 id.** 리스너는 이 집합에 든 것을 **언제 오든** 무시한다.
     *
     * `restoreDone` 만으로는 부족하다 — 그건 **시간**으로 거르는데 그 경계가 경합이다.
     * `setRestoreDone(true)` 는 React 상태 갱신이라 리렌더 → 이펙트 부착까지 몇 틱이 걸리고,
     * 늦게 배달된 `opened` 가 그 뒤에 오면 리스너가 이미 붙어 있다. **실측으로 졌다**
     * (2026-09-10: 한 번은 `칸 ["new-2"]` 로 통과했다가 다음 판에서 `["new-3"]` 로 깨졌다 —
     * 코드가 아니라 타이밍이 바뀐 것이다. **한 번 통과한 것을 통과로 읽으면 안 되는 부류다.**)
     *
     * 신원으로 거르면 타이밍이 안 걸린다. 둘을 함께 둔다:
     *  · 이르게 오면 → `restoreDone` 이 아직 false 라 무시
     *  · 늦게 오면   → 그 id 가 이 집합에 있어 무시
     */
    const restoredIds = useRef<Set<string>>(new Set())
    const uiRef = useRef<UiState | null>(null) // 로드한 ui(persist 시 유지).
    const [toast, setToast] = useState<{ msg: string; action?: ToastAction } | null>(null)
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
    // F18 명령어 북 — 치트시트와 같은 오케스트레이터(ContextInteractions)가 열림 상태를 함께 관리.
    const [commandBookOpen, setCommandBookOpen] = useState(false)
    // FB-monitor: 설정 [단축키] "tmux 사용법 보기" 진입점 — 연 시점의 카테고리만 지정, 열려 있는 동안엔 안 바뀐다.
    const [commandBookQuery, setCommandBookQuery] = useState<string | undefined>(undefined)
    // R3.2 터미널 내 검색 바(Ctrl+Shift+F). 포커스 패널의 세션을 검색한다.
    const [searchOpen, setSearchOpen] = useState(false)
    // W1 F13 로그 뷰어(파일 탭 우클릭 [tail로 보기]). 한 번에 하나만 — 다른 파일을 고르면 갈아탄다.
    // 설정 창 — 열림 상태 + 폰트(F5)·터미널 동작(R5) 스토어(하이드레이트/실시간 적용/영속).
    const [settingsOpen, setSettingsOpen] = useState(false)
    const { font, update: updateFont } = useFont()
    const { prefs, update: updatePrefs } = useUiPrefs()

    const showToast = useCallback((msg: string, action?: ToastAction) => {
      setToast({ msg, action })
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), action ? 8000 : 2200)
    }, [])

    // 다중 모니터 RDP 안내(모니터 한 장·이미 열림·죽은 영역)를 여기 토스트로 보낸다 —
    // PaneGrid 는 다이얼로그도 토스트도 갖고 있지 않다.
    useEffect(() => setSpanNotifier(showToast), [showToast])
    // 터미널 Ctrl+V 가 업로드로 못 넘어가 텍스트 붙여넣기로 떨어졌을 때 — 2026-08-16.
    useEffect(() => setUploadNotifier(showToast), [showToast])
    // 클립보드 쓰기·읽기가 거부되면(창 비활성 등) 조용히 삼키지 않고 여기로 낸다 — 2026-08-13.
    useEffect(() => setClipboardNotifier(showToast), [showToast])

    // F8 터미널 링크 라우팅. planLink 가 목적지를 정하고 여기서 그대로 집행한다:
    //   external → OS 기본 브라우저(기존 동작) / loopback·oauth → 포워딩 후 내장 브라우저.
    // 포워딩 생성은 이 클릭(명시적 사용자 제스처)에서만 출발한다 — 텔레메트리 감지만으로는 만들지 않는다.
    const openLink = useCallback(
      async (sessionId: string, url: string, isSsh: boolean, external?: boolean) => {
        // Ctrl+Alt+클릭 — 판단할 것이 없다. 사용자가 "저쪽으로"라고 말한 것이다(제보 6번).
        // 터널도 열지 않는다: OS 브라우저는 내 PC 의 loopback 을 볼 이유가 없다.
        if (external) {
          void window.ev?.app.openExternal(url)
          return
        }
        const plan = planLink(url, isSsh)
        if (plan.kind === 'external') {
          void window.ev?.app.openExternal(plan.url)
          return
        }
        // 포워딩이 필요 없는 원격 링크 — 터널을 만들지 않고 내장 브라우저로만 보낸다(제보 16번).
        if (plan.kind === 'inApp') {
          void window.ev?.browser.open(plan.url)
          return
        }
        // OAuth 링크는 터널을 여는 포트가 바깥쪽 URL 의 쿼리(redirect_uri)에 묻혀 있다 — 사용자가 보는
        // 링크 텍스트만으로는 터널이 열린다는 것도, 어느 포트인지도 알 수 없다. 목적지 고정 불변식은
        // 그대로지만(원격 127.0.0.1) 원격이 인쇄한 링크로 내 PC loopback 에 원격 서비스가 상주하게 되므로
        // 무엇이 열리는지 보여 주고 동의를 받는다. 자기설명적인 loopback 링크는 현행 원클릭 유지.
        if (plan.kind === 'oauth') {
          const r = await ask?.({
            title: t('fwd.oauth.title'),
            message: t('fwd.oauth.message'),
            detail: [
              { label: t('fwd.oauth.port'), value: String(plan.port) },
              { label: t('fwd.oauth.origin'), value: new URL(plan.url).origin }
            ],
            confirmLabel: t('fwd.oauth.confirm')
          })
          if (r !== 'confirm') return
        }
        // OAuth 는 redirect_uri 에 포트가 박혀 오므로 그 번호가 아니면 의미가 없다(exactPort).
        const res = await window.ev?.forward
          .create(sessionId, plan.port, plan.kind === 'oauth')
          .catch(() => null)
        if (!res || !res.ok) {
          // 임의 포트로 조용히 넘어가지 않는다 — 사용자는 "브라우저는 떴는데 인증이 안 끝나는" 상태를
          // 스스로 진단할 수 없다. 무엇이 막았는지 그대로 알린다.
          await ask?.({
            title: t('fwd.fail.title'),
            message: res ? res.message : t('fwd.fail.generic'),
            detail: [{ label: t('fwd.fail.port'), value: String(plan.port) }],
            confirmLabel: t('dlg.ok'),
            cancelLabel: null
          })
          return
        }
        void window.ev?.browser.open(localUrl(plan, res.forward.localPort))
      },
      [ask]
    )

    // F6 부트 복원: 스냅샷 로드 → 터미널 동작 설정 적용 → 저장된 세션/레이아웃/cwd 재구성.
    // 부분 복원(C-4): 로컬은 cwd 로 재스폰, SSH 는 프로필로 재접속. SSH 실패 패널만 오류 카드(재시도),
    // 나머지 세션·분할·활성 탭은 정상 복원. 복원 직후 스냅샷을 재저장해 새 세션 id 로 정합을 맞춘다.
    useEffect(() => {
      // F32: 떼어낸 창은 복원하지 않는다 — 여기서 또 돌면 저장된 세션이 두 벌 생긴다.
      // (그 창의 세션은 본창에서 떼어져 온 것이라 이미 main 에 살아 있다.)
      if (detachedWinId) return
      if (restoredRef.current) return
      restoredRef.current = true
      let cancelled = false
      void (async () => {
        /**
         * ⚠️ **`finally` 로 켠다 — 출구를 세지 않는다.** 이 본문의 이른 return 이 다섯이고
         * (스냅샷 없음·취소·복원할 것 없음·루프 안 취소·마지막 취소) 앞으로 더 생긴다.
         * 하나라도 빠뜨리면 그 경우에만 리스너가 **영영 안 붙어** 원래 버그가 조용히 살아남는다 —
         * 안 켜지는 실패가 안 꺼지는 실패보다 찾기 어렵다. 던져도 켜지는 것이 옳다.
         */
        try {
        const snap = await window.ev?.workspace.load().catch(() => null)
        if (!snap || cancelled) return
        // R3.1/R3.4/R5: 스크롤백·선택자동복사·커서는 xterm 생성 시점에 필요하다 — 세션을 되살리기
        // 전에 적용한다. useUiPrefs 도 같은 값을 하이드레이트하지만 그쪽은 렌더 사이클을 한 번 기다린다.
        applyUiPrefs(prefsFrom(snap.ui))
        uiRef.current = snap.ui
        const plan = planRestore(snap)
        if (plan.items.length === 0) return // 빈 시작 — placeholder 유지.

        // oldId → 새 세션 id(또는 오류 placeholder id). 모든 세션을 순서대로 재생성.
        const idMap = new Map<string, string>()
        const errs = new Map<string, RestoreError>()
        let firstReal: string | null = null
        for (const item of plan.items) {
          if (cancelled) return
          /**
           * 🔴 **칸에 설 자리가 있을 때만** 카드로 바꾼다(2026-09-10 실측으로 잡았다).
           *
           * 카드는 `PaneGrid` 의 슬롯 안에서만 그려진다 — 그 세션이 칸에 없었으면 placeholder 는
           * **탭도 카드도 없이 사라진다**(하네스 ①: `tabs` 에 셸 하나, `stash` 도 빔).
           * 배경 탭이던 AI 세션이 재시작 뒤 흔적도 없이 없어지는 것은 **원래 버그보다 나쁘다** —
           * 전에는 맨 셸로라도 남았다. 탭을 조용히 지우는 것이 이 라운드의 목적이 아니다.
           *
           * 그래서 칸에 없던 AI 탭은 **예전처럼 셸로 되살린다.** 그 판이 좋아서가 아니라
           * 없애는 것보다 낫기 때문이고, 다시 띄우는 길은 사이드바 [AI] 의 작업대 줄이 갖고 있다.
           * (placeholder 를 탭으로도 세우는 것이 완전한 답인데, 그러면 SSH 복원 실패까지 같이
           * 바뀐다 — 이 라운드의 범위가 아니다. 다음 라운드 항목으로 둔다.)
           */
          if (item.kind === 'local') {
            const id = await restoreLocal({
              type: 'local',
              title: item.session.title,
              serverKey: item.session.serverKey,
              cwd: item.session.cwd,
              profileId: null,
              shell: item.session.shell,
              // 사용자가 바꿔 둔 이름은 재스폰 후에도 셸 OSC 제목에서 지켜 준다(R3.6).
              manualTitle: item.session.manualTitle,
              // 마지막으로 쓰던 치수로 연다 — 안 주면 80×24 라 첫 프롬프트가 접힌다
              // (2026-09-16 준영님 제보 · `Session.cols` 주석). 없으면 옛 스냅샷이니 예전 동작.
              // 🔴 쓸 만할 때만(`shared/termSize.ts`) — 9×4 가 저장돼 있어 첫 줄이 9칸에서 접혔다(#2 신고).
              ...(usableSize(item.session.cols, item.session.rows)
                ? { cols: item.session.cols, rows: item.session.rows }
                : {})
            })
            idMap.set(item.oldId, id)
            restoredIds.current.add(id) // 만든 **즉시** 담는다 — 몰아 담으면 그 사이가 또 경합이다
            if (!firstReal) firstReal = id
            /**
             * 🔴 **AI 세션은 셸 위에 카드를 얹는다**(1.0.9 — 1.0.8 의 방향을 뒤집었다).
             *
             * 앱을 끄면 pty 와 그 안의 CLI 가 함께 죽는다. 그 자리에 맨 셸만 띄우면 "AI 탭인데
             * 아무것도 없는 셸"이라 무엇이 돌고 있었는지 단서가 없다(준영님 원 제보).
             *
             * 1.0.8 은 셸을 **안 띄우고** placeholder 로 뒀는데 실기에서 거의 안 떴다 —
             * 카드는 `PaneGrid` 의 **칸 안에서만** 그려지고 AI 탭은 보통 배경 탭이다
             * (준영님 스냅샷 실측: `aiCli=claude` 세션이 칸 밖에 있었다). 칸에 없으면 탭까지
             * 사라져서 `panedIds` 로 좁혔더니, 이번엔 카드가 뜨는 경우가 거의 없어졌다.
             *
             * 그래서 **세션은 예전대로 만들고**(탭이 남는다) 그 **실 세션 id 에 오류를 얹는다** —
             * `PaneGrid` 의 "쓰던 중 끊김" 갈래(`err && session`)가 터미널 **위에** 카드를 그린다.
             * 그 배선은 2026-08-14 부터 있던 것이라 여기서 재사용만 한다.
             *  · 배경 탭이어도 그 탭을 누르면 카드가 보인다
             *  · 사라지는 탭이 없다
             *  · [닫기]를 누르면 카드만 걷히고 **그 아래 셸이 그대로 남는다**
             */
            const aiCli = aiCliOf(item.session.aiCli)
            if (aiCli) {
              errs.set(id, {
                sessionId: id,
                profileId: null,
                title: item.session.title,
                serverKey: item.session.serverKey,
                reason: 'aiEnded',
                aiCli,
                ...(item.session.cwd ? { cwd: item.session.cwd } : {})
              })
            }
          } else {
            // SSH: 프로필로 재접속. 실패(네트워크/인증/고아) 시 오류 패널(재시도) — 전체 실패 아님.
            // 저장해 둔 치수로 연다 — 없으면(옛 스냅샷) 예전대로 main 이 80×24 로 열고 마운트
            // 직후 resize 가 따라잡는다. `Session.cols` 주석에 왜 그것이 부족한지 적혀 있다.
            const savedSize =
              usableSize(item.session.cols, item.session.rows)
                ? { cols: item.session.cols as number, rows: item.session.rows as number }
                : undefined
            const res =
              item.profileId && sshRestore
                ? await sshRestore(item.profileId, savedSize)
                : ({ ok: false, reason: 'orphan' } as const)
            if (res.ok) {
              idMap.set(item.oldId, res.id)
              restoredIds.current.add(res.id)
              // 재접속은 프로필명으로 세션을 만든다. 사용자가 바꿔 둔 이름이 스냅샷에 있으면 그쪽이 우선(R2.1).
              // 자동(OSC) 제목이었다면 되씌우지 않는다 — 되씌우면 manualTitle 이 켜져 이후 갱신이 막힌다(R3.6).
              if (item.session.manualTitle && item.session.title) rename(res.id, item.session.title)
              if (!firstReal) firstReal = res.id
            } else {
              const errId = nextErrorId()
              errs.set(errId, {
                sessionId: errId,
                profileId: item.profileId,
                title: item.session.title,
                serverKey: item.session.serverKey,
                /**
                 * 🔴 `'shown'` 은 **화면에 그릴 사유가 아니다**(Shell.sshRestore 주석 참고) —
                 * 카드가 `t('restore.reason.' + reason)` 으로 그리는데 그 키가 없어서
                 * **`restore.reason.shown` 이 글자 그대로 찍힌다.** 이미 사용자가 그 실패를
                 * 화면에서 봤으니(비밀번호 창·호스트키 창) 카드는 일반 사유로 돌아간다.
                 * 1.0.11 이 만든 회귀이고 배포 전에 잡았다.
                 */
                reason: res.reason === 'shown' ? 'dropped' : res.reason
              })
              idMap.set(item.oldId, errId)
            }
          }
        }
        if (cancelled) return
        // 패널에 배치할 세션만 layout 순서대로(나머지는 배경 탭으로 남는다).
        const paneIds = plan.panedIds.map((oldId) => idMap.get(oldId)).filter((v): v is string => Boolean(v))
        setRestoreErrors(errs)
        layout.restore({
          sessionIds: paneIds,
          colRatio: plan.colRatio,
          rowRatio: plan.rowRatio,
          pairAxis: plan.pairAxis
        })
        // 활성 탭은 첫 패널의 세션 — 이제 생성 순서가 탭 순서라 "먼저 만든 것"과 다를 수 있다.
        const focusId = paneIds.find((id) => !errs.has(id)) ?? firstReal
        if (focusId) select(focusId)

        /**
         * F32 R2: 떼어냈던 창을 되살린다 — **세션을 다 만든 뒤에** 해야 한다.
         *
         * 복원은 세션을 새로 만들므로 id 가 전부 바뀐다(pty 는 재시작을 못 넘는다). 그래서
         * 스냅샷의 `winId` 를 **새 id 에 다시 붙여** main 에 넘긴다. 창을 여는 것도 main 이
         * 그 직후에 한다(win:restore 한 호출로 묶인 이유 — 순서가 뒤집히면 빈 창이 뜬다).
         *
         * 오류 패널 자리는 넘기지 않는다: 그 세션은 되살아나지 못했고, 그 창에 남은 것이
         * 하나도 없으면 main 이 창 자체를 열지 않는다(빈 창을 띄우지 않는다).
         */
        const assign = plan.items
          .map((item) => ({ sessionId: idMap.get(item.oldId) ?? '', winId: item.session.winId ?? '' }))
          .filter((a) => a.sessionId && a.winId && !errs.has(a.sessionId))
        if (assign.length > 0 && snap.windows && snap.windows.length > 0) {
          await window.ev?.window.restoreWindows(assign, snap.windows).catch(() => null)
        }
        } finally {
          setRestoreDone(true)
        }
      })()
      return () => {
        cancelled = true
      }
      // 마운트 1회만 실행(restoredRef 가드). deps 의도적으로 비움.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // 설정 드로어: ESC 로 닫기(a11y MVP — 계획서 접근성 섹션).
    useEffect(() => {
      if (!settingsOpen) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setSettingsOpen(false)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [settingsOpen])

    // FB-ui2: 액티비티 바의 [설정] 아이콘 활성 표시용 미러(위 prop 설명 참고).
    useEffect(() => {
      onSettingsOpenChange?.(settingsOpen)
    }, [settingsOpen, onSettingsOpenChange])

    // 2026-08-22 제보 9번: 명령어 북도 액티비티 바 항목이 됐다 — 같은 미러가 필요하다.
    useEffect(() => {
      onCommandBookOpenChange?.(commandBookOpen)
    }, [commandBookOpen, onCommandBookOpenChange])

    useEffect(() => {
      onAiCliFlags?.(prefs.aiCliFlags)
    }, [prefs.aiCliFlags, onAiCliFlags])

    useEffect(() => {
      onAiApi?.({ provider: prefs.aiProvider, model: prefs.aiModels[prefs.aiProvider] })
    }, [prefs.aiProvider, prefs.aiModels, onAiApi])

    // #138: 스냅샷을 한 번이라도 읽었나. "안 지났다"와 "아직 안 읽었다"를 갈라야 한다 —
    // 기본값이 false 라 로드 전에 판정하면 이미 지난 사람에게도 매번 뜬다.
    const [prefsLoaded, setPrefsLoaded] = useState(false)
    // #139 부팅 인사. **한 번만** 뜬다(창을 다시 그려도 아니다) — 모듈 변수로 그걸 기억한다.
    const [splashDone, setSplashDone] = useState(bootSplashShown)
    useEffect(() => {
      window.ev?.workspace
        .load()
        .then(() => setPrefsLoaded(true))
        .catch(() => setPrefsLoaded(true))
    }, [])

    // 인사(#139)와 호칭 묻기(#138)가 지금 떠 있는가. 아래 JSX 두 곳과 업데이트 알림 창이 **같은 값**을
    // 본다 — 판정이 세 벌이면 언젠가 갈린다.
    const splashOpen = shouldShowBootSplash({ detachedWinId, prefsLoaded, bootSplash: prefs.bootSplash, splashDone })
    const welcomeOpen = !detachedWinId && prefsLoaded && !prefs.araWelcomeSeen && (splashDone || !prefs.bootSplash)

    /**
     * #98 업데이트 알림 — 켤 때 한 번 [나중에]/[받기] 를 묻는다(2026-09-04 준영님 0.9.9 실기).
     *
     * **본창에서만**(`detachedWinId`) 그리고 **인사가 지나간 뒤에만.** 첫 확인은 앱 기동 20초 뒤라
     * (`registerUpdateIpc.ts` FIRST_CHECK_MS) 2초짜리 부팅 인사와는 어차피 안 겹치지만, 호칭 묻기는
     * 사람이 답할 때까지 떠 있어 20초를 넘길 수 있다 — 그 위에 창을 얹으면 처음 켠 사람이 이름을
     * 주다 말고 모르는 버전 이야기를 듣는다.
     *
     * ⚠️ `prefsLoaded` 를 따로 본다. 위 두 값은 스냅샷을 읽기 **전에도 false** 라(그래야 이미 지난
     * 사람에게 인사가 다시 안 뜬다) 그 사이엔 "안 떠 있다"와 "아직 모른다"가 같은 얼굴이다 —
     * #138 이 prefsLoaded 를 둔 것과 같은 이유다.
     */
    /**
     * #198 업데이트가 일어나고 있다는 표시. **본창에서만** — 떼어낸 창마다 뜨면 셋이 동시에 뜬다
     * (`useUpdatePrompt` 와 같은 자물쇠를 쓴다).
     */
    const updSt = useUpdateState()
    const [installing, setInstalling] = useState(false)
    const onInstalling = useCallback(() => setInstalling(true), [])
    useUpdatePrompt(!detachedWinId && prefsLoaded && !splashOpen && !welcomeOpen, ask, onInstalling)

    /**
     * 설치가 끝나고 **다시 뜬 직후** 한 번 알린다. 저장값이 없으면(처음 깐 사람) 조용히 적어만 둔다 —
     * 업데이트한 적 없는 사람에게 "업데이트되었습니다"는 거짓말이다.
     */
    useEffect(() => {
      if (detachedWinId || !version || !ask) return
      const seen = readSeenVersion()
      const updated = justUpdated(seen, version)
      // 🔴 **먼저 적어 둔다.** 아래가 await 를 타므로, 여기서 안 적으면 그 사이 이펙트가 다시 돌아
      // 같은 창을 두 번 띄운다(StrictMode 이중 마운트가 그 경로다).
      if (seen !== version) writeSeenVersion(version)
      if (!updated) return
      void (async () => {
        /**
         * 1.0.12: 업데이트 직후 **창으로** 알리고 패치 내역을 연다(준영님: *"vscode 처럼
         * 업데이트하면 창 하나 띄워서 거기서도 보여주는 건 어때?"* · 자동으로 띄우기로 확정).
         *
         * 그전에는 토스트 한 줄이라 **놓치면 끝**이었다. 무엇이 바뀌었는지 보려면 사이트를
         * 따로 찾아가야 했다.
         * ⚠️ 패치 내역은 **사이트 페이지를 연다** — 앱에 베껴 넣지 않는다(`CHANGELOG_URL` 주석).
         */
        const r = await ask({
          title: t('update.done.title').replace('{v}', version),
          message: t('update.done.msg'),
          confirmLabel: t('update.done.notes'),
          cancelLabel: t('dlg.close')
        })
        if (r !== 'confirm') return
        // 사내망 밖이면 안 열린다 — **조용히 넘어가지 않는다.** 실패는 화면이 말해야 한다.
        const opened = await window.ev?.browser?.open(CHANGELOG_URL).catch(() => null)
        if (!opened) showToast(t('update.done.notesFailed'))
      })()
    }, [detachedWinId, version, showToast, ask])

    // 새 로컬 셸: 세션 생성 → 포커스 패널에 표시(패널이 없으면 첫 패널 생성).
    // "activeId 가 있으면 패널을 만든다"는 이펙트로 처리하면 layout 이 매 렌더 새 객체라 이펙트가 매 렌더 돌고,
    // 마지막 패널을 닫는 즉시 같은 사이클에서 패널이 되살아난다(× 무반응). 그래서 필요한 지점에서만 호출한다.
    const openLocal = useCallback(async () => {
      const id = await open()
      layout.showSession(id)
      // 2026-08-22 준영님 재제보(6번): 로컬 셸을 열어도 [파일] 탭으로 안 넘어간다.
      // 앞선 시도는 Shell 의 newLocal 한 곳만 고쳤는데, 셸을 여는 길은 **여기로 모이는 셋**이다
      // (탭바 ＋ · Ctrl+` 터미널 토글 · 세션 복제). 갈래마다 붙이는 대신 합류 지점에 한 번 둔다.
      onRevealFiles?.()
    }, [open, layout, onRevealFiles])

    /**
     * **칸이 하나도 없는데 세션은 남아 있으면** 활성 세션을 올린다. 두 자리에서 필요하다:
     *
     * ① F32 떼어낸 창 — 세션을 **받아만** 오므로(본창에서 떼어져 왔다) 올려 줄 사람이 없다.
     *    본창에는 그 일을 하는 경로가 둘 있다: 새 셸은 openLocal 이 showSession 을 부르고,
     *    부팅은 F6 복원이 레이아웃을 통째로 세운다. DETACH-3 이 이 상태를 잡았다.
     *
     * ② **본창** (2026-08-22 준영님 제보 2번 — "그 창을 닫으면 빈창으로 보임").
     *    칸에 올라와 있던 세션을 닫으면 close() 가 activeId 를 옆 탭으로 옮기는데, 그 탭을
     *    그릴 칸은 아무도 안 만든다 — 탭은 있고 화면은 비는 상태가 된다. 예전엔 이 이펙트가
     *    `!detachedWinId` 로 본창을 아예 빼고 있었다.
     *
     * 마지막 세션까지 닫으면 list 가 비어 showId 가 없다 → 이펙트가 돌지 않는다. 그래서 위
     * openLocal 주석이 경고한 함정(× 를 눌러도 칸이 곧바로 되살아나 무반응으로 보이는 것)에
     * 빠지지 않는다 — 되살릴 세션이 있을 때만 되살린다.
     */
    const paneCount = layout.cells.length
    const showId = activeId ?? list[0]?.id
    useEffect(() => {
      if (paneCount > 0 || !showId) return
      layout.showSession(showId)
      // layout 은 매 렌더 새 객체라 deps 에 넣으면 이펙트가 매 렌더 돈다(위 openLocal 주석과 같은 함정).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paneCount, showId])

    /**
     * 떼어낸 세션이 **있던 칸을 치운다** (2026-09-02 준영님 제보 ② — "창 분리하면 아라 기본 창에서는
     * 바로 이전 세션 창이 켜져야 하는데 안 켜지고 있어").
     *
     * 탭만 지우면 그 칸은 **아무것도 안 그리는 빈 자리**로 남는다: PaneGrid 는 슬롯을 `sessions`
     * 에서 만들므로 떠난 세션의 칸에는 그릴 것이 없고, 그래도 칸 수는 줄지 않아 위 이펙트도
     * ("칸이 하나도 없으면 활성 세션을 올린다") 돌지 않는다. 그래서 화면이 통째로 빈다.
     *
     * ✕ 로 닫을 때는 destroySessions 가 이미 같은 일을 한다(layout.removeSession + close) —
     * **떼어내기에만** 그게 없었다. 활성 탭을 옮기는 쪽 절반은 store/sessions.ts 의 nextActiveAfter 다.
     * 여기서 듣는 이유: 칸(layout)의 주인이 이 컴포넌트라 store 가 손댈 수 없다.
     */
    /**
     * 🔴 **세션이 생기면 칸에 올린다** — 다섯 자리가 여기 하나로 모인다(2026-09-10 준영님 제보:
     * *"해당 세션을 클릭하면 해당 창이 켜지긴 하는데 화면은 이전에 봤던 다른 세션창이야"*).
     *
     * 전에는 **세션을 만드는 자리마다** `selectSession` 을 손으로 불렀고, 그래서 빠진 데가 다섯이었다:
     * `Shell` 의 작업 프로필·AI CLI 로컬·[여기서 터미널 열기] 둘, 그리고 **아라가 MCP 로 연 세션**.
     * 다섯 다 SSH 짝에는 그 호출이 있고 로컬/자동 짝에만 없었다 — 손으로 채우는 규칙이라 새 문이
     * 생길 때마다 또 빠진다.
     *
     * **다섯이 이미 한 문을 지나고 있었다**: `MainSessionManager.register()` → `sink.opened`.
     * 그러니 만드는 쪽마다 적을 것이 아니라 **듣는 쪽에서 한 번** 하면 된다. 앞으로 생길 문도 덮는다.
     *
     * 준영님 결정(2026-09-10): 아라가 연 세션도 **칸까지** 가져간다. 그전에는 탭은 뺏고 화면은
     * 안 바꾸는 중간 상태였는데, 그건 고른 결과가 아니라 `adopt` 가 `touch` 를 품어서 생긴
     * 부수 효과였다(커밋 1e2540e 는 **탭 목록**만 목표였다 — 포커스는 한 글자도 안 적혀 있다).
     *
     * ⚠️ 대가: 타이핑 중에 아라가 세션을 열면 **손 밑에서 칸이 바뀐다.** 내용은 안 잃는다
     *    (배경 탭으로 남고 xterm 은 마운트를 유지한다) — 보이는 것만 바뀐다.
     * ⚠️ **RDP 는 이 문을 안 지난다**(`openRdp` 는 렌더러 전용이라 `session:create` 를 안 탄다).
     *    `Shell.tsx` 의 RDP `selectSession` 호출은 **남겨야 한다** — 지우면 RDP 가 다음 피해자다.
     * ⚠️ 뒷단 세션은 없다(전수 확인): 만드는 문은 셋뿐이고 전부 사람이 요청한 것이며, 아라의 둘은
     *    `writeAlways` 라 승인 창을 지난다. 포워딩은 세션이 아니고 SFTP·모니터링은 기존 세션을 쓴다.
     */
    const showPane = layout.showSession
    useEffect(() => {
      if (!restoreDone) return // 위 restoreDone 주석 — 이 줄이 없으면 F6 이 깨진다
      const off = window.ev?.session.onOpened?.((m) => {
        // 남의 창 세션은 건드리지 않는다(store/sessions.ts 의 편입 규칙과 **같은 기준**).
        if ((m.winId ?? undefined) !== detachedWinId) return
        // 복원이 만든 세션은 **언제 와도** 무시한다 — 칸은 layout.restore 가 정했다(위 주석).
        if (restoredIds.current.has(m.id)) return
        showPane(m.id)
      })
      // R14 탐색기에서 `아라` — 리스너를 붙인 **뒤에** 부른다(main 이 만든 셸의 opened 를 이 리스너가 받아
      // 칸에 올린다). 본창만: 떼어낸 창은 새 세션의 주인이 아니다. main 쪽은 한 번만 연다(openHere.ts).
      if (!detachedWinId) window.ev?.app.openLaunchDir?.().catch(() => null)
      return () => off?.()
    }, [restoreDone, detachedWinId, showPane])

    const removePane = layout.removeSession
    useEffect(() => {
      const off = window.ev?.window.onSessionMoved?.(({ sessionId, winId: to }) => {
        if ((to ?? undefined) === detachedWinId) return // 내 창으로 **온** 것 — 치울 칸이 없다
        removePane(sessionId) // 이 창에 없던 세션이면 아무 일도 안 한다
      })
      return () => off?.()
    }, [detachedWinId, removePane])

    /**
     * 🔴 **세션이 없어지면 칸을 치운다** — 위 `session:opened` 의 짝이다(#201 B).
     *
     * 아라가 MCP `session_destroy` 로 탭을 끄면(그 도구 설명은 *"탭을 닫는 것과 같습니다"* 다)
     * 그전에는 화면이 그것을 영영 몰랐다: 칸이 빈 자리로 남고, SSH 면 아래 `onExit` 감시가
     * **"연결이 끊겼습니다" [재접속] 카드**를 띄웠다 — 아라가 **일부러** 끈 세션에.
     *
     * ⚠️ **순서가 성립하는 근거**(지우지 말 것): main 은 `closed` → `kill()` → (백엔드) `exit`
     *    순으로 쏜다. 본창에서는 둘이 **같은 webContents 로 가는 같은 경로**라 그 순서가
     *    지켜지고, 그래서 여기서 표시를 남기면 뒤에 오는 exit 이
     *    `closedByUser.current.delete(s.id)` 에 걸려 조용히 지나간다.
     *    이 근거를 안 적으면 다음 사람이 순서를 바꾼다.
     * ⚠️ 떼어낸 창에서도 이제 exit 이 **이 창으로 온다**(#201 B-4, 1.0.14 에서 고쳤다 — 예전엔
     *    핸들을 지운 뒤 창을 찾아 본창으로 떨어졌다). `sink.exit` 이 지우기 전의 winId 를 함께
     *    넘기고 registerSessionIpc 가 그 창을 찾는다. 그래서 이 표시가 떼어낸 창에서도 **실제로**
     *    뒤따르는 exit 의 [재접속] 카드를 막는다 — 이제 보험이 아니라 본업이다.
     * ⚠️ 사용자가 ✕ 로 닫는 길은 이미 `destroySessions` 가 같은 표시를 남긴다 — Set 이라 두 번
     *    넣어도 무해하다. **그 길을 지우지 마라**(확인 다이얼로그가 거기 있다).
     */
    useEffect(() => {
      const off = window.ev?.session.onClosed?.((m) => {
        if ((m.winId ?? undefined) !== detachedWinId) return
        closedByUser.current.add(m.id)
        removePane(m.id)
      })
      return () => off?.()
    }, [detachedWinId, removePane])

    // F6 지속: 세션/레이아웃/활성 탭 변경 시 스냅샷을 저장한다(기존 30s 디바운스 flush 경로 재사용).
    // 세션 메타(cwd/profileId/type)의 진실은 main(session.list) — 렌더러가 중복 보관하지 않는다.
    // 오류 패널(placeholder)은 실제 세션이 아니므로 layout 에서 빼고 저장한다.
    // 보내는 것은 렌더러 소유 필드뿐이다(WorkspaceSaveInput) — profiles·knownHosts·ui 는 main 이 지킨다.
    const { cells, focusedId, colRatio, rowRatio, maximizedId, pairAxis } = layout
    const persist = useCallback(async () => {
      // F32: 떼어낸 창은 저장하지 않는다. 이 창은 세션 **일부만** 보므로, 그대로 저장하면
      // 본창이 가진 나머지가 스냅샷에서 사라진다(창별 저장은 R2 workspace v6).
      if (detachedWinId) return
      if (!uiRef.current) return // 아직 로드 전 — 저장하지 않음(빈 스냅샷 덮어쓰기 방지).
      const mainSessions = await window.ev.session.list()
      // 오류 패널 자리는 저장하지 않는다(실 세션 아님). F25: rdp 세션도 제외한다 — main 에 세션이
      // 없어 복원 대상이 아니고(비밀번호를 저장하지 않으므로 자동 재접속도 불가), 남겨 두면 복원 때
      // 존재하지 않는 세션을 가리키는 빈 칸이 생긴다.
      const panes = cells
        .map((c) => ({
          id: c.id,
          sessionId: restoreErrors.has(c.sessionId) || c.sessionId.startsWith('rdp:') ? '' : c.sessionId
        }))
        .filter((p) => p.sessionId)
      const layoutNode = toLayoutNode({ panes, focusedId, colRatio, rowRatio, maximizedId, pairAxis })
      // main 의 Map 순서는 생성 순이라 드래그 재정렬(R2.3)을 모른다 — 탭 순서로 다시 세운다.
      const tabOrder = new Map(list.map((s, i) => [s.id, i]))
      const ordered = [...mainSessions].sort(
        (a, b) => (tabOrder.get(a.id) ?? list.length) - (tabOrder.get(b.id) ?? list.length)
      )
      await window.ev.workspace.save({
        sessions: ordered,
        layout: layoutNode,
        tabGroups: groups.map((g) => ({ serverKey: g.serverKey, color: g.color, collapsed: false }))
      })
    }, [cells, focusedId, colRatio, rowRatio, maximizedId, pairAxis, restoreErrors, groups, list, detachedWinId])

    // 저장 트리거: persist 가 읽는 값이 실제로 바뀔 때만(deps 는 전부 안정 — 매 렌더 재실행 금지, M-1).
    // activeCwd 는 페이로드에 직접 들어가지 않지만 cwd 가 바뀌면 session.list 결과가 달라진다 —
    // 이게 없으면 셸에서 cd 만 하고 종료했을 때 스냅샷의 cwd 가 옛 값으로 남는다(F6 복원).
    useEffect(() => {
      void persist()
    }, [persist, activeCwd])

    // E2E 하네스가 "종료 직전 최신 상태 저장"을 강제할 수 있도록 최신 persist 를 노출(테스트 seam).
    // 앱 동작엔 영향 없음 — 프로덕션에서도 존재하지만 아무도 호출하지 않는다.
    useEffect(() => {
      ;(window as unknown as { __evPersist?: () => Promise<void> }).__evPersist = persist
    }, [persist])

    // 사용자가 의도적으로 닫은 세션 id. onExit 은 "닫았다"와 "끊겼다"를 구분해 주지 않으므로
    // 닫는 쪽에서 표시를 남긴다.
    const closedByUser = useRef<Set<string>>(new Set())

    // SSH 세션이 **쓰던 중에** 끊기면 그 패널에 [재접속] 카드를 낸다(2026-08-14 준영님 결정 —
    // 자동 재접속은 하지 않는다: 끊긴 이유가 서버 쪽이면 자동은 죽은 서버를 계속 때린다).
    //
    // 그전에는 TerminalPane 이 회색 한 줄("[프로세스 종료 — code 0]")만 찍고 끝이었다 — 탭은
    // 껍데기로 남고 다시 붙는 길이 화면에 없었다. F6 부팅 복원이 쓰던 카드를 그대로 재사용한다.
    useEffect(() => {
      const offs = list
        .filter((s) => s.type === 'ssh')
        .map((s) =>
          window.ev?.session.onExit(s.id, () => {
            if (closedByUser.current.delete(s.id)) return // 사용자가 닫은 것 — 조용히 보낸다
            // (D(#168) 의 "AI 탭은 끝난 것" 예외는 2026-10-12 에 걷었다 — AI 는 이제 셸 안에서 돌고,
            // 셸이 끊긴 것은 AI 가 돌았든 아니든 끊긴 것이다.)
            // 탭의 점도 함께 바뀐다(#166) — 칸 머리는 아래 오류 카드로 이미 알지만 탭은
            // restoreErrors 를 안 본다. 두 자리가 같은 사실을 다르게 그리면 그게 다음 제보다.
            setSessionState(s.id, 'lost')
            setRestoreErrors((m) => {
              if (m.has(s.id)) return m
              const n = new Map(m)
              n.set(s.id, {
                sessionId: s.id,
                profileId: s.profileId ?? null,
                title: s.title,
                serverKey: s.serverKey,
                // 안전망이다. 지금 구조에서 type:'ssh' 세션은 늘 프로필에서 나오므로(손으로
                // `ssh` 를 친 것은 로컬 셸이다) 여기 걸릴 일이 없지만, profileId 가 옵셔널이라
                // 없으면 버튼 대신 사유를 말한다 — 눌러도 안 되는 버튼을 내주지 않기 위해서다.
                reason: s.profileId ? 'dropped' : 'noProfile'
              })
              return n
            })
          })
        )
      return () => offs.forEach((off) => off?.())
    }, [list])

    // 세션 활성화(탭 클릭·트리 클릭 공통): 이미 패널에 있으면 그 패널 포커스,
    // 없으면 포커스 패널의 세션을 교체(xterm 재마운트 없이 display 전환).
    const activateSession = useCallback(
      (id: string) => {
        select(id)
        layout.showSession(id)
      },
      [select, layout]
    )

    // 그 자리의 오류 정보를 걷는다 — 되살렸거나(재시도·이어서 시작) 포기했거나(닫기).
    const clearError = useCallback((errId: string) => {
      setRestoreErrors((m) => {
        const n = new Map(m)
        n.delete(errId)
        return n
      })
    }, [])

    // F6 부분 복원 재시도: 오류 패널의 프로필로 재접속 → 성공 시 placeholder 를 실 세션으로 교체.
    // 1.0.8 ②: 끝난 AI 세션 자리도 같은 버튼을 쓴다(재접속 대신 그 CLI 를 다시 띄운다).
    const retryRestore = useCallback(
      async (errId: string) => {
        const err = restoreErrors.get(errId)
        if (!err) return
        /**
         * 1.0.8 ②: 끝난 AI 세션 자리 — 재접속이 아니라 **그 CLI 를 그 폴더에서 다시** 띄운다
         * (claude 면 `-c` 로 직전 대화를 이어서). SSH 재시도와 이후 절차는 같다: 새 세션 id 로
         * 카드 자리를 갈아 끼우고 오류를 걷는다.
         *
         * 🔴 먼저 이 칸에 초점을 준다. 띄우는 쪽(Shell.runAiCliNow)이 끝에 `selectSession` 을
         *    부르는데, 그것이 **초점 칸**의 세션을 갈아 끼운다(layout.showSession) — 다른 칸이
         *    초점이면 새 세션이 그 칸에 들어가고 아래 replaceSession 이 이 칸에도 넣어 같은 세션이
         *    두 칸을 차지한다(렌더는 첫 칸에만 붙고 나머지가 빈다). 버튼을 누르면 mousedown 이
         *    대개 이 칸을 잡지만, 그 우연에 기대지 않는다.
         */
        if (err.aiCli) {
          const cell = layout.cells.find((c) => c.sessionId === errId)
          if (cell) layout.focus(cell.id)
          // 카드 아래 셸이 살아 있으면 그 셸에 친다(2026-10-12 — AI 는 셸 안에서 돈다).
          const here = list.some((x) => x.id === errId) ? errId : undefined
          const id = err.cwd ? await onResumeAi?.(err.aiCli, err.cwd, here) : null
          if (!id) {
            showToast(t('restore.resumeFailed'))
            return
          }
          if (id === errId) {
            clearError(errId)
            select(id)
            return
          }
          layout.replaceSession(errId, id)
          clearError(errId)
          // 1.0.9: `errId` 가 이제 **실 세션**이다(카드가 셸 위에 얹힌다) — 그 셸은 여기서 끝난다.
          // 안 닫으면 [이어서 시작] 한 번에 빈 셸 탭이 하나씩 쌓인다. 아래 SSH 갈래가 같은 이유로
          // 같은 줄을 갖고 있다(placeholder 면 목록에 없어 아무 일도 안 한다 — 두 경로가 같은 코드를
          // 쓸 수 있는 이유).
          if (list.some((x) => x.id === errId)) close(errId)
          select(id)
          return
        }
        if (!err.profileId || !sshRestore) return
        const res = await sshRestore(err.profileId)
        if (res.ok) {
          // 끊긴 세션이면 목록(탭)에도 남아 있다 — 함께 치운다. F6 복원 placeholder 는 목록에
          // 없으므로 이 줄이 아무 일도 하지 않는다(두 경로가 같은 코드를 쓸 수 있는 이유).
          if (list.some((x) => x.id === errId)) close(errId)
          layout.replaceSession(errId, res.id)
          clearError(errId)
          select(res.id)
        } else if (res.reason !== 'shown') {
          /**
           * 🔴 **`'shown'` 이면 조용히 넘어간다**(1.0.11 에서 계약만 적고 여기를 안 고쳤다).
           *
           * 재접속은 이제 `connectProfile` 을 지나고, 그쪽이 **실패를 이미 화면으로 말한다**
           * (호스트키 창 · 비밀번호 창 · 실패 안내). 여기서 또 토스트를 내면 **같은 실패를 두 번**
           * 말하고, 더 나쁘게는 **사용자가 비밀번호 창을 스스로 취소한 경우에도**
           * *"재접속에 실패했습니다 — 잠시 후 다시 시도하세요"* 가 뜬다. 취소는 실패가 아니다.
           */
          showToast(t('restore.retryFailed'))
        }
      },
      [restoreErrors, sshRestore, layout, select, showToast, list, close, onResumeAi, clearError]
    )

    // 오류 패널 닫기: 재시도 포기 — 패널 제거 + 오류 정보 삭제.
    // ⚠️ 1.0.9: AI 카드는 **실 세션 위에 얹힌 것**이라 여기 오면 안 된다 — 칸을 지우면 멀쩡한
    //    셸까지 사라진다. 그쪽은 아래 dismissError 가 세션 유무로 갈라 카드만 걷는다.
    const dismissError = useCallback(
      (errId: string) => {
        /**
         * 🔴 **살아 있는 세션 위의 카드는 카드만 걷는다**(1.0.9).
         *
         * 두 종류가 이 함수를 함께 쓴다:
         *  · 부팅 복원 실패 placeholder — 세션이 **없다**. 칸을 지우는 것이 곧 치우는 것이다
         *  · 실 세션 위에 얹힌 카드(AI 끝남 · SSH 쓰던 중 끊김) — 세션이 **있다.**
         *    칸을 지우면 **멀쩡한 셸까지 사라진다** — [닫기]를 누른 사람은 카드를 치운 것이지
         *    터미널을 닫은 것이 아니다(닫기는 탭의 ✕ 가 한다)
         *
         * 세션 유무가 그 둘을 정확히 가른다. `PaneGrid` 도 같은 기준으로 카드를 대신 그릴지
         * 위에 얹을지 정한다(`err && !session` vs `err && session`) — **두 곳이 같은 축을 본다.**
         */
        if (list.some((x) => x.id === errId)) {
          clearError(errId)
          return
        }
        const cell = layout.cells.find((c) => c.sessionId === errId)
        if (cell) layout.closePane(cell.id)
        clearError(errId)
      },
      [layout, list, clearError]
    )

    // 분할(R2.0): 새 패널에는 이미 열려 있는 배경 탭(패널 미배치 세션)을 최근 사용 순으로 올린다.
    // "분할하면 새 셸이 뜬다"가 아니라 "지금 있는 창들이 나란히 보인다"가 기대 동작이다.
    // 배경 세션이 하나도 없을 때만 새 로컬 셸을 만든다(기존 동작은 폴백으로 남는다).
    // axis: 'tb' 가로 분할(상하) / 'lr' 세로 분할(좌우) — 1→2 분할에서만 방향이 반영된다.
    const doSplit = useCallback(
      async (axis: PairAxis) => {
        if (!layout.canSplit) {
          showToast(t('pane.limit'))
          return
        }
        const placed = new Set(layout.cells.map((c) => c.sessionId))
        const background = pickBackgroundSession(list, placed, mru)
        layout.split(background ?? (await open()), axis)
      },
      [layout, list, mru, open, showToast]
    )

    // 드래그로 가장자리에 놓았을 때. 탭·칸 헤더 둘 다 여기로 온다.
    //  · 방향을 그대로 반영한다(왼쪽에 놓으면 왼쪽에 생긴다).
    //  · 이미 배치된 세션을 옮기는 경우, 원래 칸에는 다른 세션을 채운다 — 같은 세션이 두 칸을
    //    차지하면 렌더는 첫 칸에만 붙고 나머지 칸이 통째로 빈다(준영님이 본 "우측이 비어 있음").
    /**
     * 크롬식 탭 병합(2026-08-23 준영님 요청). **다른 창의 탭**을 이 창으로 가져온다.
     *
     * 세션은 main 에 살아 있고 창은 화면일 뿐이라(F32 의 전제) 옮기는 일은 소유 표시 한 줄이다.
     * 목록·탭바는 `session:moved` 를 받은 두 창이 각자 맞춘다 — 여기서 직접 넣지 않는다.
     *
     * 성공하면 **그 탭을 띄운다**: 크롬도 끌어다 놓은 탭을 활성으로 만든다. 목록이 아직 안
     * 왔어도 괜찮다 — activeId 는 문자열일 뿐이고, 뒤이어 오는 새로고침이 그 id 를 유지한다.
     */
    const adoptSession = useCallback(
      async (sessionId: string, overId?: string) => {
        const r = await window.ev?.window.moveSession(sessionId, detachedWinId).catch(() => null)
        // RDP 거절은 말한다(#201 C) — 밖으로 끌면 TermTabbar 가 "RDP 는 분리할 수 없다"고 하는데, 같은
        // 한계가 이쪽(합치기)에선 침묵이었다. RDP 는 main 에 세션이 없어 늘 거절된다(id 가 `rdp:` 로
        // 시작 — sessions.openRdp). 그 밖의 거절은 여전히 조용하다: 탭이 아닌 텍스트가 떨어진 경우다(TermTabbar.drop).
        if (!r?.ok) {
          if (sessionId.startsWith('rdp:')) showToast(t('tab.move.fail'))
          return
        }
        select(sessionId)
        layout.showSession(sessionId)
        if (overId) reorder(sessionId, overId)
      },
      [detachedWinId, select, layout, reorder, showToast]
    )

    const splitDrop = useCallback(
      async (sessionId: string, zone: 'left' | 'right' | 'top' | 'bottom') => {
        if (!layout.canSplit) {
          showToast(t('pane.limit'))
          return
        }
        const axis: PairAxis = zone === 'left' || zone === 'right' ? 'lr' : 'tb'
        const before = zone === 'left' || zone === 'top'
        const placed = new Set(layout.cells.map((c) => c.sessionId))
        if (!placed.has(sessionId)) {
          layout.split(sessionId, axis, before)
          return
        }
        /**
         * 2026-08-22 준영님 제보 21번 — 재현: 세션 1·2 를 열고 2번 탭을 오른쪽에 드롭하면
         * **왼쪽에 2번이 그대로 있고 오른쪽이 빈다**(1번 탭을 눌러야 그제야 옮겨진다).
         *
         * 원인이 이 두 줄이었다. `placed.delete(sessionId)` 는 "이 세션이 비우고 갈 칸은 채울
         * 곳"이라는 뜻으로 넣은 것인데, 그 바람에 **옮기는 세션 자신이 filler 후보**가 됐다.
         * mru 의 맨 앞은 방금 만진 그 세션이라 거의 항상 자기가 뽑혔고, 결과는 같은 세션이 두 칸에
         * 앉는 상태다 — 렌더는 첫 칸에만 붙으므로 새 칸이 통째로 빈다(바로 위 주석이 경고한 그것).
         *
         * 후보에서 빼야 할 것은 둘이다: **이미 배치된 세션** + **지금 옮기는 세션**.
         */
        const fillerPool = new Set(placed)
        fillerPool.add(sessionId)
        const filler = pickBackgroundSession(list, fillerPool, mru) ?? (await open())
        layout.split(sessionId, axis, before, filler)
      },
      [layout, list, mru, open, showToast]
    )

    // R9a: 세션 종료의 단일 경로. 칸 닫기·탭 ×·다른 탭 모두 닫기가 전부 여기를 지난다.
    // 예전엔 "패널 닫기"가 detach(세션은 살리고 화면에서만 뺌)여서 탭이 남았고, 그게 "좀비 탭"으로
    // 읽혔다(FB-0005). 이제 탭 = 세션 1:1 이 화면에서도 그대로 성립한다: 닫으면 둘 다 사라진다.
    // 종류와 무관하게 **항상** 확인을 받는다(2026-08-11 준영님 결정 — 예전엔 SSH 만 물었다).
    // 세션 종료는 되돌릴 수 없고 로컬 셸도 그 안에서 돌던 작업이 함께 죽는다.
    // 문구는 종류에 맞게 고른다 — 로컬에 "SSH 연결이 끊긴다"고 쓰면 거짓말이다.
    // 여러 개를 한 번에 닫아도 확인은 한 번만 받는다("다른 탭 모두 닫기"에서 창이 연달아 뜨지 않게).
    const destroySessions = useCallback(
      async (ids: string[]) => {
        /**
         * **지금** 목록에 있는 것만 닫는다. `list` 를 클로저로 읽으면 안 된다 — 늦게 도착한 요청은
         * 자기가 만들어질 때의 낡은 목록을 들고 온다(RDP 의 `onClose` 가 그렇다: `connect` 안에
         * 갇힌 콜백이라 접속하던 시점의 목록을 본다). 그러면 이미 닫은 세션을 "아직 있다"고 보고
         * **확인 팝업을 한 번 더** 띄운다(2026-09-02 준영님 제보 ④).
         *
         * 아래 빈 배열 가드는 원래 그 경우를 삼키려고 있던 것이다 — 낡은 목록 때문에 걸리지
         * 않았을 뿐이다. 살아 있는 목록을 보게 해서 그 가드를 되살린다.
         */
        const targets = ids.map((id) => listRef.current.find((s) => s.id === id)).filter((s): s is Session => !!s)
        if (targets.length === 0) return
        // 종류마다 제 문구, 섞여 있으면 있는 것 전부(#201 C) — RDP 가 로컬 갈래로 떨어져
        // "셸이 종료되고…"라고 했다. RDP 에는 셸이 없다.
        const message = (['ssh', 'rdp', 'local'] as const)
          .filter((k) => targets.some((s) => s.type === k))
          .map((k) => t('session.close.' + k))
          .join('\n')
        {
          const r = await ask?.({
            title: t('session.close.title'),
            message,
            // 무엇을 죽이는지 보여 주는 게 이 다이얼로그의 존재 이유다 — 대상 전부를 적는다.
            detail: targets.map((s) => ({ label: t('session.close.target'), value: s.title })),
            tone: 'danger',
            confirmLabel: t('session.close.confirm')
          })
          if (r !== 'confirm') return
        }
        for (const s of targets) {
          // **사용자가 닫은 것**이라고 표시해 둔다. 아래 onExit 감시가 이 표시를 보고 재접속 카드를
          // 띄울지 말지 정한다 — 안 가르면 탭을 닫을 때마다 "연결이 끊겼습니다"가 뜬다.
          closedByUser.current.add(s.id)
          layout.removeSession(s.id)
          close(s.id)
        }
      },
      [layout, close, ask]
    )

    // 탭 × = 세션 종료.
    const closeTab = useCallback((sessionId: string) => void destroySessions([sessionId]), [destroySessions])

    // 칸 닫기 = 그 칸의 세션 종료(같은 경로).
    const closePane = useCallback(
      (paneId: string) => {
        const cell = layout.cells.find((c) => c.id === paneId)
        if (cell) void destroySessions([cell.sessionId])
      },
      [layout.cells, destroySessions]
    )

    // 다른 탭 모두 닫기(R2.2) — 남길 세션 하나만 두고 나머지를 한 번에 종료한다.
    const closeOtherTabs = useCallback(
      (keepId: string) => {
        void destroySessions(list.filter((s) => s.id !== keepId).map((s) => s.id)).then(() => activateSession(keepId))
      },
      [list, destroySessions, activateSession]
    )

    // 세션 복제(R2.2/R2.5): ssh 는 같은 프로필로 새 접속, 로컬(또는 복제 불가)은 새 로컬 셸.
    const duplicateSession = useCallback(
      (sessionId: string | null) => {
        const s = sessionId ? list.find((x) => x.id === sessionId) : null
        if (s && s.type === 'ssh' && onDuplicateSession) onDuplicateSession(s)
        else void openLocal()
      },
      [list, onDuplicateSession, openLocal]
    )

    // 탭 인라인 편집 — 시작/확정(value=null 은 ESC 취소). editRef 로 blur 중복 커밋을 막는다.
    const startEdit = useCallback((id: string) => {
      editRef.current = id
      setEditingId(id)
    }, [])
    const commitEdit = useCallback(
      (id: string, value: string | null) => {
        if (editRef.current !== id) return
        editRef.current = null
        setEditingId(null)
        if (value !== null) rename(id, value)
      },
      [rename]
    )

    // 터미널 글자 크기 ±1(설정 슬라이더와 같은 10–20 범위·같은 저장 경로). Ctrl+휠(R3.7)과
    // View 메뉴(R4.1)가 같은 함수를 쓴다.
    const zoomFont = useCallback(
      (delta: number) => {
        const next = Math.min(SIZE_MAX, Math.max(SIZE_MIN, font.sizePx + delta))
        if (next !== font.sizePx) updateFont({ sizePx: next })
      },
      [font.sizePx, updateFont]
    )

    useImperativeHandle(
      ref,
      () => ({
        activateSession,
        closeSession: closeTab,
        newLocal: () => void openLocal(),
        beginRename: (id: string) => {
          activateSession(id)
          startEdit(id)
        },
        openCheatsheet: () => setCheatsheetOpen(true),
        zoomFont,
        toast: showToast,
        setAiModel: (provider: AiProvider, model: string) => updatePrefs({ aiModels: { ...prefs.aiModels, [provider]: model } })
      }),
      [activateSession, closeTab, openLocal, startEdit, zoomFont, showToast, updatePrefs, prefs.aiModels]
    )

    // FB-ui2(FB-0005): 지금 어떤 패널에도 배치되지 않은(detach) 세션 id 집합 — 탭바가 그 탭을
    // 은은하게 구분해 그린다("죽은 탭" 오해 보완, 클릭하면 showSession 이 다시 붙여 준다).
    const placedIds = useMemo(() => new Set(layout.cells.map((c) => c.sessionId)), [layout.cells])

    // 포커스 패널의 세션 id(우클릭 액션 대상). 포커스 없으면 활성 세션.
    const focusedSessionId = useCallback((): string | null => {
      const cell = layout.cells.find((c) => c.id === layout.focusedId)
      return cell?.sessionId ?? activeId
    }, [layout.cells, layout.focusedId, activeId])

    // R3.6: 셸이 보낸 OSC 제목. 적용 여부는 main 이 판정(사용자 rename 우선) — 받아들여졌을 때만 탭 라벨을 바꾼다.
    const onAutoTitle = useCallback(
      (sessionId: string, title: string) => {
        void window.ev?.session
          .autoTitle(sessionId, title)
          // main 이 다듬은 값(`…\powershell.exe - cd ..` → `cd ..`)을 그린다 — 원문을 그리면 main 과 갈린다.
          .then(({ applied, title: shown }) => applied && applyTitle(sessionId, shown ?? title))
          .catch(() => {}) // autoTitle 미지원 하네스 — 제목 갱신만 건너뛴다.
      },
      [applyTitle]
    )

    // 터미널 우클릭 메뉴 액션 배선(단일 레지스트리 CONTEXT_ACTIONS 의 id → 실동작).
    const onAction = useCallback(
      async (id: ActionId) => {
        const sid = focusedSessionId()
        switch (id) {
          case 'copy': {
            // 포커스 세션 xterm 의 선택 텍스트 → 클립보드.
            const text = sid ? getSelection(sid) : ''
            if (!text) {
              showToast(t('ctx.noSelection'))
            } else if (await writeClipboard(text)) {
              // 거부되면 writeClipboard 가 스스로 안내한다 — "복사됨"으로 덮어씌우면 안 된다.
              showToast(t('ctx.copied'))
            }
            return
          }
          case 'paste': {
            // 클립보드 → 세션 입력(pty/ssh stdin).
            if (!sid) return
            const text = await readClipboard()
            if (text) window.ev.session.input(sid, text)
            return
          }
          case 'split.horizontal':
            void doSplit('tb')
            return
          case 'split.vertical':
            void doSplit('lr')
            return
          case 'session.duplicate':
            duplicateSession(sid)
            return
          case 'pane.close':
            if (layout.focusedId) closePane(layout.focusedId)
            return
          case 'ai.ask':
            // 선택 영역이 있으면 그 텍스트를 컴포저에 프리필한다('copy' 가 쓰는 같은 함수).
            onAskAi?.(sid ? getSelection(sid) : '')
            return
          case 'aicli.run.claude':
            onRunAiCli?.('claude')
            return
          case 'aicli.run.codex':
            onRunAiCli?.('codex')
            return
          case 'aicli.run.gemini':
            onRunAiCli?.('gemini')
            return
          case 'log.save':
            // 2026-08-13 감사: "추후 지원" 토스트만 내고 있었는데 로그 패널의 [내려받기]는
            // 이미 동작했다. 그 패널을 여는 것으로 잇는다 — 없는 기능인 척하지 않는다.
            onOpenLog?.()
            return
        }
        /**
         * tmux (2026-08-22 제보 11·32). 트리 세션 행이 하던 것과 **같은 매크로**를 같은 방식으로
         * 보낸다 — `session.input` 이라 사람이 타이핑한 것과 구분되지 않는다. 그래서 `su` 로
         * 계정을 바꾼 뒤에도, sudo 셸 안에서도 그대로 동작한다(exec 채널이었으면 다른 셸이라 안 된다).
         */
        if (!sid) return
        if (id === 'session.tmux.new') {
          const name = await askText?.({
            title: t('tmux.name.title'),
            message: t('tmux.name.new.msg'),
            input: { placeholder: t('tmux.name.placeholder') },
            confirmLabel: t('tmux.name.btn'),
            cancelLabel: t('dlg.cancel')
          })
          const input = name ? buildTmuxInput({ kind: 'new', name }) : null
          if (input) window.ev.session.input(sid, input)
          return
        }
        if (id === 'session.tmux.detach' || id === 'session.tmux.prevWindow' || id === 'session.tmux.nextWindow') {
          const kind = id === 'session.tmux.detach' ? 'detach' : id === 'session.tmux.prevWindow' ? 'prevWindow' : 'nextWindow'
          const input = buildTmuxInput({ kind })
          if (input) window.ev.session.input(sid, input)
          return
        }
        if (id.startsWith('session.tmux.attach:')) {
          const input = buildTmuxInput({ kind: 'attach', name: id.slice('session.tmux.attach:'.length) })
          if (input) window.ev.session.input(sid, input)
        }
      },
      [focusedSessionId, doSplit, closePane, layout.focusedId, duplicateSession, showToast, onAskAi, onRunAiCli, onOpenLog, askText]
    )

    // 탭 순환(Ctrl+] / Ctrl+[) — 탭바에 보이는 순서(= sessions 배열)를 따른다.
    const cycleTab = useCallback(
      (step: 1 | -1) => {
        if (list.length === 0) return
        const cur = list.findIndex((s) => s.id === activeId)
        const next = list[((cur < 0 ? 0 : cur) + step + list.length) % list.length]
        if (next) activateSession(next.id)
      },
      [list, activeId, activateSession]
    )

    // 터미널 토글(Ctrl+`) — 로컬 셸이 있으면 그 사이를 순환하고, 하나도 없으면 새로 연다.
    const toggleTerminal = useCallback(() => {
      const locals = list.filter((s) => s.type === 'local')
      if (locals.length === 0) {
        void openLocal()
        return
      }
      const cur = locals.findIndex((s) => s.id === activeId)
      activateSession(locals[(cur + 1) % locals.length].id)
    }, [list, activeId, activateSession, openLocal])

    // 단축키(§B.8 + R3.8 충돌 정책). 조합은 전부 keymap.ts 에서 온다 — 여기엔 키 문자열이 없다.
    // 앱 전용 키는 Ctrl+Shift+* / Alt+* 뿐이라 셸의 Ctrl+문자 관례를 건드리지 않는다.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (matchBinding(e, 'terminal.search')) {
          e.preventDefault()
          setSearchOpen(true)
        } else if (matchBinding(e, 'clipboard.copy')) {
          e.preventDefault()
          void onAction('copy')
        } else if (matchBinding(e, 'clipboard.paste')) {
          e.preventDefault()
          void onAction('paste')
        } else if (matchBinding(e, 'session.new')) {
          e.preventDefault()
          void openLocal()
        } else if (matchBinding(e, 'split.horizontal')) {
          e.preventDefault()
          void doSplit('tb')
        } else if (matchBinding(e, 'split.vertical')) {
          e.preventDefault()
          void doSplit('lr')
        } else if (matchBinding(e, 'pane.close')) {
          e.preventDefault()
          if (layout.focusedId) closePane(layout.focusedId)
        } else if (matchBinding(e, 'pane.maximize')) {
          e.preventDefault()
          layout.toggleMaximize()
        } else if (matchBinding(e, 'tab.next')) {
          e.preventDefault()
          cycleTab(1)
        } else if (matchBinding(e, 'tab.prev')) {
          e.preventDefault()
          cycleTab(-1)
        } else if (matchBinding(e, 'session.duplicate')) {
          e.preventDefault()
          duplicateSession(focusedSessionId())
        } else if (matchBinding(e, 'terminal.toggle')) {
          e.preventDefault()
          toggleTerminal()
        } else if (matchBinding(e, 'ai.ask')) {
          // Ctrl+Shift+A — 우클릭 메뉴 [AI에게 질문] 과 같은 경로(선택 텍스트를 아는 쪽이 여기다).
          e.preventDefault()
          void onAction('ai.ask')
        } else if (matchBinding(e, 'settings.open')) {
          // R5: Ctrl+, — 타이틀바 기어·File>설정과 같은 상태를 연다(진입점 3개, 배선은 여기 하나).
          e.preventDefault()
          setSettingsOpen(true)
        } else {
          // R14 Alt+1·2·3 — 우클릭 [AI 실행 ▸ …] 과 같은 onAction 길. 떼어낸 창엔 onRunAiCli 가 없어
          // 아무 일도 안 한다(메뉴를 감추는 TerminalMenuCaps.runAiCli 와 같은 판정).
          const run = onRunAiCli ? aiCliRunOfKey(e) : null
          if (run) {
            e.preventDefault()
            void onAction(run)
            return
          }
          const n = matchNumber(e, 'tab.byNumber')
          if (n) {
            e.preventDefault()
            const target = list[n - 1]
            if (target) activateSession(target.id)
            return
          }
          const dir = matchArrow(e, 'focus.move')
          if (dir) {
            e.preventDefault()
            layout.moveFocus(dir)
          }
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [
      openLocal,
      doSplit,
      closePane,
      layout,
      cycleTab,
      duplicateSession,
      focusedSessionId,
      toggleTerminal,
      list,
      activateSession,
      onAction,
      onRunAiCli
    ])

    /**
     * 2026-08-23 준영님 제보 1번: **칸을 클릭하면 그 세션이 활성이 된다.**
     *
     * 그전에는 칸 포커스(layout.focusedId)와 활성 세션(activeId)이 따로 놀았다 — 우클릭 메뉴·
     * 복사 같은 것은 포커스 칸을 따라갔지만, **탭바의 활성 탭과 사이드바 [파일] 은 activeId** 를
     * 본다. 그래서 분할해 놓고 왼쪽 칸을 눌러도 파일 트리는 마지막에 분할한 세션에 머물렀다.
     * 포커스가 바뀌는 길은 여럿이라(클릭·분할·Ctrl+Alt+방향키) 각 자리에 심지 않고 여기서 잇는다.
     */
    const lastFocused = useRef<string | null>(null)
    useEffect(() => {
      /**
       * **포커스가 바뀐 순간에만** 따라간다. 그냥 "다르면 맞춘다"로 두면 반대 방향을 덮어쓴다:
       * 새 세션을 열면 activeId 가 먼저 새 세션이 되고 배치는 한 박자 뒤에 오는데, 그 사이에
       * 이 이펙트가 **옛 칸의 세션으로 되돌린다**(e2e WB-2 가 잡았다 — [여기서 터미널 열기]로
       * 연 셸 대신 옛 세션의 경로가 상태바에 남았다).
       */
      if (layout.focusedId === lastFocused.current) return
      lastFocused.current = layout.focusedId
      const sid = layout.cells.find((c) => c.id === layout.focusedId)?.sessionId
      if (sid && sid !== activeId) select(sid)
    }, [layout.focusedId, layout.cells, activeId, select])

    // R3.7 Ctrl+휠 → 터미널 글자 크기 ±1. 브라우저 기본 페이지 줌을 막아야 하므로 passive:false.
    useEffect(() => {
      const onWheel = (e: WheelEvent) => {
        if (!e.ctrlKey) return
        const el = e.target as HTMLElement | null
        if (!el?.closest?.('.term-pane')) return
        e.preventDefault()
        zoomFont(e.deltaY < 0 ? 1 : -1)
      }
      window.addEventListener('wheel', onWheel, { passive: false })
      return () => window.removeEventListener('wheel', onWheel)
    }, [zoomFont])

    return (
      <div className="main">
        {/* #139 부팅 인사 — 자비스식. 짧고, 아무 키로 건너뛰고, 설정에서 끈다.
            **이름 묻기보다 먼저** 지나간다: 처음 켠 사람도 인사부터 받고 그다음 이름을 준다.
            **떼어낸 창에서는 안 뜬다**(2026-09-01 제보 ① — shouldShowBootSplash 주석 참고). */}
        {splashOpen && (
          <BootSplash
            name={prefs.araCallName}
            onDone={() => {
              bootSplashShown = true
              setSplashDone(true)
            }}
          />
        )}
        {/* #138 첫 실행 인사 — 호칭을 받는다. 한 번 지나면(건너뛰어도) 다시 안 뜬다.
            **하이드레이트가 끝난 뒤**에만 판정한다: 기본값이 빈 문자열이라 로드 전에 보면
            이미 이름을 넣어 둔 사람에게도 매번 뜬다. prefs 의 주인이 여기라 여기서 그린다.
            인사와 같은 이유로 **본창에서만** 묻는다: 이름은 앱에 한 번 주는 것이라, 아직 답하지
            않은 사람이 탭을 떼어내면 새 창이 이름부터 묻고 앉아 있게 된다(제보 ① 과 같은 병). */}
        <WelcomeModal
          open={welcomeOpen}
          onDone={(name) => updatePrefs({ araWelcomeSeen: true, ...(name ? { araCallName: name } : {}) })}
        />
        <TermTabbar
          sessions={list}
          activeId={activeId}
          placedIds={placedIds}
          onSelect={activateSession}
          onClose={closeTab}
          onNew={() => void openLocal()}
          /* 없으면 ＋ 메뉴에서 그 줄이 빠진다(위 caps 와 같은 규칙) — 감싸지 않고 그대로 넘긴다. */
          onNewSsh={onOpenConnManager}
          onAiCli={onOpenAiCli}
          editingId={editingId}
          onStartEdit={startEdit}
          onCommitEdit={commitEdit}
          onDuplicate={duplicateSession}
          onCloseOthers={closeOtherTabs}
          onReorder={reorder}
          onAdopt={(sessionId, overId) => void adoptSession(sessionId, overId)}
          onNotice={showToast}
        />
        <PaneGrid
          layout={layout}
          sessions={list}
          restoreErrors={restoreErrors}
          onRetryRestore={(errId) => void retryRestore(errId)}
          onDismissError={dismissError}
          onCloseSession={closeTab}
          onSplitDrop={(sessionId, zone) => void splitDrop(sessionId, zone)}
          onAdopt={(sessionId) => void adoptSession(sessionId)}
          onTitle={onAutoTitle}
          onLink={(sessionId, url, isSsh, external) => void openLink(sessionId, url, isSsh, external)}
        />
        {/* RDP 만 보고 있으면 하단바를 **그리지 않는다**(2026-09-02 준영님 ③ — allPanesRdp 주석).
            ⚠️ 켜 둔 상태는 건드리지 않는다: 터미널 탭에서 열어 두고 RDP 탭에 갔다 돌아오면 그대로
            있다. 껐다고 기억하면 사용자가 안 껐는데 꺼져 있는 것이 된다.
            떼어낸 창도 여기를 지난다(SessionWindow 가 같은 prop 으로 넘긴다) — 두 창이 같게 논다. */}
        {!allPanesRdp(layout.panes) && bottom}
        <TerminalSearch open={searchOpen} sessionId={focusedSessionId()} onClose={() => setSearchOpen(false)} />
        {toast && (
          <div className={'pane-toast' + (toast.action ? ' has-act' : '')}>
            {toast.msg}
            {toast.action && (
              <button
                type="button"
                className="btn sec toast-act"
                onClick={() => {
                  toast.action?.run()
                  setToast(null)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
        {/* 받는 동안 · 끄기 직전 — 우하단에 뜨고 아무것도 가리지 않는다(모달이 아니다). */}
        {!detachedWinId && (installing || updSt?.status === 'downloading') && (
          <UpdateProgress
            phase={installing ? 'installing' : 'downloading'}
            version={updSt?.version ?? ''}
            percent={updSt?.status === 'downloading' ? (updSt.percent ?? 0) : 0}
          />
        )}
        <ContextInteractions
          onAction={onAction}
          // 제보 11·32: SSH 세션일 때만 tmux 항목이 붙는다(조회도 그때만 나간다).
          activeIsSsh={list.find((s2) => s2.id === focusedSessionId())?.type === 'ssh'}
          /* #201 A-4: **핸들러가 없으면 그 항목을 안 그린다.** 떼어낸 창(F32)에는 아라도 연결
             트리도 없어서 그 셋이 눌러도 아무 일이 없었다 — 없는 기능은 메뉴에서 뺀다.
             판정은 prop 의 존재 여부다(새 플래그를 만들지 않는다 — 다음 prop 도 이 규칙을 탄다). */
          caps={{ askAi: Boolean(onAskAi), runAiCli: Boolean(onRunAiCli), saveLog: Boolean(onOpenLog) }}
          cheatsheetOpen={cheatsheetOpen}
          onCheatsheetChange={setCheatsheetOpen}
          commandBookOpen={commandBookOpen}
          onCommandBookChange={setCommandBookOpen}
          commandBookQuery={commandBookQuery}
          activeSessionId={focusedSessionId()}
        />
        <SettingsDrawer
          open={settingsOpen}
          font={font}
          prefs={prefs}
          version={version}
          onClose={() => setSettingsOpen(false)}
          onChange={updateFont}
          onPrefsChange={updatePrefs}
          ask={ask}
          onOpenCommandBook={(query) => {
            setCommandBookQuery(query)
            setCommandBookOpen(true)
          }}
        />
      </div>
    )
  }
)
