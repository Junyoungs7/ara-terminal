import { useCallback, useEffect, useState } from 'react'
import { Cheatsheet } from './Cheatsheet'
import { CommandBook } from './CommandBook'
import { ContextMenu } from './ContextMenu'
import { terminalMenu, wantsTerminalMenu, type ActionId, type TerminalMenuCaps } from './actions'
import { matchBinding } from '../../shared/keymap'
import type { TmuxListResult } from '../../shared/tmuxList'

// 우클릭 컨텍스트 인터랙션 오케스트레이터(F4c). 메뉴·치트시트 열림 상태와 우클릭·ESC·? 키를
// 한 곳에서 관리. 실제 액션 배선은 onAction 으로 상위(MainArea)에 위임.
//
// #67(2026-08-14): 라디얼·스마트 팔레트를 제거하고 리스트 하나만 남겼다. 라디얼은 커서가 라벨을
// 가렸고(2026-08-03 피드백으로 이미 기본에서 내려와 있었다), 팔레트는 같은 CONTEXT_ACTIONS 8개를
// 격자로 다시 보여 주는 중복이었다. 고를 것이 없어져 ctxMenuStyle 설정도 함께 사라졌고,
// Ctrl+K 는 리드라인 라인킬로 셸에 돌아갔다(R3.8 충돌 정책의 유일한 예외가 없어졌다).
//
// gridSelector: 우클릭을 받을 영역(터미널 그리드). 그 밖(사이드바 등)에선 브라우저 기본 메뉴 유지.

type Props = {
  onAction: (id: ActionId) => void
  cheatsheetOpen: boolean
  onCheatsheetChange: (open: boolean) => void
  // F18: 명령어 북(검색형 치트시트). 치트시트와 같은 오케스트레이터가 열림 상태를 함께 관리한다
  // (ESC 로 같이 닫히는 것이 자연스럽다 — 새 오케스트레이터를 만들지 않는다).
  commandBookOpen: boolean
  onCommandBookChange: (open: boolean) => void
  // FB-monitor: 설정 [단축키] "tmux 사용법 보기" 같은 진입점이 특정 카테고리로 바로 열리게 한다.
  commandBookQuery?: string
  // [터미널로 보내기] 목적지 — 포커스 패널의 세션(MainArea 가 안다).
  activeSessionId: string | null
  /** 그 세션이 SSH 인가 — tmux 항목을 붙일지 정한다(로컬 셸엔 원격 tmux 가 없다). */
  activeIsSsh?: boolean
  /**
   * 이 창이 할 수 있는 일(#201 A-4). 핸들러가 없는 항목은 메뉴에 넣지 않는다 —
   * 떼어낸 창의 [아라에게 묻기]·[AI 실행] 이 눌러도 아무 일이 없던 자리다.
   */
  caps?: TerminalMenuCaps
  gridSelector?: string
}

type Anchor = { x: number; y: number }

export function ContextInteractions({
  onAction,
  cheatsheetOpen,
  onCheatsheetChange,
  commandBookOpen,
  onCommandBookChange,
  commandBookQuery,
  activeSessionId,
  activeIsSsh,
  caps,
  gridSelector = '.pane-grid'
}: Props) {
  const [list, setList] = useState<Anchor | null>(null)
  /**
   * tmux 조회 결과(제보 11·32). 메뉴를 **열 때 한 번** 묻는다 — 폴링이 아니다.
   * 트리 세션 행이 하던 것과 같은 조회이고(ConnTree), 같은 순수 변환(tmuxMenuItem)으로 그린다.
   */
  const [tmux, setTmux] = useState<TmuxListResult | 'loading' | null>(null)

  const closeMenu = useCallback(() => setList(null), [])

  // 우클릭 → 커서 위치에 메뉴 전개. gridSelector 안에서만 반응.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (!wantsTerminalMenu(e.target as HTMLElement | null, gridSelector)) return
      e.preventDefault()
      setList({ x: e.clientX, y: e.clientY })
      if (!activeIsSsh || !activeSessionId) {
        setTmux(null)
        return
      }
      // 결과가 오기 전에도 항목은 뜬다("확인 중…") — 서버가 느리다고 메뉴가 늦게 뜨면 안 된다.
      setTmux('loading')
      void window.ev?.tmux
        ?.list(activeSessionId)
        .then((r) => setTmux(r))
        // 조회 자체가 실패하면 "확인할 수 없습니다"로 떨어뜨린다(항목을 지우지 않는다 —
        // 있는 기능이 사라진 것처럼 보이면 그게 더 헷갈린다).
        .catch(() => setTmux({ status: 'error', sessions: [] }))
    }
    window.addEventListener('contextmenu', onCtx)
    return () => window.removeEventListener('contextmenu', onCtx)
  }, [gridSelector, activeIsSsh, activeSessionId])

  // ESC: 메뉴/치트시트 닫기. ? : 치트시트 열기(입력 포커스가 아닐 때).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu()
        onCheatsheetChange(false)
        onCommandBookChange(false)
        return
      }
      const el = document.activeElement
      const inInput = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (e.key === '?' && !inInput) {
        e.preventDefault()
        onCheatsheetChange(true)
        return
      }
      if (matchBinding(e, 'commandBook.toggle')) {
        e.preventDefault()
        // 이름 그대로 **토글**이다. 예전엔 늘 true 라 같은 키를 다시 눌러도 안 닫혔다 —
        // 우측 아이콘 바에 들어오면서(2026-08-22 제보 9번) 그 차이가 드러난다: 아이콘은
        // 눌러서 열고 다시 눌러서 닫는 물건이고, 그 클릭이 이 액션으로 온다.
        onCommandBookChange(!commandBookOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeMenu, onCheatsheetChange, onCommandBookChange, commandBookOpen])

  const runAction = useCallback(
    (id: ActionId) => {
      closeMenu()
      onAction(id)
    },
    [closeMenu, onAction]
  )

  return (
    <>
      {/* 트리 우클릭과 같은 ContextMenu 컴포넌트를 재사용한다(자체 backdrop 포함). */}
      <ContextMenu
        open={!!list}
        x={list?.x ?? 0}
        y={list?.y ?? 0}
        items={terminalMenu(tmux ?? undefined, caps)}
        onPick={(id) => runAction(id as ActionId)}
        onClose={closeMenu}
      />
      <Cheatsheet open={cheatsheetOpen} onClose={() => onCheatsheetChange(false)} />
      <CommandBook
        open={commandBookOpen}
        onClose={() => onCommandBookChange(false)}
        sessionId={activeSessionId}
        initialQuery={commandBookQuery}
      />
    </>
  )
}
