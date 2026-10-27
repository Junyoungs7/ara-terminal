import { useState } from 'react'
import { BrandOrb } from './BrandOrb'
import { ContextMenu } from '../interactions/ContextMenu'
import { MENUBAR, menuBarItems, type MenuCommandId } from '../interactions/actions'
import type { FeatureShown } from '@shared/features'
import { dispatchAction, KEYMAP } from '../../shared/keymap'
import { t } from '../i18n'

// 커스텀 프레임리스 타이틀바 (design-system §4.1/§8). 창 컨트롤은 no-drag.
//
// R2.6: 창 버튼이 실제로 창을 조작한다(그전엔 onClick 자체가 없었다). 2.0 4단계에서 신호등 점을
// 시안의 얇은 선 아이콘(− □ ×)으로 바꿨다 — 글리프는 늘 보인다.
//
// R4.1: 메뉴바가 실제로 열린다. 그전엔 Session 만 클릭 핸들러가 있었고 나머지 6개는 hover 효과만
// 있는 장식이었다. 항목·라벨·단축키 힌트는 전부 MENUBAR/KEYMAP 파생이고(interactions/actions.tsx),
// 드롭다운 표면은 트리·탭바가 쓰는 ContextMenu 를 그대로 재사용한다.
/**
 * 2026-08-23(준영님 제보 5): **떼어낸 창도 이 타이틀바를 쓴다.**
 * "새창 상단 닫기 내리기 전체 디자인도 우리 아라 디자인과 동일해야해" — 그전에는 OS 기본
 * 프레임이었다. 세션 창에는 메뉴바도 통합 검색도 없으므로(그건 본창의 일이다) 두 자리를
 * **선택**으로 바꾸고, 대신 그 자리에 창 제목을 놓는다. 컴포넌트를 두 벌 만들지 않는다 —
 * 창 버튼 모양·드래그 영역·호버 규칙이 두 창에서 갈리면 그게 곧 "다른 앱처럼 보인다"가 된다.
 */
export function TitleBar({
  onCommand,
  omni,
  title,
  reportNews = 0,
  chat,
  features
}: {
  /** 없으면 메뉴바·[?] 를 그리지 않는다(세션 창). */
  onCommand?: (id: MenuCommandId) => void
  /** F31 통합 검색창(CommandPalette). 목록이 프로필·즐겨찾기에 걸려 있어 Shell 이 만들어 넘긴다 —
      타이틀바가 그 상태를 알 필요는 없고, 자리만 내준다. */
  omni?: React.ReactNode
  /** 세션 창의 제목(서버 — 세션). 본창은 안 쓴다(로고가 그 자리다). */
  title?: string
  /** R16: 새 소식이 있는 내 신고 수. 0 보다 크면 [내 신고] 가 든 메뉴 제목에 빨간 점, 항목 라벨에 개수. */
  reportNews?: number
  /** 2.0: 오른쪽 [채팅] 버튼 — 아라 채팅 열고 닫기(단축키 ai.toggle 과 같은 동작). 없으면 안 그린다(세션 창). */
  chat?: { open: boolean; onToggle: () => void }
  /** 2.0 설정 › 기능 — 끈 기능은 메뉴에서 뺀다. 없으면 전부. */
  features?: FeatureShown
}) {
  // 열린 최상위 메뉴 인덱스(닫힘 = null) + 그 메뉴를 펼칠 좌표(버튼 왼쪽 아래).
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null)

  const openAt = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setOpen({ index, x: r.left, y: r.bottom })
  }

  const chatBind = KEYMAP.find((k) => k.action === 'ai.toggle')
  const chatKey = (navigator.userAgent.includes('Mac') ? chatBind?.mac : chatBind?.win)?.replace(/\+/g, ' ') ?? ''

  // 2.0 4단계: 신호등 점 → 시안 Z-final 의 얇은 선 − □ ×(닫기 호버만 빨강 바탕). 기능·선택자는 그대로.
  const glyph = (body: React.ReactNode) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {body}
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
      {onCommand && (
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
            {reportNews > 0 && m.items.some((e) => 'command' in e && e.command === 'help.myReports') && (
              <i className="tb-news" role="img" aria-label={t('report.news.dot')} />
            )}
          </span>
        ))}
      </div>
      )}
      {/* F31 통합 검색 — VS Code 처럼 **상단 가운데의 검색창**이다. 여기 있는 것 자체가 안내라
          단축키(F1)를 모르는 사람도 기능을 이름으로 찾아 들어올 수 있다.
          창을 여는 버튼이 아니라 **바로 타이핑하는 칸**이고, 결과는 그 아래로 펼쳐진다. */}
      <div className="tb-spacer" />
      {omni}
      {/* 세션 창 — 검색창 자리에 **이 창이 무엇인지**를 놓는다(작업표시줄 제목과 같은 문구). */}
      {title && <div className="tb-title">{title}</div>}
      <div className="tb-spacer" />
      {/* 2.0: 오른쪽 = 아라 채팅만. 우측 액티비티 바가 없어져 여닫는 자리가 여기 하나다(시안 Z-final). */}
      {chat && (
        <button
          type="button"
          className={'tb-chat' + (chat.open ? ' on' : '')}
          aria-pressed={chat.open}
          data-action="chat.toggle"
          title={t('titlebar.chat.tip')}
          onClick={chat.onToggle}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
          </svg>
          <span>{t('titlebar.chat')}</span>
          <kbd>{chatKey}</kbd>
        </button>
      )}
      <div className="tb-quick">
        {/* FB-ui2(FB-0006): 아라·기어 아이콘은 여기 없다 — 채팅은 위 [채팅] 버튼, 설정은 좌측 레일·
            메뉴(파일>설정)·단축키(Alt+A, Ctrl+,)가 맡는다. */}
        {onCommand && (
          <div className="tb-help" title={t('titlebar.help')} onClick={() => onCommand('help.cheatsheet')}>
            ?
          </div>
        )}
      </div>
      <div className="tb-controls">
        {/* M3: 셋 다 <button> 이다 — 키보드로 닫을 수 있어야 한다(전에는 마우스로만 닿았다). */}
        <button type="button" className="tb-ctl min" title={t('titlebar.min')} onClick={() => void window.ev?.window.minimize()}>
          {glyph(<path d="M5 12h14" />)}
        </button>
        <button
          type="button"
          className="tb-ctl max"
          title={t('titlebar.max')}
          onClick={() => void window.ev?.window.toggleMaximize()}
        >
          {glyph(<rect width="12" height="12" x="6" y="6" rx="1" />)}
        </button>
        <button type="button" className="tb-ctl close" title={t('titlebar.close')} onClick={() => void window.ev?.window.close()}>
          {glyph(<path d="M18 6 6 18M6 6l12 12" />)}
        </button>
      </div>
      <ContextMenu
        open={open !== null}
        x={open?.x ?? 0}
        y={open?.y ?? 0}
        items={
          open
            ? menuBarItems(open.index, features).map((it) =>
                it.id === 'help.myReports' && reportNews > 0
                  ? { ...it, label: t('menu.help.myReports.new').replace('{n}', String(reportNews)) }
                  : it
              )
            : []
        }
        onPick={(id) => {
          const entry = open ? MENUBAR[open.index].items.find((e) => ('action' in e ? e.action : e.command) === id) : undefined
          setOpen(null)
          if (!entry) return
          // 단축키가 있는 항목은 그 키를 누른 것과 같은 경로로 보낸다(메뉴 전용 배선 금지).
          if ('action' in entry) dispatchAction(entry.action)
          else onCommand?.(entry.command)
        }}
        onClose={() => setOpen(null)}
      />
    </div>
  )
}
