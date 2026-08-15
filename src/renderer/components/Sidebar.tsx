import type { ConnectionProfile, WorkProfile } from '@shared/types'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { ConnTree, type TreeTarget } from './ConnTree'
import { FileTree, type ActiveFileSession } from './FileTree'
import type { DialogSpec, DialogResult } from './Dialog'
import type { TreeActionId } from '../interactions/actions'
import type { TmuxListResult } from '../../shared/tmuxList'
import { t } from '../i18n'

export type SidebarTab = 'conn' | 'file'

// 풀하이트 사이드바 — [연결|파일] 탭 전환 (design-system §4.2). 동시 스택 금지.
// F4b: 연결 탭에 서버→세션 트리(서버 노드 하위 열린 세션 자식 행) + ＋버튼으로 연결 관리자.
// FB-ui2: [모니터] 탭은 우측 액티비티 바(ActivityBar)로 이관했다 — 이 컴포넌트엔 더 남아 있지 않다.
export function Sidebar({
  active,
  onSwitch,
  collapsed,
  profiles,
  groups,
  conn,
  activeProfileId,
  sessions,
  activeSessionId,
  onNewConn,
  onConnect,
  onSelectSession,
  onTreeAction,
  onTmuxQuery,
  workProfiles,
  onOpenWork,
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
  askText
}: {
  active: SidebarTab
  onSwitch: (tab: SidebarTab) => void
  collapsed: boolean
  profiles: ConnectionProfile[]
  groups: string[]
  conn: ConnState
  activeProfileId: string | null
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
  // F14: 터미널 Ctrl+V 파일 업로드가 시작될 때 [파일] 탭을 펼쳐 전송 큐를 보여 준다.
  onRevealFiles: () => void
  // 파일 삭제 확인·새 폴더 이름 입력(Shell 의 단일 Dialog 인스턴스).
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
}) {
  // 파일 트리는 활성 세션의 파일시스템을 읽는다 — 세션이 없으면 보여 줄 게 없으니 [연결] 을 띄운다.
  // 저장된 activeTab 값은 건드리지 않는다(접속하면 원래 보던 탭으로 돌아온다 · F6 복원과 충돌 없음).
  const tab: SidebarTab = fileSession ? active : 'conn'
  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="sb-tabs" role="tablist">
        <button
          type="button"
          className={'sb-tab' + (tab === 'conn' ? ' active' : '')}
          role="tab"
          aria-selected={tab === 'conn'}
          onClick={() => onSwitch('conn')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="7" rx="1.5" />
            <rect x="3" y="13" width="18" height="7" rx="1.5" />
            <path d="M7 7.5h.01M7 16.5h.01" />
          </svg>
          {t('sidebar.tab.conn')}
        </button>
        <button
          type="button"
          className={'sb-tab' + (tab === 'file' ? ' active' : '')}
          role="tab"
          aria-selected={tab === 'file'}
          // 세션이 없을 때 눌러도 아무 일이 안 일어나면 "무반응"으로 읽힌다 — 아예 못 누르게 한다.
          disabled={!fileSession}
          title={fileSession ? undefined : t('sidebar.tab.fileNeedsSession')}
          onClick={() => onSwitch('file')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          </svg>
          {t('sidebar.tab.file')}
        </button>
        <div className="sb-tab-spacer" />
        {/* 새 연결 — 연결 관리자 모달 열기 */}
        <div className="sb-act" title={t('sidebar.act.newConn')} onClick={onNewConn}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </div>
        {/* 새로고침 버튼은 제거했다(R1.5): 트리는 profiles/sessions 스토어에서 파생되는 상태라
            다시 읽어올 원격 소스가 없고, 실제 배선도 ＋(연결 관리자 열기)와 같아 중복 버튼이었다. */}
      </div>
      <div className={'sb-panel' + (tab === 'conn' ? ' active' : '')} role="tabpanel">
        <ConnTree
          profiles={profiles}
          groups={groups}
          conn={conn}
          activeProfileId={activeProfileId}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onConnect={onConnect}
          onSelectSession={onSelectSession}
          onTreeAction={onTreeAction}
          onTmuxQuery={onTmuxQuery}
          workProfiles={workProfiles}
          onOpenWork={onOpenWork}
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
    </div>
  )
}
