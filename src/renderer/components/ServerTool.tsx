// #84(2026-08-16) — 하단 패널에 끼우는 **서버 표 다섯**(프로세스·서비스·디스크·패키지·컨테이너).
//
// 왜 생겼나: 이 표들은 F26 에서 떠 있는 콘솔 창의 탭이었다. 그런데 전부 **가로가 필요한 표**다
// (프로세스는 PID·사용자·CPU·MEM·명령 5열). 배치 원칙(§4.8 — 서버 것은 아래)에 따라 하단으로
// 내려왔고, 창은 런치패드(고르는 곳)만 남았다.
//
// 표 컴포넌트 자체는 **하나도 다시 만들지 않았다** — 콘솔 창이 쓰던 것을 그대로 끼운다.
// 그 컴포넌트들은 원래 `active` 로 폴링을 껐다 켜게 만들어져 있어서(숨은 탭이 원격에 명령을
// 보내면 안 된다) 자리를 옮기는 데 손댈 것이 없었다.
//
// 서버 선택 UI 가 여기 없는 것은 의도다(준영님 2026-08-16): 하단은 **지금 보고 있는 세션**의
// 서버를 따라간다. 다른 서버를 보려면 세션 탭을 바꾸거나 런치패드를 쓴다 — 터미널은 A서버인데
// 하단은 B서버인 상태를 만들지 않는다.
import { ProcessTable } from './ProcessTable'
import { ServiceTable } from './ServiceTable'
import { DiskTable } from './DiskTable'
import { PkgTable } from './PkgTable'
import { ContainerTable } from './ContainerTable'
import { K8sPanel } from './K8sPanel'
import type { DialogSpec, DialogResult } from './Dialog'
import { t } from '../i18n'
import type { BottomId } from '@shared/types'

/** 이 컴포넌트가 그리는 탭. 나머지 하단 탭(포트·시스템·세션 기록)은 각자 컴포넌트가 있다. */
export type ServerToolId = Extract<BottomId, 'ps' | 'svc' | 'disk' | 'pkg' | 'ctr' | 'k8s'>

type Props = {
  id: ServerToolId
  /**
   * 지금 보이는 탭인가(#87 ⑤). 하단 패널이 **연 적 있는 탭을 전부 마운트해 두고** 숨기므로
   * 이 값이 폴링을 켜고 끈다 — 안 보이는 표가 2.5초마다 원격에 명령을 보내면 안 된다.
   */
  active: boolean
  /** SSH 세션일 때만 채워진다. 로컬이면 null 이고 아래 안내가 대신 뜬다. */
  sessionId: string | null
  isSsh: boolean
  /**
   * 이 표가 보고 있는 서버 이름. **파괴적 확인창이 이걸 찍는다**(2026-08-16) — 하단은 세션의
   * 서버를, 작업대는 좌측에서 고른 서버를 보고 둘은 서로 다를 수 있게 설계돼 있다(§4.8).
   * 그런데 정작 `systemctl stop`·kill·컨테이너 제거 확인창이 대상을 안 밝히고 있었다.
   */
  server?: string
  ask: (spec: DialogSpec) => Promise<DialogResult>
  onAskAi: (text: string) => void
  /** 디스크 표의 [탐색기로 열기]. */
  onOpenExplorer: (path: string) => void
  /** 컨테이너 접속(`docker exec -it`)은 대화형이라 exec 채널로 못 한다 — 터미널로 보낸다. */
  onSendInput: (text: string) => void
}

export function ServerTool({ id, active, sessionId, isSsh, server, ask, onAskAi, onOpenExplorer, onSendInput }: Props): JSX.Element {
  // SSH 가 아니면 표 대신 안내. 탭 자체는 남긴다 — 세션 종류에 따라 탭이 나타났다 사라지면
  // "아까 있던 게 어디 갔지"가 된다(PortMonitor 가 이미 같은 규칙이다).
  if (!isSsh || sessionId === null) return <span className="sb-placeholder">{t('console.needSsh')}</span>

  switch (id) {
    case 'ps':
      return <ProcessTable sessionId={sessionId} active={active} server={server} ask={ask} onAskAi={onAskAi} />
    case 'svc':
      return <ServiceTable sessionId={sessionId} active={active} server={server} ask={ask} onAskAi={onAskAi} />
    case 'disk':
      return <DiskTable sessionId={sessionId} active={active} onOpenExplorer={onOpenExplorer} />
    case 'pkg':
      return <PkgTable sessionId={sessionId} active={active} />
    case 'ctr':
      return <ContainerTable sessionId={sessionId} active={active} server={server} ask={ask} onSendInput={onSendInput} />
    // 쿠버는 조작이 없다 — ask·onSendInput 을 넘기지 않는 것이 그 사실을 타입으로 못박는다.
    case 'k8s':
      return <K8sPanel sessionId={sessionId} active={active} server={server} />
  }
}
