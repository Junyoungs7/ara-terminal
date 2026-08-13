import { useCallback, useEffect, useState } from 'react'
import { RadialMenu } from './RadialMenu'
import { SmartPalette } from './SmartPalette'
import { Cheatsheet } from './Cheatsheet'
import { CommandBook } from './CommandBook'
import { ContextMenu } from './ContextMenu'
import { terminalMenu, type ActionId } from './actions'
import type { CtxMenuStyle } from '@shared/types'
import { matchBinding } from '../../shared/keymap'

// 우클릭 컨텍스트 인터랙션 오케스트레이터(F4c). 라디얼/팔레트/치트시트 열림 상태와
// 우클릭·ESC·바깥클릭·? 키를 한 곳에서 관리. 실제 액션 배선은 onAction 으로 상위(MainArea)에 위임.
//
// gridSelector: 우클릭을 받을 영역(터미널 그리드). 그 밖(사이드바 등)에선 브라우저 기본 메뉴 유지.

type Props = {
  ctxMenuStyle: CtxMenuStyle
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
  gridSelector?: string
}

type Anchor = { x: number; y: number }

export function ContextInteractions({
  ctxMenuStyle,
  onAction,
  cheatsheetOpen,
  onCheatsheetChange,
  commandBookOpen,
  onCommandBookChange,
  commandBookQuery,
  activeSessionId,
  gridSelector = '.pane-grid'
}: Props) {
  const [radial, setRadial] = useState<Anchor | null>(null)
  const [palette, setPalette] = useState<Anchor | null>(null)
  // 기본 스타일. 라디얼은 커서가 라벨을 가린다는 피드백(2026-08-03)으로 리스트가 기본이 됐다.
  const [list, setList] = useState<Anchor | null>(null)

  const closeMenu = useCallback(() => {
    setRadial(null)
    setPalette(null)
    setList(null)
  }, [])

  // 우클릭 → 커서 위치에 라디얼/팔레트 전개. gridSelector 안에서만 반응.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest(gridSelector)) return
      e.preventDefault()
      closeMenu()
      const at = { x: e.clientX, y: e.clientY }
      if (ctxMenuStyle === 'radial') setRadial(at)
      else if (ctxMenuStyle === 'palette') setPalette(at)
      else setList(at)
    }
    window.addEventListener('contextmenu', onCtx)
    return () => window.removeEventListener('contextmenu', onCtx)
  }, [ctxMenuStyle, closeMenu, gridSelector])

  // ESC: 메뉴/치트시트 닫기. ? : 치트시트 열기(입력 포커스가 아닐 때). Ctrl/Cmd+K: 중앙 팔레트.
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
        onCommandBookChange(true)
        return
      }
      if (matchBinding(e, 'palette.smart')) {
        e.preventDefault()
        closeMenu()
        // 화면 중앙에 팔레트(§목업 ⌘K: vw/2-140, vh/2-160).
        setPalette({ x: window.innerWidth / 2 - 140, y: window.innerHeight / 2 - 160 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeMenu, onCheatsheetChange, onCommandBookChange])

  const runAction = useCallback(
    (id: ActionId) => {
      closeMenu()
      onAction(id)
    },
    [closeMenu, onAction]
  )

  return (
    <>
      {(radial || palette) && <div className="radial-backdrop open" onClick={closeMenu} />}
      <RadialMenu
        open={!!radial}
        x={radial?.x ?? 0}
        y={radial?.y ?? 0}
        onAction={runAction}
        onClose={closeMenu}
      />
      <SmartPalette open={!!palette} x={palette?.x ?? 0} y={palette?.y ?? 0} onAction={runAction} />
      {/* 기본 스타일 — 트리 우클릭과 같은 ContextMenu 컴포넌트를 재사용한다(자체 backdrop 포함). */}
      <ContextMenu
        open={!!list}
        x={list?.x ?? 0}
        y={list?.y ?? 0}
        items={terminalMenu()}
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
