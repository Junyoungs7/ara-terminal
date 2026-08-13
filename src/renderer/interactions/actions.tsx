import type { ReactNode } from 'react'
import { t } from '../i18n'
import type { MenuItem } from './ContextMenu'
import { KEYMAP, type KeymapAction } from '../../shared/keymap'
import type { TmuxListResult } from '../../shared/tmuxList'

// 컨텍스트 액션 단일 레지스트리 — 라디얼 메뉴와 스마트 팔레트가 이 배열 하나를 공유한다
// (이중 정의 금지, 계획서 §C F4c). 목업 variant-final-3 의 8항목·순서·아이콘을 그대로 이식.
//
// tint: 'ai' → --purple, 'danger' → --err (목업의 인라인 HEX 대신 토큰 — 매직넘버 스캔 통과).
// future: true → 미래 기능(F12 로그 저장). 비활성 스타일 + "추후 지원" 토스트.
// (ai.ask 는 W3 에서 실배선됐다 — future 를 뗐다.)

export type ActionId =
  | 'copy'
  | 'paste'
  | 'split.horizontal'
  | 'split.vertical'
  | 'session.duplicate'
  | 'log.save'
  | 'ai.ask'
  | 'pane.close'

export type ContextAction = {
  id: ActionId
  labelKo: string
  icon: ReactNode
  tint?: 'ai' | 'danger'
  future?: boolean
}

const svg = (children: ReactNode, extra?: Record<string, string>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...extra}>
    {children}
  </svg>
)

// 순서 = 목업 라디얼 배치 순서(-90°에서 시계방향). 팔레트 그리드도 동일 순서를 쓴다.
export const CONTEXT_ACTIONS: readonly ContextAction[] = [
  {
    id: 'copy',
    labelKo: '복사',
    icon: svg(
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </>
    )
  },
  {
    id: 'paste',
    labelKo: '붙여넣기',
    icon: svg(
      <>
        <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
      </>
    )
  },
  {
    id: 'split.horizontal',
    labelKo: '가로 분할',
    icon: svg(
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="12" x2="21" y2="12" />
      </>,
      { strokeLinecap: 'butt' }
    )
  },
  {
    id: 'split.vertical',
    labelKo: '세로 분할',
    icon: svg(
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="12" y1="3" x2="12" y2="21" />
      </>,
      { strokeLinecap: 'butt' }
    )
  },
  {
    id: 'session.duplicate',
    labelKo: '세션 복제',
    icon: svg(
      <>
        <rect x="3" y="3" width="13" height="13" rx="2" />
        <path d="M8 16v3a2 2 0 002 2h9a2 2 0 002-2V8a2 2 0 00-2-2h-3" />
      </>
    )
  },
  {
    id: 'log.save',
    labelKo: '로그 저장',
    future: true,
    icon: svg(<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />)
  },
  {
    id: 'ai.ask',
    labelKo: 'AI에게 질문',
    tint: 'ai',
    icon: svg(
      <>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
        <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" />
      </>
    )
  },
  {
    // 이력(뒤집힌 결정이라 남긴다): FB-ui2(FB-0005) 때는 detach 였다 — 패널만 빠지고 세션은 탭에
    // 남아 다시 클릭하면 붙었다. **2026-08-11 준영님 결정으로 종료로 뒤집혔다**("탭을 껐으면 세션도
    // 꺼지고 해당 창도 꺼져야 한다. 다시 붙는 건 없다"). 지금은 정말로 세션을 죽이므로 라벨도 그렇게
    // 말한다. 함수·id 는 그대로(pane.close). 자세한 경위는 shared/keymap.ts 의 같은 항목 주석.
    id: 'pane.close',
    labelKo: '이 칸 닫기(세션 종료)',
    tint: 'danger',
    icon: svg(<path d="M6 6l12 12M18 6L6 18" />)
  }
]

// 터미널 우클릭 기본 메뉴(리스트) 항목. 라디얼·팔레트와 같은 CONTEXT_ACTIONS 를 그대로 쓴다
// (이중 정의 금지) — 모양만 세로 리스트로 바꾼 것이다. 단축키 힌트는 keymap 단일 소스에서 가져온다.
// ActionId 6개(split×2/session.duplicate/log.save/ai.ask/pane.close)는 KeymapAction 과 이름이 같다.
const isMac = navigator.userAgent.includes('Mac')

// 복사/붙여넣기만 이름이 다르다(clipboard.*) — 나머지 6개는 ActionId 가 곧 KeymapAction 이다.
const KEY_OF: Partial<Record<ActionId, KeymapAction>> = {
  copy: 'clipboard.copy',
  paste: 'clipboard.paste'
}

// KEYMAP 표기(Ctrl+Shift+W 등). 플랫폼별 표기는 여기 한 곳에서 고른다.
function comboOf(action: KeymapAction): string | undefined {
  const b = KEYMAP.find((k) => k.action === action)
  return b ? (isMac ? b.mac : b.win) : undefined
}

function hintFor(id: ActionId): string | undefined {
  return comboOf(KEY_OF[id] ?? (id as string as KeymapAction))
}

export function terminalMenu(): MenuItem[] {
  return CONTEXT_ACTIONS.map((a) => {
    const hint = hintFor(a.id)
    return {
      id: a.id,
      label: a.labelKo,
      icon: a.icon,
      ...(hint ? { hint } : {}),
      ...(a.tint === 'danger' ? { danger: true } : {}),
      ...(a.future ? { dim: true } : {})
    }
  })
}

// ── 트리·탭바 컨텍스트 메뉴 액션 (F4c 레지스트리와 같은 파일 = 단일 출처) ──
// 라디얼/팔레트가 터미널 그리드 액션을 담당하듯, 아래는 사이드바 트리·탭바 ＋ 메뉴의 액션이다.
// 라벨은 i18n(ko.json conn.menu.*)에 두고 여기서는 id → 라벨 키 매핑만 갖는다.
export type TreeActionId =
  | 'server.connect'
  | 'server.newSession'
  | 'server.edit'
  | 'server.duplicate'
  | 'server.forgetHostKey'
  | 'server.delete'
  | 'session.focus'
  | 'session.rename'
  | 'session.duplicate'
  | 'session.close'
  | 'session.closeOthers'
  | 'group.newConn'
  | 'group.new'
  | 'group.rename'
  | 'group.delete'
  | 'local.new'
  | 'ssh.open'
  // F27: AI CLI 한 번에 시작(접속+폴더+실행). 서버 우클릭에서 열면 그 서버가 이미 정해진 채로 뜬다.
  | 'aicli.start'
  // 작업 프로필(서버+폴더 즐겨찾기): 팝업 열기 / 지금 위치를 그 목록에 저장.
  | 'work.open'
  | 'work.save'
  // FB-ui2 추가 지시(2026-08-05): 연결 관리자 좌측 프로필 목록 우클릭. "정보 수정"/"복제"/"삭제"는
  // 트리의 server.edit/server.duplicate/server.delete 를 그대로 재사용한다(같은 동작이라 새 id 를
  // 만들지 않는다) — profile.new 만 새로 추가한다(빈 폼으로 리셋, ConnectionModal.newProfile).
  | 'profile.new'
  // FB-monitor(F19 tmux 후속): [모니터] 탭 버튼 줄 대신 트리 우클릭 → 서브메뉴로 이동.
  // attach 는 서버가 알려준 세션 이름이 붙는 동적 id 라 템플릿 리터럴 타입으로 받는다.
  | 'session.tmux.new'
  | 'session.tmux.detach'
  | 'session.tmux.prevWindow'
  | 'session.tmux.nextWindow'
  | `session.tmux.attach:${string}`

// 메뉴 종류별 항목 순서(위험 항목은 항상 마지막).
const TREE_MENUS = {
  server: [
    'server.connect',
    'server.newSession',
    // F27 진입점 ④ — 서버가 이미 정해진 채로 창이 열린다.
    'aicli.start',
    'server.edit',
    'server.duplicate',
    'server.forgetHostKey',
    'server.delete'
  ],
  // W4sat F21: RDP는 세션·호스트키 개념이 없다(외부 앱 실행뿐) — 그 항목들을 뺀 축소판.
  serverRdp: ['server.connect', 'server.edit', 'server.duplicate', 'server.delete'],
  session: ['session.focus', 'session.rename', 'session.close'],
  // 탭 우클릭(R2.2). 트리 세션 메뉴와 같은 액션 id 를 공유한다 — 이름만 다른 중복 정의 금지.
  tab: ['session.rename', 'session.duplicate', 'session.close', 'session.closeOthers'],
  // R6: 그룹 이름 변경(그룹 내 프로필 일괄 갱신) / 삭제(프로필은 "기타"로 이동).
  group: ['group.newConn', 'group.rename', 'group.delete'],
  // "기타"는 그룹이 아니라 그룹 미지정 프로필이 모이는 자리다 — 이름을 바꾸거나 지울 대상이 없다.
  groupNone: ['group.newConn'],
  local: ['local.new', 'work.open'],
  // 사이드바 빈 영역 우클릭 — 트리 어디를 눌러도 새 셸·새 연결·새 그룹을 만들 수 있게 한다
  // (＋ 새 로컬 셸 행을 대체). group.new 는 R6 에서 실제로 배선됐다.
  sidebar: ['local.new', 'ssh.open', 'group.new', 'work.open'],
  // 탭바 ＋ 버튼: 로컬 셸 / SSH 연결 / AI CLI 시작(F27 진입점 ①).
  add: ['local.new', 'ssh.open', 'aicli.start'],
  // FB-ui2: 연결 관리자 좌측 프로필 목록 우클릭(프로필 행). "정보 수정"·"복제"·"삭제"는 트리의
  // server.* 액션을 그대로 쓴다 — RDP 프로필에도 4항목 다 그대로 뜬다(SSH 전용 항목인
  // server.forgetHostKey 는 이 메뉴엔 처음부터 없어 serverRdp 처럼 따로 뺄 게 없다).
  connRow: ['profile.new', 'server.edit', 'server.duplicate', 'server.delete'],
  // 프로필 목록의 빈 영역 우클릭 — 새 프로필만.
  connEmpty: ['profile.new']
} as const satisfies Record<string, readonly TreeActionId[]>

export type TreeMenuKind = keyof typeof TREE_MENUS

const DANGER: ReadonlySet<TreeActionId> = new Set<TreeActionId>([
  'server.delete',
  'session.closeOthers',
  'group.delete'
])

// 메뉴 종류 → ContextMenu 항목. 라벨은 호출 시점에 t() 로 해석한다(로케일 전환 반영).
export function treeMenu(kind: TreeMenuKind): MenuItem[] {
  return TREE_MENUS[kind].map((id) => ({
    id,
    label: t('conn.menu.' + id),
    ...(DANGER.has(id) ? { danger: true } : {})
  }))
}

// FB-monitor(F19 tmux 후속): 트리 우클릭 "tmux" 항목 — 호버하면 서브메뉴로 [새 세션] + 현재
// 연결된 세션 목록(클릭=붙기) + 분리/이전 창/다음 창이 뜬다. 목록 조회는 호출측(ConnTree)이
// 미리 비동기로 실행해 결과만 넘긴다 — 여기는 순수 변환뿐(단위 테스트 대상).
export function tmuxMenuItem(query: TmuxListResult | 'loading'): MenuItem {
  const listItems: MenuItem[] =
    query === 'loading'
      ? [{ id: 'tmux.status', label: t('tmux.status.loading'), disabled: true }]
      : query.status === 'ok'
        ? query.sessions.map((name) => ({ id: `session.tmux.attach:${name}`, label: name }))
        : [{ id: 'tmux.status', label: t(`tmux.status.${query.status}`), disabled: true }]

  return {
    id: 'session.tmux',
    label: t('conn.menu.session.tmux'),
    submenu: [
      { id: 'session.tmux.new', label: t('tmux.new') },
      ...listItems,
      { id: 'session.tmux.detach', label: t('tmux.detach') },
      { id: 'session.tmux.prevWindow', label: t('tmux.prevWin') },
      { id: 'session.tmux.nextWindow', label: t('tmux.nextWin') }
    ]
  }
}

// ── [파일] 탭 우클릭 메뉴 (R7) ──
// 트리 메뉴와 달리 항목이 상황에 따라 달라진다(선택 개수 · 폴더/파일 · 로컬/원격) —
// 고정 배열 네 벌을 만드는 대신 여기 한 함수가 조합한다. 위험 항목(삭제)은 언제나 마지막.
export type FileActionId =
  | 'file.open'
  // F27 진입점 ③ — 이 폴더가 채워진 채로 AI CLI 시작 창이 열린다(원격 폴더 하나를 고른 때만).
  | 'file.aicli'
  | 'file.saveWork'
  | 'file.edit'
  | 'file.download'
  | 'file.tail'
  | 'file.rename'
  | 'file.mkdir'
  | 'file.delete'

// canTail = 원격 파일 하나 선택(W1 F13). 로컬 파일에는 붙지 않는다 — tail 은 원격 셸에서 도는 명령이다.
// 편집(file.edit)은 파일 하나일 때만 — 로컬·원격 모두 되고, 폴더·다중 선택에는 안 붙는다.
// canAiCli = 원격 폴더 하나 선택(F27). 로컬 폴더에는 붙지 않는다 — 이 창은 "서버에 접속해서 시작"이다.
export function fileMenu(ctx: {
  count: number
  isDir: boolean
  canDownload: boolean
  canTail?: boolean
  canAiCli?: boolean
}): MenuItem[] {
  const ids: FileActionId[] = []
  if (ctx.count === 1) {
    if (ctx.isDir) {
      ids.push('file.open')
      if (ctx.canAiCli) ids.push('file.aicli')
    } else {
      ids.push('file.edit')
      if (ctx.canDownload) ids.push('file.download')
    }
    if (!ctx.isDir && ctx.canTail) ids.push('file.tail')
    ids.push('file.rename')
  } else if (ctx.count > 1 && ctx.canDownload) {
    ids.push('file.download')
  }
  ids.push('file.mkdir')
  // 지금 보고 있는 폴더를 작업 프로필로 — 선택 여부와 무관하다(대상은 "이 폴더"다).
  ids.push('file.saveWork')
  if (ctx.count > 0) ids.push('file.delete')
  return ids.map((id) => ({ id, label: t('conn.menu.' + id), ...(id === 'file.delete' ? { danger: true } : {}) }))
}

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
  // F17: 단축키 없는 진입점(패널 상단 버튼이 또 하나 있다 — AiPanel.onOpenBootstrap).
  | 'ai.bootstrap'

export type MenuEntry = { action: KeymapAction } | { command: MenuCommandId }

export const MENUBAR: readonly { title: string; items: readonly MenuEntry[] }[] = [
  {
    // 설정은 R5 에서 단축키(Ctrl+,)가 생겨 command → action 으로 옮겼다. 메뉴에 힌트가 붙고
    // 실행 경로도 keydown 핸들러 하나로 합쳐진다("메뉴에서만 되는 기능" 금지).
    title: 'File',
    items: [
      { action: 'session.new' },
      { action: 'settings.open' },
      { command: 'ai.bootstrap' },
      { command: 'app.quit' }
    ]
  },
  {
    title: 'Edit',
    items: [{ action: 'clipboard.copy' }, { action: 'clipboard.paste' }, { action: 'terminal.search' }]
  },
  {
    // 첫 항목은 계속 연결 관리자다(R3 까지 Session 클릭 = 연결 관리자였다 — 그 손버릇을 깨지 않는다).
    title: 'Session',
    items: [
      { action: 'connection.manager' },
      { action: 'session.duplicate' },
      { action: 'tab.next' },
      { action: 'tab.prev' },
      { action: 'terminal.toggle' }
    ]
  },
  {
    title: 'Split',
    items: [
      { action: 'split.horizontal' },
      { action: 'split.vertical' },
      { action: 'pane.maximize' },
      { action: 'pane.close' }
    ]
  },
  {
    title: 'View',
    items: [
      { action: 'sidebar.collapse' },
      { action: 'fileTree.toggle' },
      { action: 'explorer.toggle' },
      { action: 'preview.toggle' },
      { action: 'ai.toggle' },
      { command: 'font.zoomIn' },
      { command: 'font.zoomOut' }
    ]
  },
  {
    title: 'Help',
    // 치트시트를 설정처럼 command → action 으로 옮기려다 되돌렸다(2026-08-13, 스모크가 잡았다).
    // `?` 는 **입력 중에는 일부러 안 먹는 키**다(KEY-2). 메뉴 항목을 dispatchAction 으로 돌리면
    // 터미널에 포커스가 있는 보통 상황에서 눌러도 아무 일이 안 일어난다 — 그래서 command 로 둔다.
    // 통합 검색의 중복(치트시트가 두 줄)은 store/palette.ts 의 COMMAND_DUPES 로 걸러 낸다.
    items: [
      { command: 'help.cheatsheet' },
      { action: 'commandBook.toggle' },
      { command: 'help.about' }
    ]
  }
] as const

// 되돌리기 어려운 항목만 위험 톤(터미널 메뉴·트리 메뉴와 같은 규칙).
const MENU_DANGER: ReadonlySet<string> = new Set(['app.quit', 'pane.close'])

// 최상위 메뉴 인덱스 → ContextMenu 항목. keymap 항목은 라벨·힌트를 KEYMAP 에서, 명령 항목은 i18n 에서.
export function menuBarItems(index: number): MenuItem[] {
  const menu = MENUBAR[index]
  if (!menu) return []
  return menu.items.map((e) => {
    const id = 'action' in e ? e.action : e.command
    const hint = 'action' in e ? comboOf(e.action) : undefined
    const label =
      'action' in e ? (KEYMAP.find((k) => k.action === e.action)?.labelKo ?? e.action) : t('menu.' + e.command)
    return {
      id,
      label,
      ...(hint ? { hint } : {}),
      ...(MENU_DANGER.has(id) ? { danger: true } : {})
    }
  })
}
