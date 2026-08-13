import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react'
import { t } from '../i18n'
import { TermTabbar } from './TermTabbar'
import { PaneGrid, type RestoreError } from './PaneGrid'
import { pickBackgroundSession, type Session, type useSessions } from '../store/sessions'
import { useLayout, toLayoutNode, type PairAxis } from '../store/layout'
import { matchBinding, matchArrow, matchNumber } from '../../shared/keymap'
import { ContextInteractions } from '../interactions/ContextInteractions'
import type { ActionId } from '../interactions/actions'
import { getSelection } from '../terminal/termRegistry'
import { applyUiPrefs, prefsFrom } from '../terminal/termPrefs'
import { TerminalSearch } from './TerminalSearch'
import { LogViewer } from './LogViewer'
import { SettingsDrawer, SIZE_MAX, SIZE_MIN } from './SettingsDrawer'
import { useFont } from '../store/font'
import { useUiPrefs } from '../store/uiPrefs'
import { visibleActivities, type ActivityId } from '../store/activityBar'
import { readClipboard, setClipboardNotifier, writeClipboard } from '../store/clipboardWrite'
import { planRestore } from '../store/restore'
import { setSpanNotifier } from '../store/rdpSpanOpen'
import { localUrl, planLink } from '../../shared/linkTarget'
import type { DialogResult, DialogSpec } from './Dialog'
import type { UiState } from '@shared/types'

// SSH 복원 결과 — Shell 의 connectProfile 을 감싼다. 성공 시 새 세션 id, 실패 시 사유.
export type SshRestoreResult = { ok: true; id: string } | { ok: false; reason: string }

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
  openLogTail: (sessionId: string, path: string) => void
}

type MainAreaProps = {
  sessions: ReturnType<typeof useSessions>
  // ssh 세션 복제(같은 프로필 재접속). local 은 MainArea.open() 으로 처리. Shell 이 주입(F4c).
  onDuplicateSession?: (session: Session) => void
  // F6: 프로필로 SSH 재접속(복원·재시도). Shell 이 주입 — 성공 시 새 세션 id 반환.
  sshRestore?: (profileId: string) => Promise<SshRestoreResult>
  // 탭바 ＋ 메뉴·빈 상태의 "SSH 연결…" → 연결 관리자 열기(Shell 소유).
  onOpenConnManager?: () => void
  // F27: 탭바 ＋ 메뉴의 "AI CLI 시작…" → 그 창 열기(창 상태도 Shell 소유 — onAskAi 와 같은 이유).
  onOpenAiCli?: () => void
  // R5 설정 창 [정보] 섹션에 찍을 앱 버전(Shell 이 app.getVersion 으로 이미 들고 있다).
  version: string
  // 활성 세션의 OSC7 cwd(Shell 이 구독). 저장 트리거로만 쓴다 — cwd 가 바뀌면 스냅샷의 세션 cwd 도
  // 다시 내려써야 재시작 복원이 마지막 폴더로 돌아온다.
  activeCwd?: string | null
  // F8: 링크 라우팅 실패(로컬 포트 점유)를 알릴 다이얼로그. Shell 의 단일 인스턴스를 받는다.
  ask?: (spec: DialogSpec) => Promise<DialogResult>
  // F16: 아라 패널 열기(+선택 텍스트 프리필). 패널 상태의 주인은 Shell 이라 handle 대신 prop 으로
  // 내려받는다(handle 은 Shell→MainArea 방향이므로 이쪽이 diff 가 작다 — 설계 §4.6).
  onAskAi?: (selection: string) => void
  // FB-ui2: 설정 창의 열림 상태 주인은 이 컴포넌트다(Ctrl+, keydown 이 여기서 배선된다) — 우측
  // 액티비티 바가 "지금 열려 있나"를 표시하려면 그 값을 Shell 로 되돌려줘야 한다(미러 콜백,
  // onAskAi 와 반대 방향).
  onSettingsOpenChange?: (open: boolean) => void
  /** 우측 액티비티 바에 그릴 항목·순서. prefs 의 주인이 여기라 Shell 로 올려 준다
      (useUiPrefs 를 두 곳에서 부르면 사본이 갈려 설정 변경이 바에 안 비친다). */
  onActivityItems?: (items: ActivityId[]) => void
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
      version,
      activeCwd,
      ask,
      onAskAi,
      onSettingsOpenChange,
      onActivityItems
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
    // 탭 인라인 편집 대상(R2.1). 시작점이 둘(탭 더블클릭 / 트리·탭 우클릭)이라 상태는 여기 하나만 둔다.
    const [editingId, setEditingId] = useState<string | null>(null)
    // ESC 취소 직후 blur 가 한 번 더 커밋을 부르는 것을 막는 가드(렌더 밖에서 판정해야 한다).
    const editRef = useRef<string | null>(null)
    // F6 부분 복원(C-4): SSH 재접속 실패 패널. sessionId(placeholder) → 오류 정보. 재시도 버튼 렌더.
    const [restoreErrors, setRestoreErrors] = useState<Map<string, RestoreError>>(new Map())
    const restoredRef = useRef(false) // 부트 복원 1회 가드(StrictMode 이중 마운트 방지).
    const uiRef = useRef<UiState | null>(null) // 로드한 ui(persist 시 유지).
    const [toast, setToast] = useState<string | null>(null)
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
    // F18 명령어 북 — 치트시트와 같은 오케스트레이터(ContextInteractions)가 열림 상태를 함께 관리.
    const [commandBookOpen, setCommandBookOpen] = useState(false)
    // FB-monitor: 설정 [단축키] "tmux 사용법 보기" 진입점 — 연 시점의 카테고리만 지정, 열려 있는 동안엔 안 바뀐다.
    const [commandBookQuery, setCommandBookQuery] = useState<string | undefined>(undefined)
    // R3.2 터미널 내 검색 바(Ctrl+Shift+F). 포커스 패널의 세션을 검색한다.
    const [searchOpen, setSearchOpen] = useState(false)
    // W1 F13 로그 뷰어(파일 탭 우클릭 [tail로 보기]). 한 번에 하나만 — 다른 파일을 고르면 갈아탄다.
    const [logTail, setLogTail] = useState<{ sessionId: string; path: string } | null>(null)
    // 설정 창 — 열림 상태 + 폰트(F5)·터미널 동작(R5) 스토어(하이드레이트/실시간 적용/영속).
    const [settingsOpen, setSettingsOpen] = useState(false)
    const { font, update: updateFont } = useFont()
    const { prefs, update: updatePrefs } = useUiPrefs()

    const showToast = useCallback((msg: string) => {
      setToast(msg)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToast(null), 2200)
    }, [])

    // 다중 모니터 RDP 안내(모니터 한 장·이미 열림·죽은 영역)를 여기 토스트로 보낸다 —
    // PaneGrid 는 다이얼로그도 토스트도 갖고 있지 않다.
    useEffect(() => setSpanNotifier(showToast), [showToast])
    // 클립보드 쓰기·읽기가 거부되면(창 비활성 등) 조용히 삼키지 않고 여기로 낸다 — 2026-08-13.
    useEffect(() => setClipboardNotifier(showToast), [showToast])

    // F8 터미널 링크 라우팅. planLink 가 목적지를 정하고 여기서 그대로 집행한다:
    //   external → OS 기본 브라우저(기존 동작) / loopback·oauth → 포워딩 후 내장 브라우저.
    // 포워딩 생성은 이 클릭(명시적 사용자 제스처)에서만 출발한다 — 텔레메트리 감지만으로는 만들지 않는다.
    const openLink = useCallback(
      async (sessionId: string, url: string, isSsh: boolean) => {
        const plan = planLink(url, isSsh)
        if (plan.kind === 'external') {
          void window.ev?.app.openExternal(plan.url)
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
      if (restoredRef.current) return
      restoredRef.current = true
      let cancelled = false
      void (async () => {
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
          if (item.kind === 'local') {
            const id = await restoreLocal({
              type: 'local',
              title: item.session.title,
              serverKey: item.session.serverKey,
              cwd: item.session.cwd,
              profileId: null,
              shell: item.session.shell,
              // 사용자가 바꿔 둔 이름은 재스폰 후에도 셸 OSC 제목에서 지켜 준다(R3.6).
              manualTitle: item.session.manualTitle
            })
            idMap.set(item.oldId, id)
            if (!firstReal) firstReal = id
          } else {
            // SSH: 프로필로 재접속. 실패(네트워크/인증/고아) 시 오류 패널(재시도) — 전체 실패 아님.
            const res = item.profileId && sshRestore ? await sshRestore(item.profileId) : { ok: false as const, reason: 'orphan' }
            if (res.ok) {
              idMap.set(item.oldId, res.id)
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
                reason: res.reason
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

    useEffect(() => {
      onActivityItems?.(visibleActivities(prefs.activityOrder, prefs.activityHidden))
    }, [prefs.activityOrder, prefs.activityHidden, onActivityItems])

    // 새 로컬 셸: 세션 생성 → 포커스 패널에 표시(패널이 없으면 첫 패널 생성).
    // "activeId 가 있으면 패널을 만든다"는 이펙트로 처리하면 layout 이 매 렌더 새 객체라 이펙트가 매 렌더 돌고,
    // 마지막 패널을 닫는 즉시 같은 사이클에서 패널이 되살아난다(× 무반응). 그래서 필요한 지점에서만 호출한다.
    const openLocal = useCallback(async () => {
      const id = await open()
      layout.showSession(id)
    }, [open, layout])

    // F6 지속: 세션/레이아웃/활성 탭 변경 시 스냅샷을 저장한다(기존 30s 디바운스 flush 경로 재사용).
    // 세션 메타(cwd/profileId/type)의 진실은 main(session.list) — 렌더러가 중복 보관하지 않는다.
    // 오류 패널(placeholder)은 실제 세션이 아니므로 layout 에서 빼고 저장한다.
    // 보내는 것은 렌더러 소유 필드뿐이다(WorkspaceSaveInput) — profiles·knownHosts·ui 는 main 이 지킨다.
    const { cells, focusedId, colRatio, rowRatio, maximizedId, pairAxis } = layout
    const persist = useCallback(async () => {
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
    }, [cells, focusedId, colRatio, rowRatio, maximizedId, pairAxis, restoreErrors, groups, list])

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

    // 세션 활성화(탭 클릭·트리 클릭 공통): 이미 패널에 있으면 그 패널 포커스,
    // 없으면 포커스 패널의 세션을 교체(xterm 재마운트 없이 display 전환).
    const activateSession = useCallback(
      (id: string) => {
        select(id)
        layout.showSession(id)
      },
      [select, layout]
    )

    // F6 부분 복원 재시도: 오류 패널의 프로필로 재접속 → 성공 시 placeholder 를 실 세션으로 교체.
    const retryRestore = useCallback(
      async (errId: string) => {
        const err = restoreErrors.get(errId)
        if (!err || !err.profileId || !sshRestore) return
        const res = await sshRestore(err.profileId)
        if (res.ok) {
          layout.replaceSession(errId, res.id)
          setRestoreErrors((m) => {
            const n = new Map(m)
            n.delete(errId)
            return n
          })
          select(res.id)
        } else {
          showToast(t('restore.retryFailed'))
        }
      },
      [restoreErrors, sshRestore, layout, select, showToast]
    )

    // 오류 패널 닫기: 재시도 포기 — 패널 제거 + 오류 정보 삭제.
    const dismissError = useCallback(
      (errId: string) => {
        const cell = layout.cells.find((c) => c.sessionId === errId)
        if (cell) layout.closePane(cell.id)
        setRestoreErrors((m) => {
          const n = new Map(m)
          n.delete(errId)
          return n
        })
      },
      [layout]
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
        placed.delete(sessionId) // 이 세션이 비우고 갈 칸은 "채울 곳"이지 "이미 배치됨"이 아니다
        const filler = pickBackgroundSession(list, placed, mru) ?? (await open())
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
        const targets = ids.map((id) => list.find((s) => s.id === id)).filter((s): s is Session => !!s)
        if (targets.length === 0) return
        const ssh = targets.filter((s) => s.type === 'ssh')
        const message =
          ssh.length === 0
            ? t('session.close.local')
            : ssh.length === targets.length
              ? t('session.close.ssh')
              : `${t('session.close.ssh')}\n${t('session.close.local')}` // 섞여 있으면 둘 다 알린다
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
          layout.removeSession(s.id)
          close(s.id)
        }
      },
      [layout, close, list, ask]
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
        openLogTail: (sessionId: string, path: string) => setLogTail({ sessionId, path })
      }),
      [activateSession, closeTab, openLocal, startEdit, zoomFont]
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
          .then(({ applied }) => applied && applyTitle(sessionId, title))
          .catch(() => {}) // autoTitle 미지원 하네스 — 제목 갱신만 건너뛴다.
      },
      [applyTitle]
    )

    // 라디얼/팔레트 액션 배선(단일 레지스트리 CONTEXT_ACTIONS 의 id → 실동작).
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
          case 'log.save':
            // 미래 기능(F12 로그 저장). 비활성 — "추후 지원" 안내.
            showToast(t('ctx.future'))
            return
        }
      },
      [focusedSessionId, doSplit, closePane, layout.focusedId, duplicateSession, showToast, onAskAi]
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
          // Ctrl+Shift+A — 라디얼 [AI에게 질문] 과 같은 경로(선택 텍스트를 아는 쪽이 여기다).
          e.preventDefault()
          void onAction('ai.ask')
        } else if (matchBinding(e, 'settings.open')) {
          // R5: Ctrl+, — 타이틀바 기어·File>설정과 같은 상태를 연다(진입점 3개, 배선은 여기 하나).
          e.preventDefault()
          setSettingsOpen(true)
        } else {
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
      onAction
    ])

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
        <TermTabbar
          sessions={list}
          activeId={activeId}
          placedIds={placedIds}
          onSelect={activateSession}
          onClose={closeTab}
          onNew={() => void openLocal()}
          onNewSsh={() => onOpenConnManager?.()}
          onAiCli={() => onOpenAiCli?.()}
          editingId={editingId}
          onStartEdit={startEdit}
          onCommitEdit={commitEdit}
          onDuplicate={duplicateSession}
          onCloseOthers={closeOtherTabs}
          onReorder={reorder}
        />
        <PaneGrid
          layout={layout}
          sessions={list}
          restoreErrors={restoreErrors}
          onRetryRestore={(errId) => void retryRestore(errId)}
          onDismissError={dismissError}
          onCloseSession={closeTab}
          onSplitDrop={(sessionId, zone) => void splitDrop(sessionId, zone)}
          onTitle={onAutoTitle}
          onLink={(sessionId, url, isSsh) => void openLink(sessionId, url, isSsh)}
        />
        <TerminalSearch open={searchOpen} sessionId={focusedSessionId()} onClose={() => setSearchOpen(false)} />
        {/* 파일마다 스트림이 새로 시작돼야 하므로 key 에 경로를 넣는다(같은 컴포넌트 재사용 금지). */}
        {logTail && (
          <LogViewer
            key={`${logTail.sessionId}:${logTail.path}`}
            sessionId={logTail.sessionId}
            path={logTail.path}
            onClose={() => setLogTail(null)}
          />
        )}
        {toast && <div className="pane-toast">{toast}</div>}
        <ContextInteractions
          ctxMenuStyle={prefs.ctxMenuStyle}
          onAction={onAction}
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
