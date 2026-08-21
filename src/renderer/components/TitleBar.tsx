import { useState } from 'react'
import { BrandOrb } from './BrandOrb'
import { ContextMenu } from '../interactions/ContextMenu'
import { MENUBAR, menuBarItems, type MenuCommandId } from '../interactions/actions'
import { dispatchAction } from '../../shared/keymap'
import { t } from '../i18n'

// 커스텀 프레임리스 타이틀바 (design-system §4.1/§8). 트래픽 라이트는 no-drag.
//
// R2.6: 신호등 버튼이 실제로 창을 조작한다(그전엔 onClick 자체가 없었다). 글리프는 상시가 아니라
// 클러스터 호버 시에만 노출한다 — macOS 관례이고, 12px dot 안에 아이콘을 늘 그려 두면
// 색만으로 읽히던 신호등이 잡음이 된다.
//
// R4.1: 메뉴바가 실제로 열린다. 그전엔 Session 만 클릭 핸들러가 있었고 나머지 6개는 hover 효과만
// 있는 장식이었다. 항목·라벨·단축키 힌트는 전부 MENUBAR/KEYMAP 파생이고(interactions/actions.tsx),
// 드롭다운 표면은 트리·탭바가 쓰는 ContextMenu 를 그대로 재사용한다.
export function TitleBar({
  onCommand,
  omni
}: {
  onCommand: (id: MenuCommandId) => void
  /** F31 통합 검색창(CommandPalette). 목록이 프로필·즐겨찾기에 걸려 있어 Shell 이 만들어 넘긴다 —
      타이틀바가 그 상태를 알 필요는 없고, 자리만 내준다. */
  omni: React.ReactNode
}) {
  // 열린 최상위 메뉴 인덱스(닫힘 = null) + 그 메뉴를 펼칠 좌표(버튼 왼쪽 아래).
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null)

  const openAt = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setOpen({ index, x: r.left, y: r.bottom })
  }

  const glyph = (d: string) => (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
      <path d={d} />
    </svg>
  )
  return (
    <div className="titlebar">
      <div className="tb-logo">
        <span className="tb-mark">
          <BrandOrb />
        </span>
        <span className="tb-name">
          <b>{t('app.name')}</b>
        </span>
      </div>
      {/* 열려 있을 때만 backdrop 위로 올라간다 — 항상 올려 두면 모달을 뚫는다(shell.css 주석). */}
      <div className={'tb-menu' + (open ? ' on' : '')}>
        {MENUBAR.map((m, i) => (
          <span
            key={m.title}
            className={open?.index === i ? 'open' : undefined}
            onClick={(e) => openAt(i, e.currentTarget)}
            // 하나가 열려 있으면 다른 최상위 위를 지나기만 해도 그쪽으로 넘어간다(메뉴바 관례).
            onMouseEnter={(e) => open && openAt(i, e.currentTarget)}
          >
            {m.title}
          </span>
        ))}
      </div>
      {/* F31 통합 검색 — VS Code 처럼 **상단 가운데의 검색창**이다. 여기 있는 것 자체가 안내라
          단축키(F1)를 모르는 사람도 기능을 이름으로 찾아 들어올 수 있다.
          창을 여는 버튼이 아니라 **바로 타이핑하는 칸**이고, 결과는 그 아래로 펼쳐진다. */}
      <div className="tb-spacer" />
      {omni}
      <div className="tb-spacer" />
      <div className="tb-quick">
        {/* FB-ui2(FB-0006): 아라·기어 아이콘을 우측 액티비티 바로 옮겼다(중복 진입점 정리 —
            메뉴(File>설정)·단축키(Alt+A, Ctrl+,)는 그대로 유지, ActivityBar.tsx 참고). */}
        <div
          className="tb-help"
          title={t('titlebar.help')}
          onClick={() => onCommand('help.cheatsheet')}
        >
          ?
        </div>
      </div>
      <div className="tb-controls">
        <span className="tb-ctl min" title={t('titlebar.min')} onClick={() => void window.ev?.window.minimize()}>
          {glyph('M3 6h6')}
        </span>
        <span
          className="tb-ctl max"
          title={t('titlebar.max')}
          onClick={() => void window.ev?.window.toggleMaximize()}
        >
          {glyph('M4.2 7.8L7.8 4.2M7.8 4.2H5.2M7.8 4.2v2.6M4.2 7.8h2.6M4.2 7.8V5.2')}
        </span>
        <span className="tb-ctl close" title={t('titlebar.close')} onClick={() => void window.ev?.window.close()}>
          {glyph('M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8')}
        </span>
      </div>
      <ContextMenu
        open={open !== null}
        x={open?.x ?? 0}
        y={open?.y ?? 0}
        items={open ? menuBarItems(open.index) : []}
        onPick={(id) => {
          const entry = open ? MENUBAR[open.index].items.find((e) => ('action' in e ? e.action : e.command) === id) : undefined
          setOpen(null)
          if (!entry) return
          // 단축키가 있는 항목은 그 키를 누른 것과 같은 경로로 보낸다(메뉴 전용 배선 금지).
          if ('action' in entry) dispatchAction(entry.action)
          else onCommand(entry.command)
        }}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
