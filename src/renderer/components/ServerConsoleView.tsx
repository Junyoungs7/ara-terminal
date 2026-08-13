// F26 서버 콘솔 — 준영님이 고른 ①안(런치패드). "명령어를 외워 타이핑하지 않고 아이콘을 클릭해서
// 서버를 다룬다"의 첫 화면이다.
//
// 왜 이렇게 생겼나:
//  · 창은 파일 탐색기(ExplorerView)와 **같은 떠 있는 창**이다 — 이동·크기·최대화·탭 조작이 전부 같아
//    새로 배울 것이 없다(창 로직은 store/floatWindow.ts 를 공유한다, 새 창 인프라 없음).
//  · 런치패드에서 아이콘을 누르면 그 도구가 **같은 창의 탭**으로 열린다(①+③ 조합). 런치패드 탭은
//    항상 첫 자리에 남는다 — 도구를 닫아도 돌아올 곳이 있어야 한다.
//  · 실제로 도는 도구는 지금 셋이다(프로세스·서비스·디스크). 나머지 칸은 흐리게 "추후"로 두고
//    눌러도 아무 일이 없다 — 눌리는데 빈 화면이 뜨는 것보다 낫다.
import { useState } from 'react'
import {
  Activity,
  Boxes,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  Network,
  Package,
  ScrollText,
  Server,
  TerminalSquare
} from 'lucide-react'
import { useFloatWindow } from '../store/floatWindow'
import { ProcessTable } from './ProcessTable'
import { ServiceTable } from './ServiceTable'
import { DiskTable } from './DiskTable'
import { IconClose } from './icons'
import { PkgTable } from './PkgTable'
import { ContainerTable } from './ContainerTable'
import { ServerOverview } from './ServerOverview'
import type { DialogSpec, DialogResult } from './Dialog'
import { t } from '../i18n'

/** 탭으로 열 수 있는 도구. 나머지 런치패드 칸은 R3 이후다. */
export type ConsoleToolId = 'ps' | 'svc' | 'disk' | 'pkg' | 'ctr'

// 런치패드 격자 4열 × 2줄. soon 칸은 자리만 잡아 둔다 — 다음 라운드에 무엇이 오는지 보이는 편이
// "도구가 이것뿐인가?"보다 낫다(목업 ①과 같은 배치).
/** 콘솔 안에 탭으로 뜨지 않고 **기존 창·패널을 그대로 여는** 칸. 같은 화면을 두 번 만들지 않는다 —
    런치패드의 값어치는 흩어진 진입점을 한자리에 모으는 것이다(R1 설계 §3). */
export type ConsoleLaunchId = 'files' | 'log' | 'port' | 'term'

const TOOLS = [
  { id: 'files', Icon: FolderOpen, tool: null, launch: 'files' as ConsoleLaunchId },
  { id: 'ps', Icon: Activity, tool: 'ps' as ConsoleToolId, launch: null },
  { id: 'svc', Icon: Server, tool: 'svc' as ConsoleToolId, launch: null },
  { id: 'disk', Icon: HardDrive, tool: 'disk' as ConsoleToolId, launch: null },
  { id: 'log', Icon: ScrollText, tool: null, launch: 'log' as ConsoleLaunchId },
  { id: 'port', Icon: Network, tool: null, launch: 'port' as ConsoleLaunchId },
  { id: 'term', Icon: TerminalSquare, tool: null, launch: 'term' as ConsoleLaunchId },
  { id: 'pkg', Icon: Package, tool: 'pkg' as ConsoleToolId, launch: null },
  // F28: 컨테이너(docker → podman). 깔려 있지 않은 서버에서는 표 대신 안내가 뜬다.
  { id: 'ctr', Icon: Boxes, tool: 'ctr' as ConsoleToolId, launch: null }
] as const

type Props = {
  /** 활성 세션. 원격 명령은 이 세션의 SSH 커넥션으로만 나간다. */
  sessionId: string | null
  isSsh: boolean
  /** 제목줄에 찍을 서버 이름(어느 서버를 만지고 있는지가 늘 보여야 한다). */
  serverName: string
  onClose: () => void
  ask: (spec: DialogSpec) => Promise<DialogResult>
  onAskAi: (text: string) => void
  /** 디스크 창의 [탐색기로 열기] — 기존 파일 탐색기 창을 그 경로로 연다(새 창 인프라 없음). */
  onOpenExplorer: (path: string) => void
  /** 런치패드의 파일·로그·포트·터미널 칸 — 콘솔 안에 다시 그리지 않고 기존 진입점을 부른다. */
  onLaunch: (id: ConsoleLaunchId) => void
  /** 지금 세션의 터미널로 한 줄 보내기(실행까지). 컨테이너 접속처럼 **대화형**이라 exec 채널로는
      못 하는 것만 이 길을 탄다 — F27 AI CLI 실행과 같은 채널이다. */
  onSendInput: (text: string) => void
}

export function ServerConsoleView({
  sessionId,
  isSsh,
  serverName,
  onClose,
  ask,
  onAskAi,
  onOpenExplorer,
  onLaunch,
  onSendInput
}: Props): JSX.Element {
  const { rect, maximized, drag, toggleMax } = useFloatWindow()
  // 열려 있는 도구 탭. 런치패드('pad')는 목록에 없고 항상 맨 앞에 그린다(닫을 수 없다).
  const [tabs, setTabs] = useState<ConsoleToolId[]>([])
  const [active, setActive] = useState<'pad' | ConsoleToolId>('pad')

  const open = (tool: ConsoleToolId): void => {
    setTabs((cur) => (cur.includes(tool) ? cur : [...cur, tool]))
    setActive(tool)
  }
  const close = (tool: ConsoleToolId): void => {
    setTabs((cur) => cur.filter((x) => x !== tool))
    // 보고 있던 탭을 닫으면 런치패드로 돌아간다(도구가 하나뿐이라 이웃으로 옮길 자리가 없다).
    setActive((cur) => (cur === tool ? 'pad' : cur))
  }

  return (
    <div
      className="exp-win con-win"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      role="dialog"
      aria-label={t('console.title')}
    >
      <div className="exp-title" onMouseDown={(e) => drag(e, 'move')} onDoubleClick={toggleMax}>
        <span className="exp-tico con-tico">
          <LayoutGrid />
        </span>
        <span className="exp-tname">{t('console.title')}</span>
        {isSsh && <span className="con-srv">{serverName}</span>}
        <span className="sb-tab-spacer" />
        <span className="exp-wbtn" title={t(maximized ? 'explorer.restore' : 'explorer.maximize')} onClick={toggleMax}>
          {maximized ? '❐' : '▢'}
        </span>
        <span className="exp-wbtn x" title={t('console.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>

      <div className="exp-tabs">
        <div className={'exp-tab' + (active === 'pad' ? ' on' : '')} data-tab="pad" onClick={() => setActive('pad')}>
          <span className="exp-tab-nm">{t('console.pad')}</span>
        </div>
        {tabs.map((tool) => (
          <div
            key={tool}
            className={'exp-tab' + (active === tool ? ' on' : '')}
            data-tab={tool}
            onClick={() => setActive(tool)}
          >
            <span className="exp-tab-nm">{t('console.tool.' + tool)}</span>
            <span
              className="exp-tab-x"
              title={t('explorer.tab.close')}
              onClick={(e) => {
                e.stopPropagation()
                close(tool)
              }}
            >
              <IconClose />
            </span>
          </div>
        ))}
      </div>

      <div className="con-body">
        {!isSsh && <span className="sb-placeholder">{t('console.needSsh')}</span>}
        {isSsh && (
          <>
            <div className="con-pad" style={active === 'pad' ? undefined : { display: 'none' }}>
              {/* 서버의 정체(배포판·커널·가동 시간). 자원 사용량은 F29 사이드바 몫이다. */}
              <ServerOverview sessionId={sessionId} active={active === 'pad'} />
              {TOOLS.map(({ id, Icon, tool, launch }) => (
                <div
                  key={id}
                  className={'con-app' + (tool || launch ? '' : ' soon')}
                  data-tool={id}
                  {...(tool
                    ? { onClick: () => open(tool) }
                    : launch
                      ? { onClick: () => onLaunch(launch) }
                      : {})}
                >
                  <span className="ic">
                    <Icon />
                  </span>
                  <span className="nm">{t('console.tool.' + id)}</span>
                  <span className="sm">{t(tool || launch ? 'console.tool.' + id + '.sub' : 'console.soon')}</span>
                </div>
              ))}
            </div>
            {/* 도구 탭은 마운트를 유지한다(검색어·정렬을 잊지 않게). 숨은 탭은 active=false 라
                원격에 명령을 보내지 않는다 — 탐색기의 숨은 트리와 같은 규칙. */}
            {tabs.map((tool) => (
              <div key={tool} className="con-pane" style={active === tool ? undefined : { display: 'none' }}>
                {tool === 'ps' && <ProcessTable sessionId={sessionId} active={active === tool} ask={ask} onAskAi={onAskAi} />}
                {tool === 'svc' && <ServiceTable sessionId={sessionId} active={active === tool} ask={ask} onAskAi={onAskAi} />}
                {tool === 'disk' && (
                  <DiskTable sessionId={sessionId} active={active === tool} onOpenExplorer={onOpenExplorer} />
                )}
                {tool === 'pkg' && <PkgTable sessionId={sessionId} active={active === tool} />}
                {tool === 'ctr' && (
                  <ContainerTable
                    sessionId={sessionId}
                    active={active === tool}
                    ask={ask}
                    // 컨테이너 접속은 터미널로 나간다 — 콘솔 창이 그 위를 덮고 있으면 안 보인다.
                    onSendInput={(text) => {
                      onSendInput(text)
                      onClose()
                    }}
                  />
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="exp-grip" title={t('explorer.resize')} onMouseDown={(e) => drag(e, 'resize')} />
    </div>
  )
}
