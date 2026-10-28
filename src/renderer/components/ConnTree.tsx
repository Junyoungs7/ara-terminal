import { useRef, useState } from 'react'
import { ChevronDown, MoreHorizontal, Star } from 'lucide-react'
import { useRowKeys } from '../store/rowKeys'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import { connDotClass, type ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { ContextMenu, type MenuItem } from '../interactions/ContextMenu'
import { treeMenu, tmuxMenuItem, type TreeActionId, type TreeMenuKind } from '../interactions/actions'
import {
  applyGroupDrop,
  dropZone,
  groupDropVerdict,
  groupTree,
  matchProfile,
  parentGroupOf,
  type DropPlace,
  type GroupLayout
} from '../store/groups'
import { t } from '../i18n'
import { IconClose } from './icons'
import type { TmuxListResult } from '../../shared/tmuxList'

// 사이드바 연결 트리 — 목업 S1(순수 트리). 2026-08-08 재설계.
//
// 카드를 버렸다. VS Code Remote Explorer · WindTerm · Tabby(SSH Sidebar) 를 훑어보니 전부
// "테두리 없는 한 줄 행 + 상태 점 하나"였고, 카드는 서버가 늘수록 세로를 먹는 것 말고 하는 일이 없었다.
// 계층은 들여쓰기로만 준다: 그룹 → 서버 → 세션.
//
// 바꾼 세 가지(준영님 지적):
//  · **타입**: 제각각이던 이모지·글리프 대신 SSH/RDP/SYS **글자 배지** 하나로 통일했다.
//  · **세션 표기**: 계정@호스트를 뺐다 — 서버 행에 이미 있어 중복이었고 이름과 겹쳐 읽혔다.
//    남은 것은 번호 + 지금 폴더. 같은 서버의 세션을 실제로 가르는 정보가 그것뿐이다.
//  · **호스트**: 행에서 빼고 툴팁으로 내렸다(목록에서 매번 필요한 값이 아니다).
//
// #193(2026-09-08) 두 가지가 붙었다:
//  · **2단 중첩** — 그룹 안에 그룹 하나까지(상한 2단, 재귀 아님). 부모 관계는 그룹 **이름이 아니라**
//    ui.groupParents 에 따로 산다(store/groups.ts 머리주석에 왜인지 적혀 있다).
//  · **드래그** — 서버를 그룹 머리글에 놓으면 그 그룹으로, 그룹을 머리글 가운데에 놓으면 그 안으로,
//    위/아래 가장자리에 놓으면 순서 바꾸기. 세션 행은 끌 수 없다(탭·패널 규약과 겹친다).
//
// 서버 노드 원클릭 = 선택(열린 세션이 있으면 그 세션으로 전환) / 더블클릭 = 새 세션 접속.
// 원클릭이 접속이던 시절엔 더블클릭 한 번에 click·click·dblclick 이 모두 접속을 태워 세션이 3개 열렸다(R1.3).
// 세션 행 클릭 = 해당 세션 활성화(탭/패널 동기).
// 우클릭 = 컴팩트 컨텍스트 메뉴(서버/세션/그룹/로컬/빈 영역) — 액션은 onTreeAction 으로 상위에 위임.

// 우클릭 대상. 액션 실행에 필요한 식별자만 담는다.
export type TreeTarget =
  | { kind: 'server'; profileId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'group'; group: string }
  | { kind: 'local' }
  // 2026-08-17 제보 ①: 즐겨찾기 행. 사이드바 트리와 작업대 창이 **같은 목록**을 그리므로
  // 대상 표현도 하나만 둔다(작업대 쪽도 이 타입으로 상위에 올린다).
  | { kind: 'work'; workId: string }

type Props = {
  profiles: ConnectionProfile[]
  // R6: 표시할 그룹 순서(이름순 + "기타" 마지막). 프로필이 없는 빈 그룹도 들어 있다 —
  // 트리가 프로필에서 다시 파생하면 방금 만든 빈 그룹이 사라진다.
  groups: string[]
  conn: ConnState
  sessions: Session[]
  activeSessionId: string | null
  // 새 세션 접속(서버 노드 더블클릭 / 메뉴).
  onConnect: (profileId: string) => void
  onSelectSession: (sessionId: string) => void
  onTreeAction: (id: TreeActionId, target: TreeTarget) => void
  /** 세션별 현재 작업 위치(세션 카드 2번째 정보). 같은 서버에 세션이 여럿이면 이름만으론 구분이 안 된다. */
  cwdBy?: Record<string, string>
  /** 세션 카드의 ✕ — 탭 ×와 같은 경로(세션 종료). */
  onCloseSession?: (sessionId: string) => void
  /** 첫 실행 빈 상태의 [새 연결] — 머리의 ＋ 와 같은 동작(다듬기 R1, 리뷰 B10: 누를 수 없는 문구였다). */
  onNewConn?: () => void
  // FB-monitor(F19 tmux 후속): 서버/세션 우클릭 시 tmux 서브메뉴에 띄울 세션 목록 1회 조회.
  onTmuxQuery: (sessionId: string) => Promise<TmuxListResult>
  /** 작업 프로필(서버+폴더). 트리 최상단 [즐겨찾기] 그룹으로 올린다 — Ctrl+P 팝업에만 있으면 잊힌다. */
  workProfiles?: WorkProfile[]
  onOpenWork?: (w: WorkProfile) => void
  /** #193 그룹 배치(끌어다 정한 순서 · 2단 중첩). 없으면 지금까지처럼 평평한 가나다순. */
  groupLayout?: GroupLayout
  /** #193 서버를 다른 그룹에 놓았다. undefined = 그룹에서 뺀다("기타"로 내려간다). */
  onMoveProfile?: (profileId: string, group: string | undefined) => void
  /** #193 그룹을 끌어 순서·중첩이 바뀌었다. 새 배치를 통째로 준다(저장은 상위가 한다). */
  onGroupLayout?: (next: GroupLayout) => void
  /** 못 놓는 자리에 놓았을 때 이유를 띄울 자리(메인 영역 토스트). 없으면 조용히 무시된다. */
  onNotice?: (msg: string) => void
  /** #13 접어 둔 노드(true 만). 주인은 Shell 의 useSidebar — 재시작 후에도 남는다. */
  connCollapsed?: Record<string, true>
  onConnCollapsed?: (next: Record<string, true>) => void
}

// #193 끌고 있는 것. **세션은 여기 없다** — 세션을 옮기는 규약은 탭·패널 쪽에 이미 있고
// (win:detach · PaneGrid 의 splitDrop) 트리에서까지 끌리면 같은 몸짓이 두 가지를 뜻하게 된다.
type Dragging = { kind: 'server'; id: string } | { kind: 'group'; name: string }

/**
 * 드래그 페이로드의 MIME. **`text/plain` 을 쓰면 안 된다** — 탭바와 PaneGrid 가 `text/plain` 을
 * "세션 id" 로 읽어(TermTabbar.tsx:213 · PaneGrid.tsx:109) 서버 행을 터미널 위에 놓는 순간
 * 엉뚱한 세션 이동으로 해석된다. 값 자체는 쓰지 않는다(끌고 있는 것은 React state 가 안다) —
 * dragover 중에는 dataTransfer 의 **값**을 못 읽는 것이 규약이라 어차피 state 가 필요하다.
 */
const DND_MIME = 'application/x-ara-tree'

// 상태 dot — 판정은 store/profiles.ts 의 connDotClass 하나가 한다(연결 관리자와 공유).
const stDot = (state: ConnState[string] | undefined): string => 'st ' + connDotClass(state)

// FB-monitor(F19 tmux 후속): 메뉴 종류 + tmux 조회 상태 → 실제로 그릴 항목. tmuxSessionId 가
// 없으면(로컬·RDP·연결 안 된 서버) tmux 항목 자체가 안 붙는다 — sudo 상승 없이 조회 가능한 대상만.
function menuItems(
  menu: { kind: TreeMenuKind; tmuxSessionId?: string } | null,
  tmux: { sessionId: string; result: TmuxListResult | 'loading' } | null
): MenuItem[] {
  if (!menu) return []
  const base = treeMenu(menu.kind)
  if (!menu.tmuxSessionId) return base
  const query = tmux && tmux.sessionId === menu.tmuxSessionId ? tmux.result : 'loading'
  return [...base, tmuxMenuItem(query)]
}

/**
 * 타입 → 배지. 'local' 만 SYS 이고 나머지는 SSH 로 떨어뜨린다 — 구버전 스냅샷의 프로필에는
 * type 필드가 아예 없을 수 있고(v3→v4 마이그레이션 이전에 저장된 것), 그때 SYS 로 보이면
 * 원격 서버가 로컬처럼 읽힌다. 연결 프로필은 ssh 아니면 rdp 뿐이라 이 폴백이 안전하다.
 */
export function typeBadge(type: string | undefined): { cls: string; label: string } {
  if (type === 'rdp') return { cls: 'rdp', label: 'RDP' }
  if (type === 'local') return { cls: 'sys', label: 'SYS' }
  return { cls: 'ssh', label: 'SSH' }
}

// 세션 행 — 서버 행보다 한 단 들여쓴 한 줄. 부모가 서버면 타입 배지를 달지 않는다(서버 행이 이미 말했다).
// 로컬 그룹 아래 세션은 부모 서버 행이 없어 스스로 SYS 를 달아야 한다.
/**
 * 세션 행 맨 앞은 **타입 배지**(SSH·RDP·SYS)다. 2026-08-14 준영님 제안으로 `>_` 아이콘을 대체했다.
 *
 * 아이콘이 하던 일이 없었다: 모든 셸 세션이 같은 프롬프트 기호였고(rdp 만 모니터), 정작 타입은
 * 행 **끝**의 배지가 따로 말하고 있었다. 같은 것을 두 자리에서 말하면서 앞자리는 아무 말도
 * 안 하는 꼴이었다. 배지를 앞으로 옮기면 한 요소가 사라지고 그 자리가 정보가 된다.
 *
 * 서버 아래 세션은 배지가 부모와 겹친다(그 서버가 이미 SSH 다). 그래도 다는 이유는 **줄이 맞아야
 * 읽히기** 때문이다 — 앞자리를 비우면 cwd 가 들쭉날쭉해진다. 겹치는 정보라도 자리를 지키는 편이 낫다.
 */
function SessRow({
  s,
  active,
  cwd,
  standalone,
  onSelect,
  onClose,
  onCtx
}: {
  s: Session
  active: boolean
  cwd?: string
  /** 부모 서버 행 없이 그룹 아래 바로 붙는 세션(로컬) — 타입 배지를 스스로 단다. */
  standalone?: boolean
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onCtx: (e: React.MouseEvent, kind: TreeMenuKind, target: TreeTarget, tmuxSessionId?: string) => void
}) {
  const badge = typeBadge(s.type)
  return (
    <div
      className={'sess-node' + (active ? ' active' : '')}
      role="treeitem"
      tabIndex={-1}
      aria-selected={active}
      onClick={() => onSelect(s.id)}
      // FB-monitor(F19 tmux 후속): SSH 세션에만 tmux 서브메뉴가 붙는다(로컬·AI·로그엔 원격 셸이 없다).
      onContextMenu={(e) => onCtx(e, 'session', { kind: 'session', sessionId: s.id }, s.type === 'ssh' ? s.id : undefined)}
      // 이름(main 이 정한 탭 제목)은 행에 안 싣지만 툴팁으로는 남긴다 — 사용자가 rename 한 값일 수 있다.
      title={cwd ? `${s.title} · ${cwd}` : s.title}
    >
      <span className={'sess-type ' + badge.cls}>{badge.label}</span>
      {/* 부모 서버 행이 있으면 이름은 생략하고 경로만 — 이름(서버명·N)은 부모가 이미 말했다.
          로컬은 부모 행이 없어 셸 이름(PowerShell/cmd)을 스스로 달아야 어느 셸인지 알 수 있다.
          경로를 아직 못 받았으면 어느 쪽이든 이름으로 버틴다(빈 줄을 보여 주지 않는다). */}
      {(standalone || !cwd) && <span className="sess-name">{s.title}</span>}
      {cwd && <span className="sess-cwd">{cwd}</span>}
      {onClose && (
        <span className="rowact">
          <span
            className="cc-b danger"
            title={t('tab.close')}
            onClick={(e) => {
              e.stopPropagation()
              onClose(s.id)
            }}
          >
            <IconClose />
          </span>
        </span>
      )}
    </div>
  )
}

const LOCAL_KEY = 'localhost'

export function ConnTree({
  profiles,
  groups,
  conn,
  sessions,
  activeSessionId,
  onConnect,
  onSelectSession,
  onTreeAction,
  onTmuxQuery,
  cwdBy,
  onCloseSession,
  onNewConn,
  workProfiles,
  onOpenWork,
  groupLayout,
  onMoveProfile,
  onGroupLayout,
  onNotice,
  connCollapsed,
  onConnCollapsed
}: Props) {
  // #82: 트리 키보드 조작(↑↓ 이동 · →← 펼침 · Enter 실행). 접힘 상태의 주인은 이 컴포넌트라
  // 훅은 트위스티를 눌러 토글만 일으킨다.
  const treeRef = useRef<HTMLDivElement>(null)
  const treeKeys = useRowKeys(treeRef, { selector: '[role="treeitem"]', twisty: '.tw, .caret' })
  // #13(2026-10-08 오류 신고): 접힘을 **저장한다**(ui.sidebar.connCollapsed). #193 때는 유령 키가
  // 싫어 안 했지만, 재시작마다 다 펼쳐지는 쪽이 신고로 왔다. 유령 키(지운·바꾼 그룹 이름)는 걷지
  // 않는다 — 접힌 것만(true) 담고 CONN_COLLAPSED_MAX 로 상한을 둬 무한히 자라지 않게 한 것으로 끝.
  // 검색은 접힘을 건드리지 않는다(일시 펼침 없음) — 그래서 저장되는 것은 손으로 접고 편 것뿐이다.
  const collapsed: Record<string, boolean> = connCollapsed ?? {}
  const setCollapsed = (fn: (c: Record<string, boolean>) => Record<string, boolean>): void => {
    const next: Record<string, true> = {}
    for (const [k, v] of Object.entries(fn(collapsed))) if (v) next[k] = true
    onConnCollapsed?.(next)
  }
  const [menu, setMenu] = useState<
    { x: number; y: number; kind: TreeMenuKind; target: TreeTarget; tmuxSessionId?: string } | null
  >(null)
  // FB-monitor(F19 tmux 후속): 메뉴가 열릴 때 딱 한 번 조회한 세션 목록(폴링 아님).
  const [tmux, setTmux] = useState<{ sessionId: string; result: TmuxListResult | 'loading' } | null>(null)
  // 서버 행에는 **선택 색이 없다**(2026-09-08 준영님 확정). 옛 판에는 둘이 있었다: 접속하면
  // activeProfileId 를 따라 켜지는 색과, 원클릭으로 켜지는 색. 둘 다 걷었다 —
  // *"사용자는 서버를 접속하기위해 클릭할뿐이니까 더블클릭만 할거고 원클릭은 굳이 필요 없다.
  //   상태dot은 남겨줘."* 서버 행은 **진입점**이고, 연결 여부는 상태 점(connDotClass)이 말한다.
  //
  // ⚠️ 색을 되살리려는 사람에게 — 키보드로 트리를 훑을 때 지금 어디인지는 이미 보인다.
  // rowKeys 가 roving tabindex 로 **DOM 초점**을 옮기고(store/rowKeys.ts:89 `el.focus()`),
  // shell.css:21 의 전역 `:focus-visible` 이 그 자리에 테를 두른다. 마우스로 누를 때는 안 뜨므로
  // "클릭했더니 색이 남는" 일도 없다. 선택 상태를 다시 만들 이유가 아니다.
  // R6 트리 검색어. 서버가 수십 개가 되면 스크롤보다 타이핑이 빠르다.
  const [query, setQuery] = useState('')
  // #193 드래그. 끌고 있는 것과 지금 겨누고 있는 자리를 state 로 든다 — dragover 중에는
  // dataTransfer 의 값을 못 읽는 규약이라(타입 목록만 보인다) 놓을 자리를 **미리 그리려면** 필요하다.
  const [drag, setDrag] = useState<Dragging | null>(null)
  const [over, setOver] = useState<{ group: string; place: DropPlace; bad?: 'depth' | 'none' } | null>(null)
  const endDrag = (): void => {
    setDrag(null)
    setOver(null)
  }

  // tmuxSessionId 가 있으면(=우클릭 대상이 SSH 세션과 연결됨) tmux 서브메뉴용 목록을 즉시 조회한다.
  const openCtx = (e: React.MouseEvent, kind: TreeMenuKind, target: TreeTarget, tmuxSessionId?: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, kind, target, tmuxSessionId })
    if (!tmuxSessionId) {
      setTmux(null)
      return
    }
    setTmux({ sessionId: tmuxSessionId, result: 'loading' })
    const settle = (result: TmuxListResult): void =>
      setTmux((cur) => (cur?.sessionId === tmuxSessionId ? { sessionId: tmuxSessionId, result } : cur))
    // IPC 가 없거나 실패해도(끊긴 세션 등) 서브메뉴는 "확인할 수 없음" 안내로 닫히지, 무한 로딩으로
    // 남거나 처리 안 된 rejection 을 남기지 않는다.
    void onTmuxQuery(tmuxSessionId)
      .then(settle)
      .catch(() => settle({ status: 'error', sessions: [] }))
  }

  // serverKey(=프로필명 / localhost) → 세션 목록.
  const byServer = new Map<string, Session[]>()
  for (const s of sessions) {
    if (!byServer.has(s.serverKey)) byServer.set(s.serverKey, [])
    byServer.get(s.serverKey)!.push(s)
  }
  const localSessions = byServer.get(LOCAL_KEY) ?? []

  // 그룹별 묶기. 그룹 미지정 프로필은 "기타"로 모은다.
  // 검색 중에는 걸린 프로필이 없는 그룹을 숨긴다 — 필터 결과가 빈 헤더 목록으로 보이지 않게.
  const none = t('conn.group.none')
  const layout = groupLayout ?? {}
  // #193: 검색은 **부모 그룹 이름으로도** 걸린다. 자식 그룹에 들어간 서버도 사용자 머릿속에서는
  // 여전히 "운영 안"이라, 부모 이름을 쳤는데 안 나오면 검색이 거짓말을 한다.
  const visible = profiles.filter((p) =>
    matchProfile(p, query, p.group ? parentGroupOf(p.group, groups, layout.parents) : undefined)
  )
  const byGroup = new Map<string, ConnectionProfile[]>()
  for (const g of groups) byGroup.set(g, [])
  for (const p of visible) {
    const g = p.group || none
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(p)
  }
  const searching = query.trim().length > 0
  const listOf = (g: string): ConnectionProfile[] => byGroup.get(g) ?? []
  // 2단 트리. 이름 목록은 화면에 그릴 것 그대로다 — 저장된 부모 관계에 **지금 없는 이름**이 있으면
  // groupTree 가 무시하고 그 그룹을 최상위로 올린다(옛 앱이 지운 그룹의 흔적).
  const nodes = groupTree([...byGroup.keys()], layout).flatMap((n) => {
    // 검색 중 자식은 걸린 것만 남기고, 부모는 자기 것이 없어도 **걸린 자식이 있으면 남는다**
    // (안 그러면 자식이 부모와 함께 사라져 검색 결과가 거짓이 된다).
    const children = searching ? n.children.filter((c) => listOf(c).length > 0) : n.children
    if (searching && listOf(n.name).length === 0 && children.length === 0) return []
    return [{ name: n.name, children }]
  })

  // ── #193 드래그 ────────────────────────────────────────────────────────────
  // 우클릭 메뉴는 그대로 둔다. 드래그는 **더하는 길**이지 대체가 아니다 — 키보드로만 쓰는 사람에게서
  // 그룹 옮기기를 빼앗으면 안 된다(↑↓ 버튼을 안 만든 것과 같은 이유의 반대편).
  const groupNames = [...byGroup.keys()]

  /** 이 머리글 위에서 지금 무엇을 할 수 있나. null 이면 놓을 자리가 아니다(표시도 안 한다). */
  const aimFor = (e: React.DragEvent, group: string): { place: DropPlace; bad?: 'depth' | 'none' } | null => {
    if (!drag) return null
    if (drag.kind === 'server') {
      // 이미 그 그룹이면 놓을 것이 없다 — 표시를 띄우면 "되는데 아무 일도 안 나는" 자리가 된다.
      const cur = profiles.find((x) => x.id === drag.id)?.group || none
      return cur === group ? null : { place: 'into' }
    }
    const r = e.currentTarget.getBoundingClientRect()
    const place = dropZone(e.clientY - r.top, r.height)
    const v = groupDropVerdict(drag.name, group, place, groupNames, layout)
    if (v.ok) return { place }
    // 자기 자신 위는 잘못이 아니라 그냥 제자리다 — 빨갛게 칠하고 이유를 띄울 일이 아니다.
    if (v.reason === 'self') return null
    return { place, bad: v.reason }
  }

  const dragProps = (group: string): React.HTMLAttributes<HTMLDivElement> => ({
    // "기타"는 그룹이 아니라 그룹 미지정 프로필이 모이는 자리다 — 끌 수도, 안에 넣을 수도 없다.
    draggable: group !== none,
    onDragStart: (e) => {
      setDrag({ kind: 'group', name: group })
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(DND_MIME, group)
    },
    onDragEnd: endDrag,
    onDragOver: (e) => {
      const aim = aimFor(e, group)
      if (!aim) return // preventDefault 를 안 하면 커서가 "못 놓음"으로 바뀐다(main.tsx 전역 가드)
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver({ group, ...aim })
    },
    onDragLeave: (e) => {
      // 자식 span 으로 들어갈 때도 dragleave 가 온다 — 그때 지우면 표시가 깜빡인다.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setOver((o) => (o?.group === group ? null : o))
    },
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      const aim = aimFor(e, group)
      const what = drag
      endDrag()
      if (!aim || !what) return
      // 상한을 넘겼다 → 거부하고 **이유를 말한다.** 아무 일도 안 일어나면 사용자는 자기 손이
      // 빗나간 줄 안다.
      if (aim.bad) {
        onNotice?.(t('conn.group.drop.' + aim.bad))
        return
      }
      // 접힌 그룹 안에 놓았으면 펴 준다 — 안 그러면 방금 놓은 것이 **사라진 것처럼 보인다**
      // (지운 줄 알고 다시 만드는 것이 그다음이다).
      if (aim.place === 'into') setCollapsed((c) => ({ ...c, [group]: false }))
      if (what.kind === 'server') onMoveProfile?.(what.id, group === none ? undefined : group)
      else onGroupLayout?.(applyGroupDrop(what.name, group, aim.place, groupNames, layout))
    }
  })

  /** 그룹 머리글 한 줄. sub = 부모 안에 든 2단 그룹(들여쓰기는 CSS `.srv-group.sub` 가 낸다). */
  const groupHead = (group: string, count: number, sub: boolean): JSX.Element => {
    const isCollapsed = collapsed[group]
    // 놓을 자리를 **눈에 보이게** 한다. 어디에 떨어지는지 모르는 드래그는 공포다.
    const aim = over?.group === group ? over : null
    return (
      <div
        className={'srv-hd' + (sub ? ' sub' : '') + (aim ? (aim.bad ? ' dz-bad' : ' dz-' + aim.place) : '')}
        role="treeitem"
        tabIndex={-1}
        aria-expanded={!isCollapsed}
        onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
        onContextMenu={(e) => openCtx(e, group === none ? 'groupNone' : 'group', { kind: 'group', group })}
        {...dragProps(group)}
      >
        {/* 접히면 CSS 가 -90° 로 돌린다 — 글리프 둘을 갈아 끼우지 않는다(shell.css `.caret`). */}
        <span className={'caret' + (isCollapsed ? ' closed' : '')}>
          <ChevronDown />
        </span>
        {group} <span className="g-count">{count}</span>
      </div>
    )
  }

  /** 서버 한 줄 + 그 아래 열린 세션들. 최상위 그룹과 자식 그룹이 **같은 함수**를 쓴다. */
  const serverRow = (p: ConnectionProfile): JSX.Element => {
    // RDP 는 서버당 세션이 하나뿐이다(두 번째로 붙으면 기존 세션이 끊긴다) — SSH 처럼
    // 자식 세션 목록으로 펼치지 않고 서버 카드에 "연결됨" 하나로만 표시한다.
    const rdpSession = p.type === 'rdp' ? sessions.find((x) => x.profileId === p.id) : undefined
    // 이 서버에서 열린 세션 — 서버 카드 **아래 자식 카드**로 붙는다(준영님 확정: 기존 계층 유지).
    const sess = p.type === 'rdp' ? [] : (byServer.get(p.name) ?? [])
    const nodeCollapsed = collapsed['node:' + p.id]
    const live = Boolean(rdpSession) || sess.length > 0
    const badge = typeBadge(p.type)
    const card = (
      <div
        // 서버 행에는 `.active` 가 붙지 않는다 — 색으로 말할 상태가 없다(위 선언부 주석).
        // 연결 여부는 왼쪽 상태 점, 키보드 위치는 전역 `:focus-visible` 이 맡는다.
        className={'srv-node' + (live ? '' : ' off')}
        role="treeitem"
        tabIndex={-1}
        // #193: 서버는 끌어서 그룹을 옮길 수 있다. 놓는 자리는 그룹 머리글뿐이다(dragProps).
        draggable
        onDragStart={(e) => {
          setDrag({ kind: 'server', id: p.id })
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(DND_MIME, p.id)
        }}
        onDragEnd={endDrag}
        // 세션이 없는 서버는 펼칠 것이 없다 — aria-expanded 를 아예 안 준다(→/← 무시).
        {...(sess.length > 0 ? { 'aria-expanded': !nodeCollapsed } : {})}
        // `aria-selected` 도 뺐다 — 고를 수 없는 것에 "안 골랐음"을 매 행 읽어 주면 소음이다.
        // 세션 행은 그대로 둔다(그쪽은 지금 보고 있는 세션이라는 **진짜 선택**이 있다).
        // 호스트는 행에서 뺐다 — 목록에서 매번 필요한 값이 아니라 툴팁으로 내린다.
        title={`${p.username ? p.username + '@' : ''}${p.host} · ${t('conn.tree.connect')}`}
        onClick={(e) => {
          // 더블클릭의 두 번째 click 은 흘려보낸다(접속은 onDoubleClick 한 번만).
          if (e.detail > 1) return
          // 선택 상태는 없어졌지만 **이 클릭은 남긴다** — 열린 세션이 있으면 그리로 전환하는
          // 길이다(색이 아니라 이동). 세션이 없으면 아무 일도 안 한다: 접속은 더블클릭이다.
          const focus = rdpSession ?? sess[0]
          if (focus) onSelectSession(focus.id)
        }}
        onDoubleClick={() => onConnect(p.id)}
        onContextMenu={(e) =>
          openCtx(
            e,
            p.type === 'rdp' ? 'serverRdp' : 'server',
            { kind: 'server', profileId: p.id },
            sess.find((x) => x.type === 'ssh')?.id
          )
        }
      >
        {/* 트위스티 자리는 세션이 없어도 비워 둔다 — 안 그러면 서버마다 이름 시작점이 어긋난다. */}
        {sess.length > 0 ? (
          <span
            className={'tw on' + (nodeCollapsed ? ' closed' : '')}
            title={nodeCollapsed ? t('conn.tree.expand') : t('conn.tree.collapse')}
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((c) => ({ ...c, ['node:' + p.id]: !c['node:' + p.id] }))
            }}
          >
            {/* <button> 으로 안 만든다 — 부모 `.srv-node` 가 `role="treeitem"` 이라 중첩이 된다(M3 §4.1). */}
            <ChevronDown />
          </span>
        ) : (
          <span className="tw" />
        )}
        <span className={live ? 'st on' : stDot(conn[p.id])} />
        <span className={'tbadge ' + badge.cls}>{badge.label}</span>
        <span className="sname">{p.name}</span>
        {/* 호버 인라인 버튼 — 우클릭 메뉴를 몰라도 손이 닿아야 한다(VS Code 트리 규칙).
            2026-08-17 준영님 제보 ②: 여기 있던 [▸ 접속]을 뺐다. 접속하는 길이 이미
            셋이고(더블클릭 · ⋯ 메뉴 · 즐겨찾기) 이 자리는 **바로 왼쪽 트위스티(▾)와
            모양이 닮아** 펼치려다 새 세션을 여는 자리였다. 남기는 것은 ⋯ 하나. */}
        <span className="rowact">
          <span
            className="cc-b"
            title={t('conn.tree.more')}
            onClick={(e) => openCtx(e, p.type === 'rdp' ? 'serverRdp' : 'server', { kind: 'server', profileId: p.id })}
          >
            {/* 크기는 `.rowact .cc-b svg`(11px)가 정한다 — 세션 행의 [닫기]와 같은 규칙. */}
            <MoreHorizontal />
          </span>
        </span>
      </div>
    )
    // 세션은 서버 행 아래 한 단 들여쓴 형제 행으로 붙는다.
    return (
      <div className="srv-group" data-server={p.name} key={p.id}>
        {card}
        {sess.length > 0 && !nodeCollapsed && (
          <div className="sess-list">
            {sess.map((x) => (
              <SessRow
                key={x.id}
                s={x}
                active={x.id === activeSessionId}
                cwd={cwdBy?.[x.id]}
                onSelect={onSelectSession}
                onClose={onCloseSession}
                onCtx={openCtx}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    // 빈 영역 우클릭 = 새 로컬 셸 / 새 연결 / 새 그룹. 자식 행들은 openCtx 가 전파를 끊는다.
    <>
      <div className="sb-search">
        <div className="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder={t('conn.search.placeholder')}
            aria-label={t('conn.search.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
            // 검색 중에는 전역 단축키(? 치트시트 등)로 새어 나가면 안 된다.
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <span className="sclear" title={t('conn.search.clear')} onClick={() => setQuery('')}>
              <IconClose />
            </span>
          )}
        </div>
      </div>
      {/* #82: 키보드로도 훑을 수 있는 트리. 행마다 핸들러를 달지 않고 **컨테이너가 위임**받는다
          (store/rowKeys.ts). Tab 정거장은 이 컨테이너 하나 — 행마다 서면 서버 20개짜리 트리에서
          Tab 을 20번 눌러야 다음 영역으로 간다. */}
      <div
        className="tree"
        ref={treeRef}
        role="tree"
        // 2026-08-28 감사 ①(c): `conn.tab.conn` 은 없는 키라 스크린리더가 접근성 이름 대신
        // 키 문자열을 읽었다. 사이드바 탭이 쓰는 이름과 같아야 할 자리라 그 키를 그대로 쓴다.
        aria-label={t('sidebar.tab.conn')}
        {...treeKeys}
        onContextMenu={(e) => openCtx(e, 'sidebar', { kind: 'local' })}
      >
      {profiles.length === 0 && (
        <div className="empty">
          {t('conn.tree.empty')}
          {onNewConn && (
            <button type="button" className="btn tree-empty-new" data-action="conn.new" onClick={onNewConn}>
              {t('sidebar.act.newConn')}
            </button>
          )}
        </div>
      )}
      {profiles.length > 0 && visible.length === 0 && <div className="empty">{t('conn.search.noMatch')}</div>}
      {/* 즐겨찾기(작업 프로필) — 서버+폴더를 한 번에 연다. 검색 중에는 감춘다(검색 대상은 서버다). */}
      {!searching && workProfiles && workProfiles.length > 0 && (
        <div className="srv-group" key="__fav">
          <div
            className="srv-hd"
            role="treeitem"
            tabIndex={-1}
            aria-expanded={!collapsed.__fav}
            onClick={() => setCollapsed((c) => ({ ...c, __fav: !c.__fav }))}
          >
            {/* 접히면 CSS 가 -90° 로 돌린다 — 글리프 둘을 갈아 끼우지 않는다(shell.css `.caret`). */}
            <span className={'caret' + (collapsed.__fav ? ' closed' : '')}>
              <ChevronDown />
            </span>
            {t('explorer.nav.favorites')} <span className="g-count">{workProfiles.length}</span>
          </div>
          {!collapsed.__fav &&
            workProfiles.map((w) => (
              <div
                key={w.id}
                className="fav-node"
                role="treeitem"
                tabIndex={-1}
                title={w.path}
                onClick={() => onOpenWork?.(w)}
                onContextMenu={(e) => openCtx(e, 'fav', { kind: 'work', workId: w.id })}
              >
                <span className="fav-i">
                  <Star />
                </span>
                <span className="fav-n">{w.name}</span>
                <span className="fav-p">{w.path}</span>
              </div>
            ))}
        </div>
      )}
      {/* 2단 트리 — 최상위 그룹 · 그 안의 서버 · 그 아래 자식 그룹. **상한이 2단이라 재귀가 없다**
          (준영님 확정). 늘리려는 사람에게: groupTree·canNest 의 상한 규칙부터 고쳐야 한다. */}
      {nodes.map((node) => {
        const own = listOf(node.name)
        // 부모의 개수에는 자식 그룹 것도 센다 — 접으면 그 서버들도 함께 숨으므로, 자기 것만 세면
        // 접힌 "운영 0" 밑에 서버 열두 대가 숨어 있는 꼴이 된다.
        const count = own.length + node.children.reduce((n, c) => n + listOf(c).length, 0)
        return (
          <div className="srv-group" key={node.name}>
            {groupHead(node.name, count, false)}
            {!collapsed[node.name] && (
              <>
                {own.map((p) => serverRow(p))}
                {node.children.map((child) => (
                  <div className="srv-group sub" key={child}>
                    {groupHead(child, listOf(child).length, true)}
                    {!collapsed[child] && listOf(child).map((p) => serverRow(p))}
                  </div>
                ))}
              </>
            )}
          </div>
        )
      })}

      {/* 로컬 그룹 — **세션이 있을 때만** 나온다(준영님 2026-08-13: "아무것도 등록 안 했는데 로컬
          그룹이 보인다, 제거해줘"). 그전에는 로컬 셸을 여는 자리로 상시 띄웠는데, 아무것도 없는
          첫 화면에 "로컬 0" 한 줄만 떠 있으니 등록할 것이 있다는 안내가 그 아래로 밀렸다.
          로컬 셸을 여는 길은 그대로 셋 남는다 — 탭바 ＋ · Ctrl+Shift+T · 트리 빈 곳 우클릭. */}
      {!searching && localSessions.length > 0 && (
      <div className="srv-group" key="__local">
        <div
          className="srv-hd"
          onClick={() => setCollapsed((c) => ({ ...c, __local: !c.__local }))}
          onContextMenu={(e) => openCtx(e, 'local', { kind: 'local' })}
        >
          <span className={'caret' + (collapsed.__local ? ' closed' : '')}>
            <ChevronDown />
          </span>
          {t('conn.group.local')} <span className="g-count">{localSessions.length}</span>
        </div>
        {!collapsed.__local && (
          <div className="sess-list">
            {localSessions.map((s) => (
              <SessRow
                key={s.id}
                s={s}
                active={s.id === activeSessionId}
                cwd={cwdBy?.[s.id]}
                standalone
                onSelect={onSelectSession}
                onClose={onCloseSession}
                onCtx={openCtx}
              />
            ))}
          </div>
        )}
      </div>
      )}

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems(menu, tmux)}
        onPick={(id) => {
          const m = menu
          setMenu(null)
          if (!m) return
          // FB-monitor(F19 tmux 후속): 서버 노드에서 열었어도 실제 액션 대상은 그 서버의 SSH 세션이다.
          if (id.startsWith('session.tmux.') && m.tmuxSessionId) {
            onTreeAction(id as TreeActionId, { kind: 'session', sessionId: m.tmuxSessionId })
            return
          }
          onTreeAction(id as TreeActionId, m.target)
        }}
        onClose={() => setMenu(null)}
      />
      </div>
    </>
  )
}
