// 앱 메뉴 정의 하나 (M0 0-9) — 렌더러 ≡ 팝업(TitleBar → menuBarItems)과 macOS 메뉴 막대(main/appMenu.ts)가
// **이 표 하나**에서 나온다. 렌더러 전용 의존(React·i18n 로더·navigator)이 없어야 main 도 import 한다.
// mac 메뉴 막대에서 항목을 누르면 main 이 id 를 'menu:pick' 으로 보내고, TitleBar 가 ≡ 클릭과 같은 길로 실행한다.
import { AI_ENTRY } from './features'
import { KEYMAP, type KeymapAction } from './keymap'

// ── 메뉴바 (R4.1) ──
// 타이틀바의 File/Edit/Session/Split/View/Help 는 R3 까지 Session 하나만 동작하는 장식이었다.
// 이제 전부 드롭다운으로 열리고, 항목은 두 종류뿐이다:
//   { action } — keymap 항목. 라벨(labelKo)·단축키 힌트·실행(dispatchAction 이 그 조합의 keydown 을
//                쏜다)이 모두 KEYMAP 에서 나온다. 메뉴는 아무것도 새로 배선하지 않는다.
//   { command } — 단축키가 없는 앱 명령. 상위(Shell)가 onCommand 로 받는다.
// 'Tools' 는 넣을 기능이 없어 지웠다 — 빈 메뉴를 남기는 것이 "눌러도 반응 없음"의 원인이었다.

export type MenuCommandId =
  | 'app.quit'
  | 'font.zoomIn'
  | 'font.zoomOut'
  | 'help.cheatsheet'
  | 'help.about'
  // R16: 내가 보낸 신고의 댓글·상태를 본다. 새 소식이 있으면 TitleBar 가 라벨에 개수를 붙인다.
  | 'help.myReports'
  // 2026-08-13 감사: 우측 바에만 있던 패널 다섯이 메뉴에도 통합 검색(F1)에도 없어서
  // "콘솔"·"포트"를 쳐도 안 나왔다. 팔레트가 MENUBAR 를 그대로 읽으므로 여기 올리면
  // **메뉴와 검색이 한 번에** 해결된다(팔레트 쪽은 손댈 것이 없다).
  | 'panel.sysmon'
  | 'panel.log'
  | 'panel.ps'
  | 'panel.svc'
  | 'panel.disk'
  | 'panel.pkg'
  | 'panel.ctr'
  // 2.0 4단계: 기본 숨김 셋(쿠버네티스·서버 로그·서버 콘솔)은 단축키가 생겨 KeymapAction 으로 옮겼다.
  | 'panel.pastlog'
  // F17: 단축키 없는 진입점.
  | 'ai.bootstrap'

export type MenuEntry = { action: KeymapAction } | { command: MenuCommandId }

// 최상위 이름은 **한글**이다(2026-08-21 준영님). 앱의 다른 라벨이 전부 한글인데 여기만
// File/Edit/Help 라 그 줄만 남의 앱처럼 보였다. 이 표의 항목 라벨은 KEYMAP.labelKo·i18n 에서
// 오므로, 최상위 이름도 같은 결로 직기입한다(CONTEXT_ACTIONS.labelKo 와 같은 방식).
const ALL_MENUBAR: readonly { title: string; items: readonly MenuEntry[] }[] = [
  {
    // 설정은 R5 에서 단축키(Ctrl+,)가 생겨 command → action 으로 옮겼다. 메뉴에 힌트가 붙고
    // 실행 경로도 keydown 핸들러 하나로 합쳐진다("메뉴에서만 되는 기능" 금지).
    title: '파일',
    items: [
      { action: 'session.new' },
      { action: 'settings.open' },
      { command: 'ai.bootstrap' },
      { command: 'app.quit' }
    ]
  },
  {
    title: '편집',
    items: [{ action: 'clipboard.copy' }, { action: 'clipboard.paste' }, { action: 'terminal.search' }]
  },
  {
    // 첫 항목은 계속 연결 관리자다(R3 까지 Session 클릭 = 연결 관리자였다 — 그 손버릇을 깨지 않는다).
    title: '세션',
    items: [
      { action: 'connection.manager' },
      { action: 'session.duplicate' },
      { action: 'tab.next' },
      { action: 'tab.prev' },
      { action: 'terminal.toggle' }
    ]
  },
  {
    title: '분할',
    items: [
      { action: 'split.horizontal' },
      { action: 'split.vertical' },
      { action: 'pane.maximize' },
      { action: 'pane.close' }
    ]
  },
  {
    title: '보기',
    items: [
      { action: 'panel.console' },
      // 하단에 열리는 것들. #84·#86 으로 들어온 여섯이 여기 없어서 F1 검색에도 안 잡혔고,
      // 우측 아이콘을 끄면 되찾을 길이 아예 없었다(2026-08-16).
      { action: 'panel.ports' },
      { action: 'bottom.toggle' },
      { command: 'panel.sysmon' },
      { command: 'panel.ps' },
      { command: 'panel.svc' },
      { command: 'panel.disk' },
      { command: 'panel.pkg' },
      { command: 'panel.ctr' },
      { action: 'panel.k8s' },
      { command: 'panel.log' },
      { action: 'panel.applog' },
      // 우측 레일.
      { command: 'panel.pastlog' },
      { action: 'sidebar.collapse' },
      { action: 'fileTree.toggle' },
      { action: 'explorer.toggle' },
      { action: 'ai.toggle' },
      { command: 'font.zoomIn' },
      { command: 'font.zoomOut' }
    ]
  },
  {
    title: '도움말',
    // 치트시트를 설정처럼 command → action 으로 옮기려다 되돌렸다(2026-08-13, 스모크가 잡았다).
    // `?` 는 **입력 중에는 일부러 안 먹는 키**다(KEY-2). 메뉴 항목을 dispatchAction 으로 돌리면
    // 터미널에 포커스가 있는 보통 상황에서 눌러도 아무 일이 안 일어난다 — 그래서 command 로 둔다.
    // 통합 검색의 중복(치트시트가 두 줄)은 store/palette.ts 의 COMMAND_DUPES 로 걸러 낸다.
    items: [
      { command: 'help.cheatsheet' },
      { action: 'commandBook.toggle' },
      // #206: 단축키가 있어 command 가 아니라 action 이다(설정과 같은 이유 — 실행 경로가 keydown 하나).
      // 통합 검색(F1)은 KEYMAP 에서 이 항목을 저절로 가져간다.
      { action: 'report.open' },
      { command: 'help.myReports' },
      { command: 'help.about' }
    ]
  }
] as const

/**
 * 화면에 그려지는 메뉴바. 숨긴 기능의 항목은 **여기서 빠진다**(features.AI_ENTRY — 0.1.0 에서
 * 아라 대화 숨김). KEYMAP 에서 빠진 액션이 메뉴에 남아 있으면 단축키 힌트가 빈 채로 뜨고,
 * 통합 검색(F1)에도 죽은 항목이 잡힌다 — 목록을 만드는 자리 하나에서 함께 거른다.
 */
const HIDDEN_MENU = new Set<string>(AI_ENTRY ? [] : ['ai.bootstrap', 'ai.toggle', 'ai.ask'])
export const MENUBAR: readonly { title: string; items: readonly MenuEntry[] }[] = ALL_MENUBAR.map((m) => ({
  ...m,
  items: m.items.filter((it) => !HIDDEN_MENU.has('action' in it ? it.action : it.command))
})).filter((m) => m.items.length > 0)

export const menuEntryId = (e: MenuEntry): string => ('action' in e ? e.action : e.command)

/** id 로 항목을 찾는다 — mac 메뉴 막대 클릭(menu:pick)이 id 만 실어 온다. */
export const menuEntryById = (id: string): MenuEntry | undefined =>
  MENUBAR.flatMap((m) => m.items).find((e) => menuEntryId(e) === id)

/** 라벨 — keymap 항목은 KEYMAP.labelKo, 명령 항목은 i18n 'menu.<id>'. t 는 부르는 쪽(렌더러·main)이 넘긴다. */
export const menuEntryLabel = (e: MenuEntry, t: (key: string) => string): string =>
  'action' in e ? (KEYMAP.find((k) => k.action === e.action)?.labelKo ?? e.action) : t('menu.' + e.command)
