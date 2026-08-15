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
import type { DialogSpec, DialogResult } from './Dialog'
import { t } from '../i18n'
import type { BottomId } from '@shared/types'

/** 이 컴포넌트가 그리는 탭. 나머지 하단 탭(포트·시스템·세션 기록)은 각자 컴포넌트가 있다. */
export type ServerToolId = Extract<BottomId, 'ps' | 'svc' | 'disk' | 'pkg' | 'ctr'>

type Props = {
  id: ServerToolId
  /** SSH 세션일 때만 채워진다. 로컬이면 null 이고 아래 안내가 대신 뜬다. */
  sessionId: string | null
  isSsh: boolean
  ask: (spec: DialogSpec) => Promise<DialogResult>
  onAskAi: (text: string) => void
  /** 디스크 표의 [탐색기로 열기]. */
  onOpenExplorer: (path: string) => void
  /** 컨테이너 접속(`docker exec -it`)은 대화형이라 exec 채널로 못 한다 — 터미널로 보낸다. */
  onSendInput: (text: string) => void
}

export function ServerTool({ id, sessionId, isSsh, ask, onAskAi, onOpenExplorer, onSendInput }: Props): JSX.Element {
  // SSH 가 아니면 표 대신 안내. 탭 자체는 남긴다 — 세션 종류에 따라 탭이 나타났다 사라지면
  // "아까 있던 게 어디 갔지"가 된다(PortMonitor 가 이미 같은 규칙이다).
  if (!isSsh || sessionId === null) return <span className="sb-placeholder">{t('console.needSsh')}</span>

  // active 는 늘 true 다 — 하단 패널이 **열린 탭만** 그리므로(BottomPanel 계약) 여기 온 것은
  // 곧 보이고 있다는 뜻이다. 숨은 탭은 아예 마운트되지 않아 폴링이 시작되지 않는다.
  switch (id) {
    case 'ps':
      return <ProcessTable sessionId={sessionId} active ask={ask} onAskAi={onAskAi} />
    case 'svc':
      return <ServiceTable sessionId={sessionId} active ask={ask} onAskAi={onAskAi} />
    case 'disk':
      return <DiskTable sessionId={sessionId} active onOpenExplorer={onOpenExplorer} />
    case 'pkg':
      return <PkgTable sessionId={sessionId} active />
    case 'ctr':
      return <ContainerTable sessionId={sessionId} active ask={ask} onSendInput={onSendInput} />
  }
}
