import { Activity, BookOpen, Boxes, Gauge, HardDrive, History, Package, PanelBottom, ScrollText, Server, Ship } from 'lucide-react'
import { isActivityOpen, type ActivityId, type ActivityOpenState } from '../store/activityBar'
import { isBottomId, isRailId } from '@shared/types'
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
  // #84: 서버 콘솔의 표 다섯이 하단 탭이 되면서 액티비티 항목이 됐다. 글리프는 런치패드
  // 타일이 쓰던 것 그대로다 — 같은 기능을 두 모양으로 그리면 같은 것인 줄 모른다.
  ps: () => <Activity />,
  svc: () => <Server />,
  disk: () => <HardDrive />,
  pkg: () => <Package />,
  ctr: () => <Boxes />,
  k8s: () => <Ship />,
  // F30 AI 세션 — 아라 아이콘과 헷갈리지 않게 다른 글리프를 쓴다(그쪽은 대화, 이쪽은 관측).
  log: IconLog,
  // 2026-08-27 [서버 로그] — 세션 기록(log)과 가르려고 두루마리 글리프를 쓴다(그쪽은 내가 친 것,
  // 이쪽은 서버 프로그램이 뱉는 것).
  applog: () => <ScrollText />,
  // #86: 지난 세션 — 시계 되감기. [세션 기록](현재)과 글리프를 달리해 둘을 가른다.
  pastlog: () => <History />,
  preview: IconPreview,
  explorer: IconFolder,
  // 2026-08-22 준영님 제보 9번 — "책 아이콘을 사용하여". 명령어 북은 읽는 자료라 책이 맞다.
  cmdbook: () => <BookOpen />,
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
  cmdbook: 'commandBook.toggle',
  settings: 'settings.open'
}

const isMac = navigator.userAgent.includes('Mac')

/**
 * #87 ①(2026-08-16): 이 항목이 **어디에 열리는가**.
 *
 * 준영님이 처음 지적하신 "이 버튼을 눌렀는데 왜 다른 창이 켜지지?"의 마지막 잔재였다 —
 * 아이콘 열넷 중 어떤 것은 아래, 어떤 것은 오른쪽, 어떤 것은 창인데 **눌러 봐야 알았다.**
 * #83 에서 규칙(아래=서버 것 / 오른쪽=아라 것)을 정했으니 바에도 그 구획이 보여야 한다.
 * 판정은 배치의 단일 출처(RAIL_IDS/BOTTOM_IDS)에서 파생한다 — 여기 목록을 또 만들지 않는다.
 */
export type ActivitySlot = 'bottom' | 'rail' | 'window'
export function activitySlot(id: ActivityId): ActivitySlot {
  if (isBottomId(id)) return 'bottom'
  if (isRailId(id)) return 'rail'
  return 'window' // 작업대 창 · 설정 드로어
}

/** 툴팁 — 이름 + 어디에 열리는지 + (있으면) 단축키. 설정 [우측 아이콘 바] 목록은 이름만 쓴다. */
export function activityTip(id: ActivityId): string {
  const name = t(ACTIVITY_TITLE_KEY[id])
  const action = ACTIVITY_KEY[id]
  const b = action ? KEYMAP.find((k) => k.action === action) : undefined
  // 설정은 어디에 열리는지 말할 것이 없다(드로어는 그 자체가 목적지다).
  // 설정·명령어 북은 어디에 열리는지 말할 것이 없다(오버레이 그 자체가 목적지다).
  const where = id === 'settings' || id === 'cmdbook' ? '' : ` · ${t('activity.where.' + activitySlot(id))}`
  return b ? `${name}${where} (${isMac ? b.mac : b.win})` : `${name}${where}`
}

export const ACTIVITY_TITLE_KEY: Record<ActivityId, string> = {
  ai: 'ai.open',
  monitor: 'sidebar.tab.monitor',
  sys: 'sysm.title',
  ps: 'console.tool.ps',
  svc: 'console.tool.svc',
  disk: 'console.tool.disk',
  pkg: 'console.tool.pkg',
  ctr: 'console.tool.ctr',
  k8s: 'console.tool.k8s',
  log: 'log.title',
  applog: 'applog.title',
  pastlog: 'pastlog.title',
  preview: 'preview.title',
  explorer: 'wb.title',
  cmdbook: 'cmdbook.title',
  settings: 'settings.open'
}

export function ActivityBar({
  items,
  state,
  onToggle,
  badges,
  bottomOpen,
  onToggleBottomBar
}: {
  /** 그릴 항목과 그 순서. 설정에서 끄고 켜고 옮길 수 있어(2026-08-13) 더 이상 고정 배열이 아니다. */
  items: readonly ActivityId[]
  state: ActivityOpenState
  onToggle: (id: ActivityId) => void
  /** F30: 항목 위에 찍을 점. 패널을 닫아 둬도 "볼 것이 있다"를 알리는 유일한 자리다. */
  badges?: Partial<Record<ActivityId, boolean>>
  /** 하단바가 떠 있나(맨 아래 토글의 눌림 상태). */
  bottomOpen: boolean
  onToggleBottomBar: () => void
}) {
  // 2026-08-17 준영님 제보 ③: **하단에 열리는 것은 이 바에 없다.** 우측 아이콘을 눌렀는데 아래가
  // 열리는 불일치가 #87 에서 툴팁("· 아래에 열림")으로 덮여 있었는데, 실제로 쓰시고는 "우측에서는
  // 버튼들을 제거하고 하단 바 버튼을 우측 하단에 두라"로 정리하셨다. 그래서 바에는 **오른쪽에
  // 열리는 것과 창으로 열리는 것**만 남고, 여덟은 상태바의 BottomDock 으로 간다.
  // 판정은 여기서도 배치의 단일 출처(BOTTOM_IDS)에서 파생한다 — 목록을 또 만들지 않는다.
  const railItems = items.filter((id) => !isBottomId(id))
  return (
    <div className="activity-bar" role="tablist" aria-label={t('activity.bar.label')}>
      {railItems.map((id, i) => {
        const Icon = ICONS[id]
        const active = isActivityOpen(id, state)
        // 묶음이 바뀌는 자리에 선을 하나 긋는다 — 아이콘 열넷이 한 덩어리로 보이면 규칙이 안 읽힌다.
        // 사용자가 순서를 바꿔 섞어 놓으면 선이 여러 개 생기는데, 그것도 정직한 표시다.
        const sep = i > 0 && activitySlot(railItems[i - 1]) !== activitySlot(id)
        return (
          <button
            key={id}
            type="button"
            className={'act-item' + (active ? ' active' : '') + (sep ? ' sep' : '')}
            role="tab"
            aria-selected={active}
            title={activityTip(id)}
            data-activity={id}
            data-slot={activitySlot(id)}
            onClick={() => onToggle(id)}
          >
            <Icon />
            {badges?.[id] ? <span className="act-badge" aria-hidden /> : null}
          </button>
        )
      })}
      {/* **하단바 토글 — 바 맨 아래에 고정**(2026-08-17 준영님 정정, IntelliJ 툴윈도우 방식).
          위 항목들과 성격이 다르다: 저것들은 "무엇을 열지"를 고르고, 이것은 "**하단바를 쓸지**"를
          정한다. 그래서 순서·숨김 설정(ActivityId)에 넣지 않는다 — 끌 수 있게 두면 그것을 끈
          순간 하단바를 여는 길이 사라진다(도구 여덟은 꺼도 탭이 하나 줄 뿐이라 괜찮다). */}
      <button
        type="button"
        className={'act-item act-bottombar' + (bottomOpen ? ' active' : '')}
        aria-pressed={bottomOpen}
        title={t('bottom.bar.toggle')}
        data-activity="bottombar"
        onClick={onToggleBottomBar}
      >
        <PanelBottom />
      </button>
    </div>
  )
}
