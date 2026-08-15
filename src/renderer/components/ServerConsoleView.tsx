// F26 서버 콘솔 — 준영님이 고른 ①안(런치패드). "명령어를 외워 타이핑하지 않고 아이콘을 클릭해서
// 서버를 다룬다"의 첫 화면이다.
//
// #84(2026-08-16): **도구 탭이 사라지고 격자만 남았다.** 프로세스·서비스·디스크·패키지·컨테이너는
// 전부 가로가 필요한 표라 하단 패널로 내려갔다(§4.8 — 서버 것은 아래). 그래서 이 창이 하는 일은
// 이제 하나다: **무엇을 열지 고른다.** 같은 표를 창과 하단 두 군데서 보던 상태를 없앤 것이다.
//
// 그 결과 모든 타일에 ↗ 가 붙는다 — 누르면 전부 이 창 밖(하단 패널·탐색기 창·새 세션)에서 열린다.
// #69 가 "어떤 칸은 여기서 열리고 어떤 칸은 딴 데서 열린다"를 문제 삼았는데, 이제 **전부 딴 데서**
// 열려서 그 불일치 자체가 없어졌다.
//
// 창은 파일 탐색기(ExplorerView)와 같은 떠 있는 창이다 — 이동·크기·최대화가 전부 같아 새로 배울
// 것이 없다(창 로직은 store/floatWindow.ts 를 공유한다). #91 에서 이 창이 서버 작업대로 커진다.
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
import { IconClose } from './icons'
import { ServerOverview } from './ServerOverview'
import { t } from '../i18n'

/**
 * 런치패드 칸. #84 부터 **전부** 이 창 밖에서 열린다 — 어디서 열리는지는 상위(Shell)가 정한다.
 *   files            → 탐색기 창
 *   ps·svc·disk·pkg·ctr·log·port → 하단 패널의 그 탭
 *   term             → 그 서버로 새 세션(이 칸만 창을 닫는다 — 터미널이 보여야 한다)
 */
export type ConsoleLaunchId = 'files' | 'ps' | 'svc' | 'disk' | 'pkg' | 'ctr' | 'log' | 'port' | 'term'

// 격자 4열 × 3줄. 순서는 쓰임새 순이다(파일·프로세스·서비스·디스크 / 로그·포트·터미널 / 패키지·컨테이너).
const TOOLS: readonly { id: ConsoleLaunchId; Icon: typeof Activity }[] = [
  { id: 'files', Icon: FolderOpen },
  { id: 'ps', Icon: Activity },
  { id: 'svc', Icon: Server },
  { id: 'disk', Icon: HardDrive },
  { id: 'log', Icon: ScrollText },
  { id: 'port', Icon: Network },
  { id: 'term', Icon: TerminalSquare },
  { id: 'pkg', Icon: Package },
  // F28: 컨테이너(docker → podman). 깔려 있지 않은 서버에서는 표 대신 안내가 뜬다.
  { id: 'ctr', Icon: Boxes }
]

type Props = {
  /** 창을 그릴지. 닫혀도 언마운트하지 않는다(#74) — 창 위치·크기가 남는다. */
  visible: boolean
  /** 활성 세션. 개요(ServerOverview)가 이 세션으로 읽는다. */
  sessionId: string | null
  isSsh: boolean
  /** 제목줄에 찍을 서버 이름(어느 서버를 만지고 있는지가 늘 보여야 한다). */
  serverName: string
  onClose: () => void
  /** 칸을 누르면 상위가 그 자리를 연다 — #84 부터 **전부** 이 창 밖이다. */
  onLaunch: (id: ConsoleLaunchId) => void
}

export function ServerConsoleView({
  visible,
  sessionId,
  isSsh,
  serverName,
  onClose,
  onLaunch
}: Props): JSX.Element {
  const { rect, maximized, drag, toggleMax, z, toFront } = useFloatWindow()

  return (
    // #74: 닫혀도 언마운트하지 않는다 — 창 위치·크기가 남는다.
    <div
      className="exp-win con-win"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: z,
        ...(visible ? null : { display: 'none' })
      }}
      onMouseDown={toFront}
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
        <button
          type="button"
          className="exp-wbtn"
          title={t(maximized ? 'explorer.restore' : 'explorer.maximize')}
          onClick={toggleMax}
        >
          {maximized ? '❐' : '▢'}
        </button>
        <button type="button" className="exp-wbtn x" title={t('console.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="con-body">
        {!isSsh && <span className="sb-placeholder">{t('console.needSsh')}</span>}
        {isSsh && (
          <div className="con-pad">
            {/* 서버의 정체(배포판·커널·가동 시간). 자원 사용량은 하단 [시스템 모니터] 몫이다. */}
            <ServerOverview sessionId={sessionId} active={visible} />
            {TOOLS.map(({ id, Icon }) => (
              // #71: 타일은 진짜 버튼이다 — div 였을 때는 Tab 으로 갈 수도, Enter 로 누를 수도
              // 없었다. 단축키를 이만큼 만든 앱에서 새 화면이 마우스 전용인 것은 어긋난다.
              <button
                key={id}
                type="button"
                className="con-app ext"
                data-tool={id}
                title={t('console.ext.hint')}
                onClick={() => onLaunch(id)}
              >
                <span className="ic">
                  <Icon />
                </span>
                <span className="nm">{t('console.tool.' + id)}</span>
                <span className="sm">{t('console.tool.' + id + '.sub')}</span>
                {/* #84: 이제 **모든** 칸이 창 밖에서 열린다(하단 패널·탐색기 창·새 세션).
                    어떤 칸은 여기서 열리고 어떤 칸은 딴 데서 열리던 불일치가 없어졌다. */}
                <span className="ext-mark" aria-label={t('console.ext.hint')}>
                  ↗
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="exp-grip" title={t('explorer.resize')} onMouseDown={(e) => drag(e, 'resize')} />
    </div>
  )
}
