import { useCallback, useRef, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { BOTTOM_IDS, type BottomId } from '@shared/types'

// #78(2026-08-15) — 터미널 **아래** 패널.
//
// 왜 만들었나: 우측 레일 여섯 중 절반이 **가로가 필요한 표**였다 — 포트 목록은 주소·포트·프로세스
// 3열을 280px 에, 세션 기록은 로그 한 줄을 340px 에 욱여넣고 있었다. 그래서 같은 성격의
// 프로세스·서비스 표는 아예 레일을 포기하고 **떠 있는 창**으로 빠져나갔다(서버 콘솔) —
// 같은 문제를 서로 다른 두 방법으로 푼 셈이고, 그 결과 창 종류가 셋이 됐다.
//
// 하단은 **세로만 먹는다.** 터미널 80칸에 영향이 없어서 우측 레일과 같이 열어도 된다
// (레일이 하나만 열리는 #79 규칙은 우측에만 적용된다).
//
// 액티비티 바는 옮기지 않았다. VS Code 는 바가 **사이드바 내용을 바꾸는** 구조라 왼쪽이 맞지만,
// 우리 바는 "무엇을 열지"를 고른다 — 왼쪽으로 옮기면 바는 왼쪽인데 열리는 것은 오른쪽·아래가 돼
// 지금보다 나빠진다. 대신 바의 [포트]·[세션 기록]을 누르면 하단 패널이 **그 탭으로** 열린다.

const LABEL: Record<BottomId, string> = {
  monitor: 'sidebar.tab.monitor',
  sys: 'sysm.title',
  // #84: 서버 콘솔에서 내려온 표 다섯. 라벨은 런치패드 타일과 같은 키를 쓴다 — 같은 것을
  // 두 이름으로 부르면 "런치패드의 그 프로세스"와 "하단의 이 프로세스"가 달라 보인다.
  ps: 'console.tool.ps',
  svc: 'console.tool.svc',
  disk: 'console.tool.disk',
  pkg: 'console.tool.pkg',
  ctr: 'console.tool.ctr',
  log: 'log.title'
}

const MIN_H = 120
const DEFAULT_H = 260

type Props = {
  /** 열린 탭. null 이면 패널이 없다. */
  tab: BottomId | null
  onTab: (id: BottomId) => void
  onClose: () => void
  /**
   * #84: 보여 줄 탭과 그 순서. 액티비티 바의 항목 설정(순서·숨김)을 그대로 받는다 —
   * 여덟 탭이 좁으면 설정에서 안 쓰는 것을 끄면 된다(하단만의 새 설정을 만들지 않는다).
   * 지금 열려 있는 탭은 숨겨져 있어도 그린다 — 보고 있는 것이 갑자기 사라지면 안 된다.
   */
  ids?: readonly BottomId[]
  /** 탭별 내용. 열려 있는 것만 그린다 — 안 보이는 탭이 원격에 명령을 보내면 안 된다. */
  children: (tab: BottomId) => ReactNode
}

export function BottomPanel({ tab, onTab, onClose, ids, children }: Props): JSX.Element | null {
  // 높이는 세션 수명 동안만 산다(우측 레일·떠 있는 창과 같은 규칙 — 레이아웃 설정이 아니다).
  const [h, setH] = useState(DEFAULT_H)
  const hRef = useRef(h)
  hRef.current = h

  // 위쪽 경계를 끌어 높이 조절. 사이드바 .sb-resizer 와 같은 조작감 — 새 방식을 만들지 않는다.
  const startResize = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = hRef.current
    const move = (ev: MouseEvent): void => {
      // 위로 끌면 커진다. 터미널이 아주 얇아지지 않게 위쪽 여백을 남긴다.
      const next = h0 + (y0 - ev.clientY)
      setH(Math.max(MIN_H, Math.min(window.innerHeight - 200, next)))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  if (!tab) return null

  // 설정이 없으면 전부(기본 순서). 열린 탭이 숨김 목록에 있어도 그 탭만은 남긴다.
  const base = ids ?? BOTTOM_IDS
  const shownIds = base.includes(tab) ? base : [tab, ...base]

  return (
    <div className="bottom-panel" style={{ height: h, flexBasis: h }}>
      <div className="bp-resizer" role="separator" title={t('bottom.resize')} onMouseDown={startResize} />
      <div className="bp-tabs" role="tablist" aria-label={t('bottom.label')}>
        {shownIds.map((id) => (
          <button
            key={id}
            type="button"
            className={'bp-tab' + (id === tab ? ' on' : '')}
            role="tab"
            aria-selected={id === tab}
            data-bottom={id}
            onClick={() => onTab(id)}
          >
            {t(LABEL[id])}
          </button>
        ))}
        <span className="sb-tab-spacer" />
        <button type="button" className="bp-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="bp-body">{children(tab)}</div>
    </div>
  )
}
