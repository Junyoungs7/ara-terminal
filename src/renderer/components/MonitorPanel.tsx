import type { PortForward, RemotePort } from '@shared/types'
import { PortMonitor } from './PortMonitor'
import { IconClose } from './icons'
import { t } from '../i18n'

// FB-ui2(FB-0007② 변경): [모니터] 탭을 좌측 사이드바에서 우측 고정 레일로 이관한다. 내용은
// FB-monitor 가 이미 다듬은 PortMonitor 를 그대로 옮겨 붙인 것 — 검색·범위 필터·프로세스 표기를
// 다시 만들지 않는다. 껍데기(헤더+닫기)는 AiPanel/.ai-head 와 같은 조합을 재사용한다.
// PortMonitor 자체는 .sidebar/.sb-panel 에 종속되지 않는다(FB-monitor 인수인계 확인) — 이 새
// 부모(.monitor-panel)만 flex 세로 컨테이너면 그대로 들어간다.
export function MonitorPanel({
  open,
  onClose,
  ports,
  forwards,
  sessionId,
  isSsh,
  onRefresh,
  onForwardsChanged
}: {
  open: boolean
  onClose: () => void
  ports: RemotePort[]
  forwards: PortForward[]
  sessionId: string | null
  isSsh: boolean
  onRefresh: () => void
  onForwardsChanged: () => void
}) {
  if (!open) return null
  return (
    <div className="monitor-panel">
      <div className="mon-head">
        <span className="mon-name">{t('sidebar.tab.monitor')}</span>
        <span className="mon-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>
      <PortMonitor
        ports={ports}
        forwards={forwards}
        sessionId={sessionId}
        isSsh={isSsh}
        onRefresh={onRefresh}
        onForwardsChanged={onForwardsChanged}
      />
    </div>
  )
}
