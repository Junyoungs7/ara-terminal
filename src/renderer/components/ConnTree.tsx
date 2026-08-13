import { useState } from 'react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { ContextMenu, type MenuItem } from '../interactions/ContextMenu'
import { treeMenu, tmuxMenuItem, type TreeActionId, type TreeMenuKind } from '../interactions/actions'
import { matchProfile } from '../store/groups'
import { t } from '../i18n'
import { IconClose } from './icons'
import { Monitor, Terminal } from 'lucide-react'
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

type Props = {
  profiles: ConnectionProfile[]
  // R6: 표시할 그룹 순서(이름순 + "기타" 마지막). 프로필이 없는 빈 그룹도 들어 있다 —
  // 트리가 프로필에서 다시 파생하면 방금 만든 빈 그룹이 사라진다.
  groups: string[]
  conn: ConnState
  activeProfileId: string | null
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
  // FB-monitor(F19 tmux 후속): 서버/세션 우클릭 시 tmux 서브메뉴에 띄울 세션 목록 1회 조회.
  onTmuxQuery: (sessionId: string) => Promise<TmuxListResult>
  /** 작업 프로필(서버+폴더). 트리 최상단 [즐겨찾기] 그룹으로 올린다 — Ctrl+P 팝업에만 있으면 잊힌다. */
  workProfiles?: WorkProfile[]
  onOpenWork?: (w: WorkProfile) => void
}

// 상태 dot 클래스(연결됨=on, 연결 중/오류=warn, 미연결=off).
function stDot(state: ConnState[string] | undefined): string {
  if (state === 'connected') return 'st on'
  if (state === 'error' || state === 'connecting') return 'st warn'
  return 'st off'
}

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
 * 세션 종류 → 아이콘. Lucide(ISC) 를 쓴다 — 손으로 그리던 icons.tsx 와 같은 규격(24×24, stroke 2,
 * round cap)이라 나란히 놓아도 이질감이 없다.
 *
 * 프로토콜 로고를 쓰지 않은 이유: 찾아봤지만 **없다**. Iconify 로 200여 세트를 훑어도 ssh 는
 * `mdi:ssh`(솔리드 계열이라 우리 선 아이콘과 안 맞는다) 하나뿐이고, rdp 검색 결과는 전부 암호화폐
 * 토큰(rdpx), ftp 는 안드로이드 앱 런처 아이콘(CC BY-SA)뿐이다. 그래서 **개념 아이콘**으로 간다 —
 * 프로토콜 이름은 서버 행의 SSH/RDP 배지가 이미 말하고 있다.
 */
const SESS_ICON: Record<string, typeof Terminal> = {
  ssh: Terminal,
  // 원격 화면은 셸이 아니다 — 프롬프트 기호를 달면 거짓말이 된다. 나머지는 전부 프롬프트 하나로 통일
  // (준영님 선택: 타입별로 다르게 하지 말 것 — 타입은 서버 행의 SSH/RDP/SYS 배지가 이미 말한다).
  rdp: Monitor,
  local: Terminal
}

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
  const SessIcon = SESS_ICON[s.type] ?? Terminal
  return (
    <div
      className={'sess-node' + (active ? ' active' : '')}
      onClick={() => onSelect(s.id)}
      // FB-monitor(F19 tmux 후속): SSH 세션에만 tmux 서브메뉴가 붙는다(로컬·AI·로그엔 원격 셸이 없다).
      onContextMenu={(e) => onCtx(e, 'session', { kind: 'session', sessionId: s.id }, s.type === 'ssh' ? s.id : undefined)}
      // 이름(main 이 정한 탭 제목)은 행에 안 싣지만 툴팁으로는 남긴다 — 사용자가 rename 한 값일 수 있다.
      title={cwd ? `${s.title} · ${cwd}` : s.title}
    >
      {/* 숫자(1·2·3)를 세션 아이콘으로 바꿨다(준영님 요청) — 몇 번째인지보다 어떤 세션인지가 쓸모 있다.
          순서는 위에서 아래로 이미 보이고, 번호는 어디서도 쓰이지 않았다(단축키는 탭 기준이다). */}
      {/* 크기는 CSS(--sb-icon)가 정한다 — lucide 의 size prop 은 px 를 박아 배율을 안 탄다. */}
      <SessIcon className="sicon" strokeWidth={2} aria-hidden />
      {/* 부모 서버 행이 있으면 이름은 생략하고 경로만 — 이름(서버명·N)은 부모가 이미 말했다.
          로컬은 부모 행이 없어 셸 이름(PowerShell/cmd)을 스스로 달아야 어느 셸인지 알 수 있다.
          경로를 아직 못 받았으면 어느 쪽이든 이름으로 버틴다(빈 줄을 보여 주지 않는다). */}
      {(standalone || !cwd) && <span className="sess-name">{s.title}</span>}
      {cwd && <span className="sess-cwd">{cwd}</span>}
      {standalone && <span className={'sess-type ' + badge.cls}>{badge.label}</span>}
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
  activeProfileId,
  sessions,
  activeSessionId,
  onConnect,
  onSelectSession,
  onTreeAction,
  onTmuxQuery,
  cwdBy,
  onCloseSession,
  workProfiles,
  onOpenWork
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<
    { x: number; y: number; kind: TreeMenuKind; target: TreeTarget; tmuxSessionId?: string } | null
  >(null)
  // FB-monitor(F19 tmux 후속): 메뉴가 열릴 때 딱 한 번 조회한 세션 목록(폴링 아님).
  const [tmux, setTmux] = useState<{ sessionId: string; result: TmuxListResult | 'loading' } | null>(null)
  // 원클릭 선택 상태(접속과 분리). 접속하면 activeProfileId 가 따라오므로 그때는 그 값으로 표시한다.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // R6 트리 검색어. 서버가 수십 개가 되면 스크롤보다 타이핑이 빠르다.
  const [query, setQuery] = useState('')

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

  // 그룹별 묶기. 순서는 상위(Shell)가 정한 groups 를 따르고, 그룹 미지정 프로필은 "기타"로 모은다.
  // 검색 중에는 걸린 프로필이 없는 그룹을 숨긴다 — 필터 결과가 빈 헤더 목록으로 보이지 않게.
  const none = t('conn.group.none')
  const visible = profiles.filter((p) => matchProfile(p, query))
  const byGroup = new Map<string, ConnectionProfile[]>()
  for (const g of groups) byGroup.set(g, [])
  for (const p of visible) {
    const g = p.group || none
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(p)
  }
  const searching = query.trim().length > 0
  const sortedGroups = [...byGroup.entries()].filter(([, list]) => !searching || list.length > 0)

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
      <div className="tree" onContextMenu={(e) => openCtx(e, 'sidebar', { kind: 'local' })}>
      {profiles.length === 0 && <div className="empty">{t('conn.tree.empty')}</div>}
      {profiles.length > 0 && visible.length === 0 && <div className="empty">{t('conn.search.noMatch')}</div>}
      {/* 즐겨찾기(작업 프로필) — 서버+폴더를 한 번에 연다. 검색 중에는 감춘다(검색 대상은 서버다). */}
      {!searching && workProfiles && workProfiles.length > 0 && (
        <div className="srv-group" key="__fav">
          <div className="srv-hd" onClick={() => setCollapsed((c) => ({ ...c, __fav: !c.__fav }))}>
            <span className="caret">{collapsed.__fav ? '▸' : '▾'}</span>
            {t('explorer.nav.favorites')} <span className="g-count">{workProfiles.length}</span>
          </div>
          {!collapsed.__fav &&
            workProfiles.map((w) => (
              <div key={w.id} className="fav-node" title={w.path} onClick={() => onOpenWork?.(w)}>
                <span className="fav-i">★</span>
                <span className="fav-n">{w.name}</span>
                <span className="fav-p">{w.path}</span>
              </div>
            ))}
        </div>
      )}
      {sortedGroups.map(([group, list]) => {
        const isCollapsed = collapsed[group]
        return (
          <div className="srv-group" key={group}>
            <div
              className="srv-hd"
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
              onContextMenu={(e) => openCtx(e, group === none ? 'groupNone' : 'group', { kind: 'group', group })}
            >
              <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
              {group} <span className="g-count">{list.length}</span>
            </div>
            {!isCollapsed &&
              list.map((p) => {
                // RDP 는 서버당 세션이 하나뿐이다(두 번째로 붙으면 기존 세션이 끊긴다) — SSH 처럼
                // 자식 세션 목록으로 펼치지 않고 서버 카드에 "연결됨" 하나로만 표시한다.
                const rdpSession = p.type === 'rdp' ? sessions.find((x) => x.profileId === p.id) : undefined
                // 이 서버에서 열린 세션 — 서버 카드 **아래 자식 카드**로 붙는다(준영님 확정: 기존 계층 유지).
                const sess = p.type === 'rdp' ? [] : (byServer.get(p.name) ?? [])
                const nodeCollapsed = collapsed['node:' + p.id]
                const activeHere = sess.some((x) => x.id === activeSessionId) || rdpSession?.id === activeSessionId
                const live = Boolean(rdpSession) || sess.length > 0
                const badge = typeBadge(p.type)
                const card = (
                  <div
                    className={
                      'srv-node' +
                      (live ? '' : ' off') +
                      (activeHere || p.id === (selectedId ?? activeProfileId) ? ' active' : '')
                    }
                    // 호스트는 행에서 뺐다 — 목록에서 매번 필요한 값이 아니라 툴팁으로 내린다.
                    title={`${p.username ? p.username + '@' : ''}${p.host} · ${t('conn.tree.connect')}`}
                    onClick={(e) => {
                      // 더블클릭의 두 번째 click 은 흘려보낸다(접속은 onDoubleClick 한 번만).
                      if (e.detail > 1) return
                      setSelectedId(p.id)
                      const focus = rdpSession ?? sess[0]
                      if (focus) onSelectSession(focus.id)
                    }}
                    onDoubleClick={() => {
                      setSelectedId(p.id)
                      onConnect(p.id)
                    }}
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
                        className="tw on"
                        title={nodeCollapsed ? t('conn.tree.expand') : t('conn.tree.collapse')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setCollapsed((c) => ({ ...c, ['node:' + p.id]: !c['node:' + p.id] }))
                        }}
                      >
                        {nodeCollapsed ? '▸' : '▾'}
                      </span>
                    ) : (
                      <span className="tw" />
                    )}
                    <span className={live ? 'st on' : stDot(conn[p.id])} />
                    <span className={'tbadge ' + badge.cls}>{badge.label}</span>
                    <span className="sname">{p.name}</span>
                    {/* 호버 인라인 버튼 — 우클릭 메뉴를 몰라도 접속할 수 있어야 한다(VS Code 트리 규칙). */}
                    <span className="rowact">
                      <span
                        className="cc-b"
                        title={t('conn.tree.connect')}
                        onClick={(e) => {
                          e.stopPropagation()
                          onConnect(p.id)
                        }}
                      >
                        ▸
                      </span>
                      <span
                        className="cc-b"
                        title={t('conn.tree.more')}
                        onClick={(e) =>
                          openCtx(e, p.type === 'rdp' ? 'serverRdp' : 'server', { kind: 'server', profileId: p.id })
                        }
                      >
                        ⋯
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
              })}
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
          <span className="caret">{collapsed.__local ? '▸' : '▾'}</span>
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
