import { useLayoutEffect, useRef, useState } from 'react'
import { groupColor, type Session } from '../store/sessions'
import { isTabOverflowing } from '../store/tabOverflow'
import { shouldDetach } from '../store/tabDetach'
import { ContextMenu, type MenuItem } from '../interactions/ContextMenu'
import { treeMenu, type TreeActionId } from '../interactions/actions'
import { t } from '../i18n'
import { IconChevronDown, IconClose, IconPlus } from './icons'

// 터미널 탭바 — FB-tabs: 서버 그룹 래퍼(.tg)를 없애고 평평한 개별 탭으로 그린다(피드백:
// "그룹핑으로 묶이는게 불편해" ≠ "서버 구분이 필요 없다"). 어느 서버 세션인지는 .tdot 색
// (groupColor — 로컬은 accent, 원격은 서버명 해시)만으로 최소 단서를 남긴다.
//
// R2: 더블클릭 인라인 이름 변경 / 우클릭 메뉴 / 드래그 재정렬. 편집 상태는 MainArea 가 들고 있다
// (트리 우클릭 "이름 변경"도 같은 편집을 열어야 하므로 — 편집 시작점이 두 곳이면 상태도 하나여야 한다).
type Props = {
  sessions: Session[]
  activeId: string | null
  // FB-ui2(FB-0005): 지금 어떤 패널에도 없는(detach) 세션 id 집합 — 은은한 시각 구분용.
  placedIds: ReadonlySet<string>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  // ＋ 메뉴의 "SSH 연결…" — 연결 관리자 열기(로컬 셸 발견성 대응, 2026-08-03 피드백).
  onNewSsh: () => void
  // F27 진입점 ① — ＋ 메뉴의 "AI CLI 시작…". 아무것도 정해지지 않은 채로 창이 열린다.
  onAiCli: () => void
  // R2.1/R2.2: 인라인 편집 중인 탭 id(없으면 null) + 편집 시작/확정. value=null 은 취소(ESC).
  editingId: string | null
  onStartEdit: (id: string) => void
  onCommitEdit: (id: string, value: string | null) => void
  // R2.2 탭 메뉴 액션.
  onDuplicate: (id: string) => void
  onCloseOthers: (id: string) => void
  // R2.3 드래그 재정렬. FB-tabs: 그룹 래퍼가 없어져 서버가 달라도 자유롭게 옮길 수 있다.
  onReorder: (dragId: string, overId: string) => void
}

type TabDnd = {
  dragging: boolean
  dropping: boolean
  handlers: React.HTMLAttributes<HTMLDivElement> & { draggable: boolean }
}

function Ttab({
  s,
  color,
  active,
  offscreen,
  editing,
  dnd,
  onSelect,
  onClose,
  onStartEdit,
  onCommitEdit,
  onCtx
}: {
  s: Session
  color: string
  active: boolean
  // FB-ui2(FB-0005): 패널에 배치되지 않음 — 클릭하면 showSession 이 포커스 패널에 다시 표시한다.
  offscreen: boolean
  editing: boolean
  dnd: TabDnd
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onStartEdit: (id: string) => void
  onCommitEdit: (id: string, value: string | null) => void
  onCtx: (e: React.MouseEvent, id: string) => void
}) {
  const { handlers, dragging, dropping } = dnd
  return (
    <div
      {...handlers}
      className={
        'ttab' +
        (active ? ' active' : '') +
        (offscreen ? ' offscreen' : '') +
        (dragging ? ' dragging' : '') +
        (dropping ? ' drop' : '')
      }
      title={editing ? undefined : offscreen ? `${s.title} — ${t('tab.offscreenHint')}` : s.title}
      data-session-id={s.id}
      onClick={() => onSelect(s.id)}
      onDoubleClick={() => onStartEdit(s.id)}
      onContextMenu={(e) => onCtx(e, s.id)}
    >
      <span className="tdot" style={{ background: color }} />
      {editing ? (
        <input
          className="tt-edit"
          defaultValue={s.title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={(e) => onCommitEdit(s.id, e.currentTarget.value)}
          onKeyDown={(e) => {
            // 편집 중에는 전역 단축키(Ctrl+W 등)로 새어 나가면 안 된다.
            e.stopPropagation()
            if (e.key === 'Enter') onCommitEdit(s.id, e.currentTarget.value)
            else if (e.key === 'Escape') onCommitEdit(s.id, null)
          }}
        />
      ) : (
        <span className="tlabel">{s.title}</span>
      )}
      <span
        className="tx"
        title={t('tab.close')}
        onClick={(e) => {
          e.stopPropagation()
          onClose(s.id)
        }}
      >
        <IconClose />
      </span>
    </div>
  )
}

export function TermTabbar({
  sessions,
  activeId,
  placedIds,
  onSelect,
  onClose,
  onNew,
  onNewSsh,
  onAiCli,
  editingId,
  onStartEdit,
  onCommitEdit,
  onDuplicate,
  onCloseOthers,
  onReorder
}: Props) {
  // ＋ 버튼 우클릭 보조 메뉴 좌표(로컬 셸 / SSH 연결) — 좌클릭은 onNew() 로 바로 로컬 셸을 연다(UI-tabbar).
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  // 탭 우클릭 메뉴(대상 세션 id 포함).
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // FB-tabs: 오버플로 드롭다운 좌표(열려 있으면 non-null).
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // FB-tabs: 탭 스크롤 폭이 보이는 폭을 넘으면 우측 드롭다운 버튼을 띄운다.
  // 탭 수·라벨이 바뀔 때(레이아웃 반영 후 측정)와 컨테이너 자체가 리사이즈될 때(사이드바 접힘 등) 둘 다 잡는다.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setOverflowing(isTabOverflowing(el.clientWidth, el.scrollWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sessions])

  const dndFor = (s: Session): TabDnd => ({
    dragging: dragId === s.id,
    dropping: overId === s.id,
    handlers: {
      draggable: editingId !== s.id,
      onDragStart: (e) => {
        setDragId(s.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', s.id)
      },
      onDragEnd: (e) => {
        setDragId(null)
        setOverId(null)
        // 창 밖에 놓았으면 새 창으로 떼어낸다(판정 규칙은 store/tabDetach.ts — 그 주석이 근거다).
        const at = { x: e.screenX, y: e.screenY }
        const box = { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }
        if (shouldDetach(e.dataTransfer.dropEffect, at, box)) detach(s.id, at)
      },
      onDragOver: (e) => {
        // 탭바 위 드롭 = 재정렬(터미널 영역 드롭 = 분할은 PaneGrid 가 별도로 받는다 — FB-0002).
        if (!dragId || dragId === s.id) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOverId(s.id)
      },
      onDragLeave: () => setOverId((cur) => (cur === s.id ? null : cur)),
      onDrop: (e) => {
        e.preventDefault()
        const from = dragId ?? e.dataTransfer.getData('text/plain')
        setDragId(null)
        setOverId(null)
        if (from) onReorder(from, s.id)
      }
    }
  })

  /**
   * F32: 별도 창으로 떼어낸다 — 우클릭 메뉴와 **창 밖 드롭**이 같이 쓴다.
   * 여기서 탭을 지우지 않는다: main 이 소유를 바꾸고 `session:moved` 를 보내면 useSessions 가
   * 두 창의 목록을 함께 맞춘다(한쪽만 고치면 갈린다).
   * 2026-08-22: 결과를 버리지 않는다. 실패해도 아무 일이 없으면 "눌렀는데 안 된다"가 되고
   * (준영님 제보 31번) 원인을 좁힐 단서도 남지 않는다.
   */
  const detach = (id: string, at?: { x: number; y: number }) => {
    void window.ev?.window
      .detachSession(id, at)
      .then((r) => {
        if (!r?.ok) console.error('[detach] main 이 거절했습니다 — sessionId=', id)
      })
      .catch((e: unknown) => console.error('[detach] 실패:', e))
  }

  const openTabMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    setTabMenu({ x: e.clientX, y: e.clientY, id })
  }

  const tab = (s: Session) => (
    <Ttab
      key={s.id}
      s={s}
      color={groupColor(s.serverKey, s.type === 'local')}
      active={s.id === activeId}
      offscreen={!placedIds.has(s.id)}
      editing={editingId === s.id}
      dnd={dndFor(s)}
      onSelect={onSelect}
      onClose={onClose}
      onStartEdit={onStartEdit}
      onCommitEdit={onCommitEdit}
      onCtx={openTabMenu}
    />
  )

  // 오버플로 드롭다운 항목 — 탭과 같은 서버색 dot + 활성 탭엔 "현재" 힌트.
  const overflowItems: MenuItem[] = sessions.map((s) => ({
    id: s.id,
    label: s.title,
    icon: <span className="tdot" style={{ background: groupColor(s.serverKey, s.type === 'local') }} />,
    ...(s.id === activeId ? { hint: t('tab.active') } : {})
  }))

  return (
    <div className="term-tabbar">
      <div className="tt-scroll" ref={scrollRef}>
        {sessions.map(tab)}
        <div
          className="tterm-add"
          title={t('tab.newMenu')}
          onClick={onNew}
          onContextMenu={(e) => {
            e.preventDefault()
            setAddMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          <IconPlus />
        </div>
      </div>
      {overflowing && (
        <div
          className="tt-overflow-btn"
          title={t('tab.overflow')}
          onClick={(e) => setOverflowMenu({ x: e.clientX, y: e.clientY })}
        >
          <IconChevronDown />
        </div>
      )}
      <ContextMenu
        open={addMenu !== null}
        x={addMenu?.x ?? 0}
        y={addMenu?.y ?? 0}
        items={treeMenu('add')}
        onPick={(id) => {
          setAddMenu(null)
          if (id === 'local.new') onNew()
          else if (id === 'aicli.start') onAiCli()
          else onNewSsh()
        }}
        onClose={() => setAddMenu(null)}
      />
      <ContextMenu
        open={tabMenu !== null}
        x={tabMenu?.x ?? 0}
        y={tabMenu?.y ?? 0}
        items={treeMenu('tab')}
        onPick={(id) => {
          const target = tabMenu?.id
          setTabMenu(null)
          if (!target) return
          const action = id as TreeActionId
          if (action === 'session.rename') onStartEdit(target)
          else if (action === 'session.duplicate') onDuplicate(target)
          else if (action === 'session.close') onClose(target)
          else if (action === 'session.closeOthers') onCloseOthers(target)
          else if (action === 'session.detach') detach(target)
        }}
        onClose={() => setTabMenu(null)}
      />
      <ContextMenu
        open={overflowMenu !== null}
        x={overflowMenu?.x ?? 0}
        y={overflowMenu?.y ?? 0}
        items={overflowItems}
        onPick={(id) => {
          setOverflowMenu(null)
          onSelect(id)
          scrollRef.current?.querySelector(`[data-session-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
        }}
        onClose={() => setOverflowMenu(null)}
      />
    </div>
  )
}
