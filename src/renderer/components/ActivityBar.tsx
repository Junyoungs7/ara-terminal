import { Gauge, LayoutGrid, Sparkles } from 'lucide-react'
import { isActivityOpen, type ActivityId, type ActivityOpenState } from '../store/activityBar'
import { IconAra, IconMonitor, IconLog, IconPreview, IconFolder, IconGear } from './icons'
import { t } from '../i18n'
import { KEYMAP, type KeymapAction } from '../../shared/keymap'

// FB-ui2(FB-0006) 우측 액티비티 바 — 상단 아라/기어 아이콘이 "AI 버튼인지 잘 모르겠고 클릭도
// 불편하다"는 실사용 피드백에 대한 응답. VS Code 액티비티 바처럼 우측 최외곽에 고정된 세로
// 아이콘 열을 두고, 클릭 한 번으로 해당 패널을 토글한다. [파일]은 좌측 사이드바에 그대로 둔다
// (준영님 명시 — 이 바로 옮기지 않는다).
//
// 툴팁은 기존 i18n 문구를 그대로 재사용한다(ai.open/settings.open 은 이미 단축키를 괄호로 담고
// 있다) — 이 컴포넌트를 위한 새 문구를 따로 만들지 않는다.
const ICONS: Record<ActivityId, () => JSX.Element> = {
  ai: IconAra,
  monitor: IconMonitor,
  // F29 시스템 모니터 — CPU·메모리·GPU·디스크 계기판. console 과 같이 lucide 를 재사용한다.
  sys: () => <Gauge />,
  // F30 AI 세션 — 아라 아이콘과 헷갈리지 않게 다른 글리프를 쓴다(그쪽은 대화, 이쪽은 관측).
  aisess: () => <Sparkles />,
  log: IconLog,
  preview: IconPreview,
  explorer: IconFolder,
  // F26 서버 콘솔 — 런치패드(아이콘 격자)를 그대로 뜻하는 글리프. ConnTree 가 이미 쓰고 있는
  // lucide-react 를 재사용한다(새 라이브러리 없음).
  console: () => <LayoutGrid />,
  settings: IconGear
}

// #73(2026-08-14): 단축키를 문구에 박아 두지 않는다. 예전엔 아홉 중 둘만 "설정 (Ctrl+,)" 처럼
// 문자열에 직접 적혀 있었는데, 실제로 단축키가 있는 것은 다섯이었다(미니 프리뷰·파일 탐색기·
// 세션 로그가 빠져 있었다). KEYMAP 에서 끌어오면 새 단축키가 생겨도 툴팁이 따라오고, 없는 것엔
// 안 붙는다 — 치트시트·메뉴바와 같은 방식이다.
// 툴팁의 "라벨 (조합)" 꼬리표는 store/tooltip.ts 의 splitTip 이 뱃지로 떼어 낸다.
const ACTIVITY_KEY: Partial<Record<ActivityId, KeymapAction>> = {
  ai: 'ai.toggle',
  log: 'log.save',
  preview: 'preview.toggle',
  explorer: 'explorer.toggle',
  settings: 'settings.open'
}

const isMac = navigator.userAgent.includes('Mac')

/** 액티비티 바 툴팁 — 이름 + (있으면) 단축키. 설정 [우측 아이콘 바] 목록은 이름만 쓴다. */
export function activityTip(id: ActivityId): string {
  const name = t(ACTIVITY_TITLE_KEY[id])
  const action = ACTIVITY_KEY[id]
  const b = action ? KEYMAP.find((k) => k.action === action) : undefined
  return b ? `${name} (${isMac ? b.mac : b.win})` : name
}

export const ACTIVITY_TITLE_KEY: Record<ActivityId, string> = {
  ai: 'ai.open',
  monitor: 'sidebar.tab.monitor',
  sys: 'sysm.title',
  aisess: 'aisess.title',
  log: 'log.title',
  preview: 'preview.title',
  explorer: 'explorer.title',
  console: 'console.title',
  settings: 'settings.open'
}

export function ActivityBar({
  items,
  state,
  onToggle,
  badges
}: {
  /** 그릴 항목과 그 순서. 설정에서 끄고 켜고 옮길 수 있어(2026-08-13) 더 이상 고정 배열이 아니다. */
  items: readonly ActivityId[]
  state: ActivityOpenState
  onToggle: (id: ActivityId) => void
  /** F30: 항목 위에 찍을 점. 패널을 닫아 둬도 "볼 것이 있다"를 알리는 유일한 자리다. */
  badges?: Partial<Record<ActivityId, boolean>>
}) {
  return (
    <div className="activity-bar" role="tablist" aria-label={t('activity.bar.label')}>
      {items.map((id) => {
        const Icon = ICONS[id]
        const active = isActivityOpen(id, state)
        return (
          <button
            key={id}
            type="button"
            className={'act-item' + (active ? ' active' : '')}
            role="tab"
            aria-selected={active}
            title={activityTip(id)}
            data-activity={id}
            onClick={() => onToggle(id)}
          >
            <Icon />
            {badges?.[id] ? <span className="act-badge" aria-hidden /> : null}
          </button>
        )
      })}
    </div>
  )
}
