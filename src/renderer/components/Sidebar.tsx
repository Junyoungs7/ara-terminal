import type { ConnectionProfile, WorkProfile } from '@shared/types'
import type { FeatureShown } from '@shared/features'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { ConnTree, type TreeTarget } from './ConnTree'
import { FileTree, type ActiveFileSession } from './FileTree'
import { AiBenchTree } from './AiBenchTree'
import type { WorkbenchRow } from '../store/aiWorkbench'
import type { AiSessionState } from '@shared/aiSession'
import type { DialogSpec, DialogResult } from './Dialog'
import type { TreeActionId } from '../interactions/actions'
import type { TmuxListResult } from '../../shared/tmuxList'
import { shownTab } from '../store/sidebar'
import type { GroupLayout } from '../store/groups'
import { t } from '../i18n'
import { Compass, History, SlidersHorizontal, Wrench } from 'lucide-react'
import { KEYMAP, isMac, type KeymapAction } from '../../shared/keymap'
import { PastLogPanel } from './PastLogPanel'

export type SidebarTab = 'conn' | 'file' | 'ai' | 'past'

// 2026-08-19 준영님 확정: [연결]·[파일]은 **왼쪽 아이콘 레일**로 나갔다(우측 액티비티 바와 같은
// IntelliJ 툴윈도우 방식 — 누르면 열리고 다시 누르면 닫힌다). 글리프는 옛 탭 것을 그대로 쓴다:
// 자리를 옮겼다고 모양까지 바꾸면 같은 것인 줄 모른다.
const TAB_ICON: Record<Exclude<SidebarTab, 'past'>, () => JSX.Element> = {
  conn: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  ),
  file: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  ),
  // #129 작업대. 우측 [아라](관제실)와 **다른 글리프**를 쓴다 — 같은 모양이면 같은 것인 줄 안다.
  ai: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="13" rx="2" />
      <path d="M8 10.5l2 2-2 2M13 14.5h3" />
    </svg>
  )
}

const TAB_LABEL: Record<SidebarTab, string> = {
  conn: 'sidebar.tab.conn',
  file: 'sidebar.tab.file',
  ai: 'sidebar.tab.ai',
  past: 'pastlog.title'
}

/**
 * 레일 툴팁 — 이름 · 어디에 열림 + (있으면) 단축키. 끝의 `(조합)` 은 툴팁이 뱃지로 떼어 낸다(store/tooltip.ts splitTip).
 *
 * "어디에 열림"(#87)은 2.0 에서 우측 바를 지우며 같이 사라졌다가 다듬기 R1(리뷰 B1)에서 돌아왔다 — 레일 일곱 칸이
 * 하는 일이 넷(사이드바 탭 · OS 창 · 하단 패널 · 덮개)으로 갈리는데 아이콘만으로는 눌러 보기 전에 모른다.
 */
function railTip(label: string, action?: KeymapAction, where?: 'sidebar' | 'window' | 'bottom'): string {
  const b = action ? KEYMAP.find((k) => k.action === action) : undefined
  const name = where ? `${label} · ${t('activity.where.' + where)}` : label
  return b ? `${name} (${isMac() ? b.mac : b.win})` : name
}
const TAB_KEY: Partial<Record<SidebarTab, KeymapAction>> = { file: 'fileTree.toggle' }

/**
 * 좌측 아이콘 레일 — 사이드바의 여닫이. 옛 우측 액티비티 바(2.0 에서 삭제)와 **같은 규칙**이었고, 클래스만 달랐다
 * (같은 클래스를 돌려 쓰면 e2e 가 엉뚱한 버튼을 누른다 — 그 사고를 이미 한 번 냈다).
 *
 * 접혀 있으면 어떤 아이콘도 눌린 상태가 아니다: 눌림은 "그 패널이 지금 화면에 있다"는 뜻이어야 한다.
 */
export function SidebarRail({
  active,
  collapsed,
  fileEnabled,
  onPick,
  features,
  explorerOpen,
  onExplorer,
  bottomOpen,
  onBottom,
  settingsOpen,
  onSettings
}: {
  active: SidebarTab
  collapsed: boolean
  /** 세션이 없으면 파일 트리가 읽을 파일시스템이 없다 — 못 누르게 막고 이유를 툴팁에 적는다. */
  fileEnabled: boolean
  onPick: (tab: SidebarTab) => void
  /** 2.0 설정 › 기능 — 끈 탐색기·지난 세션은 레일에서 뺀다(단축키·검색으로는 열린다). 없으면 전부. */
  features?: FeatureShown
  /** 2.0: 우측 액티비티 바가 없어지며 왼쪽으로 온 셋 — 탐색기 창 · 하단 패널(서버 도구) · 설정. */
  explorerOpen: boolean
  onExplorer: () => void
  bottomOpen: boolean
  onBottom: () => void
  settingsOpen: boolean
  onSettings: () => void
}) {
  // 패널이 실제로 무엇을 그리는지와 같은 값을 봐야 한다 — 아래 Sidebar 도 이 함수를 쓴다.
  const shown = shownTab(active, fileEnabled)
  const tab = (id: SidebarTab, Icon: () => JSX.Element) => {
    const on = !collapsed && shown === id
    const disabled = id === 'file' && !fileEnabled
    return (
      <button
        key={id}
        type="button"
        className={'lrail-item' + (on ? ' active' : '')}
        role="tab"
        aria-selected={on}
        data-tab={id}
        disabled={disabled}
        title={disabled ? t('sidebar.tab.fileNeedsSession') : railTip(t(TAB_LABEL[id]), TAB_KEY[id], 'sidebar')}
        onClick={() => onPick(id)}
      >
        <Icon />
      </button>
    )
  }
  // 사이드바 탭이 아닌 것(창·하단 패널·설정 덮개). 여닫이(하단 패널·설정)는 눌림(aria-pressed)이고,
  // 탐색기는 **토글이 아니다**(다시 눌러도 안 닫히고 앞으로 온다 — 리뷰 B6) — 눌림 대신 이름이 "열기"다.
  // `active` 는 그대로 "그 창이 지금 열려 있다"는 표시로 둔다.
  const tool = (
    id: string,
    on: boolean,
    tip: string,
    onClick: () => void,
    Icon: () => JSX.Element,
    name?: string
  ) => (
    <button
      key={id}
      type="button"
      className={'lrail-item' + (on ? ' active' : '')}
      {...(name ? { 'aria-label': name } : { 'aria-pressed': on })}
      data-activity={id}
      title={tip}
      onClick={onClick}
    >
      <Icon />
    </button>
  )
  // 사이드바 탭 묶음(연결 · 파일 · AI 작업대 · 지난 세션) | 1px | 도구 묶음(탐색기 창 · 서버 도구) … 아래 설정.
  // 시안은 한 줄로 섞여 있었는데, 누르면 일어나는 일이 다른 둘을 갈라 놓는다(리뷰 B1).
  return (
    <div className="lrail" role="tablist" aria-label={t('sidebar.rail.label')}>
      {tab('conn', TAB_ICON.conn)}
      {tab('file', TAB_ICON.file)}
      {tab('ai', TAB_ICON.ai)}
      {(features?.pastlog !== false || (!collapsed && active === 'past')) && tab('past', () => <History />)}
      <div className="lrail-div" role="separator" />
      {(features?.explorer !== false || explorerOpen) &&
        tool(
          'explorer',
          explorerOpen,
          railTip(t('wb.title'), 'explorer.toggle', 'window'),
          onExplorer,
          () => <Compass />,
          t('rail.explorer.open')
        )}
      {tool('bottombar', bottomOpen, railTip(t('bottom.bar.toggle'), undefined, 'bottom'), onBottom, () => <Wrench />)}
      <div className="lrail-spacer" />
      {tool('settings', settingsOpen, railTip(t('settings.open'), 'settings.open'), onSettings, () => <SlidersHorizontal />)}
    </div>
  )
}

// 풀하이트 사이드바 — 레일이 고른 패널 하나 (design-system §4.2). 동시 스택 금지.
// F4b: 연결 탭에 서버→세션 트리(서버 노드 하위 열린 세션 자식 행) + ＋버튼으로 연결 관리자.
// FB-ui2: [모니터] 탭은 하단 패널로 갔다 — 이 컴포넌트엔 더 남아 있지 않다.
export function Sidebar({
  active,
  collapsed,
  profiles,
  groups,
  conn,
  sessions,
  activeSessionId,
  onNewConn,
  onConnect,
  onSelectSession,
  onTreeAction,
  onTmuxQuery,
  workProfiles,
  onOpenWork,
  groupLayout,
  onMoveProfile,
  onGroupLayout,
  onNotice,
  connCollapsed,
  onConnCollapsed,
  cwdBy,
  onCloseSession,
  fileSession,
  fileCwd,
  onCdTerminal,
  onTailFile,
  onSaveWork,
  onAiCli,
  onTerminalHere,
  onAskAiPaths,
  onRevealFiles,
  ask,
  askText,
  benchRows,
  onBenchOpen,
  onBenchRemove,
  onBenchSplit,
  onNewBench,
  onPastClose,
  onPastOpenCurrent
}: {
  active: SidebarTab
  collapsed: boolean
  profiles: ConnectionProfile[]
  groups: string[]
  conn: ConnState
  sessions: Session[]
  activeSessionId: string | null
  onNewConn: () => void
  onConnect: (profileId: string) => void
  onSelectSession: (sessionId: string) => void
  onTreeAction: (id: TreeActionId, target: TreeTarget) => void
  // FB-monitor(F19 tmux 후속): 트리 우클릭 tmux 서브메뉴용 세션 목록 1회 조회.
  onTmuxQuery: (sessionId: string) => Promise<TmuxListResult>
  workProfiles?: WorkProfile[]
  onOpenWork?: (w: WorkProfile) => void
  // #193 그룹 배치(순서·2단 중첩)와 드래그 결과. 저장하는 곳은 Shell 하나다 — 트리는 판정만 한다.
  groupLayout?: GroupLayout
  onMoveProfile?: (profileId: string, group: string | undefined) => void
  onGroupLayout?: (next: GroupLayout) => void
  onNotice?: (msg: string) => void
  connCollapsed?: Record<string, true>
  onConnCollapsed?: (next: Record<string, true>) => void
  // 세션 카드에 현재 작업 위치를 적고(세션이 여럿일 때 이름만으론 구분이 안 된다) ✕ 로 종료한다.
  cwdBy?: Record<string, string>
  onCloseSession?: (sessionId: string) => void
  // F7/R7: [파일] 탭 트리 대상 — 활성 세션(로컬/SSH) + OSC7 cwd.
  fileSession: ActiveFileSession
  fileCwd: string | null
  onCdTerminal: (absPath: string) => void
  // F13: 파일 행 우클릭 [tail로 보기] → 메인 영역 로그 뷰어(SFTP 세션 전용).
  onTailFile: (absPath: string) => void
  // 파일 트리 우클릭 [이 위치를 작업 프로필로 저장] — 지금 보고 있는 폴더를 넘긴다.
  onSaveWork: (absPath: string) => void
  // F27: [파일] 탭 원격 폴더 우클릭 → AI CLI 시작 창(그 폴더가 채워진 채로). Shell 이 연다.
  onAiCli: (absPath: string) => void
  // #88 R1: 아라 연결점 — 이 폴더에서 새 셸 / 고른 것을 아라 입력창에.
  // 작업대와 **같은 동작**이어야 한다(같은 트리인데 자리마다 다르면 안 된다 — 스모크가 잡았다).
  onTerminalHere: (absPath: string) => void
  onAskAiPaths: (paths: string[]) => void
  // #129 [AI] 작업대 목록 — 행·열기·지우기·새로 만들기. 목록의 주인은 store/aiWorkbench.ts 다.
  benchRows: WorkbenchRow[]
  onBenchOpen: (s: AiSessionState, sessionId: string | null) => void
  onBenchRemove: (s: AiSessionState) => void
  onBenchSplit: (s: AiSessionState) => void
  onNewBench: () => void
  /** 2.0 [지난 세션] — 우측 레일에서 사이드바로 왔다. 닫기 = 사이드바 접기, [진행 중] = 하단 [세션 기록]. */
  onPastClose: () => void
  onPastOpenCurrent: () => void
  // F14: 터미널 Ctrl+V 파일 업로드가 시작될 때 [파일] 탭을 펼쳐 전송 큐를 보여 준다.
  onRevealFiles: () => void
  // 파일 삭제 확인·새 폴더 이름 입력(Shell 의 단일 Dialog 인스턴스).
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
}) {
  // 파일 트리는 활성 세션의 파일시스템을 읽는다 — 세션이 없으면 보여 줄 게 없으니 [연결] 을 띄운다.
  // 판정은 레일과 **같은 함수**를 쓴다(store/sidebar.ts): 여기만 떨어뜨리면 레일은 [파일] 이 눌린
  // 채로 남아 서로 다른 말을 한다.
  const tab: SidebarTab = shownTab(active, !!fileSession)
  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      {/* 2.0 [지난 세션] — 자기 머리(제목·새로고침·닫기)가 있어 사이드바 머리 대신 그것을 쓴다(높이 같음). */}
      {tab === 'past' && <PastLogPanel open={!collapsed} onClose={onPastClose} onOpenCurrent={onPastOpenCurrent} />}
      {/* 옛 [연결|파일] 탭이 있던 자리. 탭은 레일로 나갔고(2026-08-19) 지금 보고 있는 패널의
          **이름**과 그 패널의 동작만 남는다 — IntelliJ 툴윈도우 머리와 같은 모양이다. */}
      {tab !== 'past' && (
      <div className="sb-tabs">
        <span className="sb-head">{t(TAB_LABEL[tab])}</span>
        <div className="sb-tab-spacer" />
        {/* #129 새 작업대 — 지금 보고 있는 세션의 폴더에서 AI CLI 를 띄운다(= 작업대를 만든다).
            AI CLI 시작(Ctrl+Shift+L)과 **같은 길**이다 — 만드는 문이 둘로 갈리면 안 된다. */}
        {tab === 'ai' && (
          <button type="button" className="sb-act" data-action="bench.new" title={t('bench.new')} onClick={onNewBench}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
        {/* 새 연결 — 연결 관리자 모달 열기. [파일] 을 보고 있을 때는 뜻이 없어 내린다. */}
        {tab === 'conn' && (
          <button type="button" className="sb-act" title={t('sidebar.act.newConn')} onClick={onNewConn}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
        {/* 새로고침 버튼은 제거했다(R1.5): 트리는 profiles/sessions 스토어에서 파생되는 상태라
            다시 읽어올 원격 소스가 없고, 실제 배선도 ＋(연결 관리자 열기)와 같아 중복 버튼이었다. */}
      </div>
      )}
      <div className={'sb-panel' + (tab === 'conn' ? ' active' : '')} role="tabpanel">
        <ConnTree
          profiles={profiles}
          groups={groups}
          conn={conn}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onConnect={onConnect}
          onSelectSession={onSelectSession}
          onTreeAction={onTreeAction}
          onTmuxQuery={onTmuxQuery}
          workProfiles={workProfiles}
          onOpenWork={onOpenWork}
          groupLayout={groupLayout}
          onMoveProfile={onMoveProfile}
          onGroupLayout={onGroupLayout}
          onNotice={onNotice}
          connCollapsed={connCollapsed}
          onConnCollapsed={onConnCollapsed}
          cwdBy={cwdBy}
          onCloseSession={onCloseSession}
        />
      </div>
      <div className={'sb-panel' + (tab === 'file' ? ' active' : '')} role="tabpanel">
        <FileTree
          session={fileSession}
          active={tab === 'file'}
          cwd={fileCwd}
          onCdTerminal={onCdTerminal}
          onTailFile={onTailFile}
          onSaveWork={onSaveWork}
          onAiCli={onAiCli}
          // #88 R1: 아라 연결점은 **파일 화면 어디서나** 같아야 한다 — 작업대에만 있고 여기 없으면
          // 같은 트리인데 자리마다 다르게 동작한다(스모크가 그 어긋남을 잡았다).
          onTerminalHere={onTerminalHere}
          onAskAiPaths={onAskAiPaths}
          onReveal={onRevealFiles}
          ask={ask}
          askText={askText}
        />
      </div>
      <div className={'sb-panel' + (tab === 'ai' ? ' active' : '')} role="tabpanel">
        <AiBenchTree
          rows={benchRows}
          // 경과 열의 시계는 이 패널을 보고 있을 때만 돈다([파일] 트리와 같은 규칙).
          active={tab === 'ai'}
          activeSessionId={activeSessionId}
          onOpen={onBenchOpen}
          onRemove={onBenchRemove}
          onSplit={onBenchSplit}
        />
      </div>
    </div>
  )
}
