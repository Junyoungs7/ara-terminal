import {
  aiModelsOf,
  aiProviderOf,
  DEFAULT_BELL,
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_CURSOR_BLINK,
  DEFAULT_CURSOR_STYLE,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SCROLLBACK,
  DEFAULT_SESSION_LOG,
  UI_SCALE_FACTOR,
  uiScaleOf,
  type UiPrefs,
  type UiState
} from '@shared/types'
import { activityHiddenOf, activityOrderOf } from '../store/activityBar'

// 터미널 동작 설정(R3.1 선택 자동 복사 / R3.4 스크롤백 / R5 커서·벨)의 렌더러 캐시.
// xterm 은 TerminalPane 이 mount 하는 순간 만들어지므로, 값을 React 상태로 두면 세션마다 prop 을
// 흘려야 한다. 새 xterm 이 읽어 갈 "현재 값" 한 벌이면 충분해서 모듈 변수로 둔다 —
// 이미 열려 있는 xterm 에 대한 즉시 반영은 termRegistry.applyTermPrefsToAll 이 맡는다.
// F12 세션 로그 두 값은 여기 없다 — xterm 이 읽어 갈 값이 아니라 main 로거가 쓰는 값이라
// ui:setPrefs 로만 흐른다(이 캐시는 "새 xterm 이 읽어 갈 현재 값" 전용이다).
export const termPrefs: Omit<
  UiPrefs,
  | 'uiScale'
  | 'sessionLog'
  | 'logRetentionDays'
  | 'aiProvider'
  | 'aiModels'
  | 'aiCompatibleBaseUrl'
  | 'activityOrder'
  | 'activityHidden'
> = {
  scrollback: DEFAULT_SCROLLBACK,
  copyOnSelect: DEFAULT_COPY_ON_SELECT,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  cursorBlink: DEFAULT_CURSOR_BLINK,
  bell: DEFAULT_BELL
}

// 스냅샷 ui(옵셔널 필드 다수) → 기본값이 채워진 확정 prefs. 설정 창·부트 복원이 공유한다.
export function prefsFrom(
  ui: Pick<
    UiState,
    | 'uiScale'
    | 'scrollback'
    | 'copyOnSelect'
    | 'cursorStyle'
    | 'cursorBlink'
    | 'bell'
    | 'sessionLog'
    | 'logRetentionDays'
    | 'aiProvider'
    | 'aiModels'
    | 'aiCompatibleBaseUrl'
    | 'activityOrder'
    | 'activityHidden'
  >
): UiPrefs {
  return {
    uiScale: uiScaleOf(ui.uiScale),
    scrollback: ui.scrollback ?? DEFAULT_SCROLLBACK,
    copyOnSelect: ui.copyOnSelect ?? DEFAULT_COPY_ON_SELECT,
    cursorStyle: ui.cursorStyle ?? DEFAULT_CURSOR_STYLE,
    cursorBlink: ui.cursorBlink ?? DEFAULT_CURSOR_BLINK,
    bell: ui.bell ?? DEFAULT_BELL,
    // 기본 off — 사용자가 켜지 않으면 파일이 생기지 않는다(설계 §5.5 / 보안 체크리스트).
    sessionLog: ui.sessionLog ?? DEFAULT_SESSION_LOG,
    logRetentionDays: ui.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    // 손상·구버전 스냅샷은 aiProviderOf/aiModelsOf 가 기본값으로 내린다(main 이 같은 함수로 다시 클램프한다).
    aiProvider: aiProviderOf(ui.aiProvider),
    aiModels: aiModelsOf(ui.aiModels),
    // 액티비티 바 순서·숨김. 저장값은 신뢰 경계 밖이라 여기서 클램프하고, 새로 생긴 항목은
    // activityOrderOf 가 기본 자리에 끼워 넣는다(안 그러면 새 기능이 영영 안 보인다).
    activityOrder: activityOrderOf(ui.activityOrder),
    activityHidden: activityHiddenOf(ui.activityHidden),
    aiCompatibleBaseUrl: typeof ui.aiCompatibleBaseUrl === 'string' ? ui.aiCompatibleBaseUrl : ''
  }
}

export function applyUiPrefs(prefs: UiPrefs): void {
  // UI-font5: --ui-scale 하나만 바꾸면 tokens.css 의 --fs-* 척도와 행 높이가 전부 따라 움직인다
  // (calc(<px> * var(--ui-scale))). transform: scale() 을 쓰지 않는 이유는 글자가 흐려지기 때문.
  // 이 함수는 DOM 없는 단위 테스트(node 환경)에서도 호출된다 — 나머지 캐시 갱신은 그대로 돌아야 하므로
  // DOM 접근만 건너뛴다(테스트를 위해 함수를 쪼개지 않는다).
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ui-scale', String(UI_SCALE_FACTOR[prefs.uiScale]))
  }
  termPrefs.scrollback = prefs.scrollback
  termPrefs.copyOnSelect = prefs.copyOnSelect
  termPrefs.cursorStyle = prefs.cursorStyle
  termPrefs.cursorBlink = prefs.cursorBlink
  termPrefs.bell = prefs.bell
}
