import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, List, SquareTerminal, Star, Zap } from 'lucide-react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import { matchBinding } from '../../shared/keymap'
import {
  filterPalette,
  groupPalette,
  moveCursor,
  openItems,
  paletteHome,
  paletteItems,
  recentServers,
  PALETTE_GROUPS,
  type PaletteKind,
  type PaletteRun
} from '../store/palette'
import { t } from '../i18n'
import type { FeatureId, FeatureShown } from '@shared/features'

// F31 통합 검색. 목록·검색·묶기는 store/palette.ts 의 순수 함수이고 여기는 그리기만 한다.
//
// 2026-08-13 준영님 재요청("단축키 뿐만 아니라 상단에 검색창을 추가해줘. vscode처럼")으로 타이틀바
// 가운데에 **검색칸 모양**이 생겼다. 처음엔 누르면 가운데 창이 뜨는 *버튼*이었는데 검색창처럼 보이지
// 않았다는 것이 그때의 문제였다 — 그래서 칸은 지금도 돋보기·안내·F1 칩을 단 검색칸 모양이다.
//
// 2.0 다듬기 R1(2026-10-28 준영님 "통합 검색 = 시안 Z-palette"): 결과는 **화면 가운데 640px 창**
// (뒤 살짝 어둡게)이고 타이핑은 그 창의 큰 입력칸에서 한다. 칸을 누르거나 F1 을 누르면 창 입력칸에
// 커서가 바로 있다. 타이틀바 칸에서 치게 두지 않은 이유: 입력이 둘이 되면 타이틀바에서 시작한 한글
// 조합(IME)을 창 입력칸으로 넘기는 순간 조합이 깨진다(`ㅋ` + `우` = `ㅋ우`).
//
// #67 이전에는 이름이 비슷한 SmartPalette(터미널 우클릭 자리의 8칸 격자)가 따로 있었다.
// 지금은 제거돼 이 앱의 팔레트는 여기 하나다 — 앱 전체 기능·프로필을 이름으로 찾는 곳.

type Props = {
  open: boolean
  onOpen: () => void
  onClose: () => void
  profiles: readonly ConnectionProfile[]
  workProfiles: readonly WorkProfile[]
  onRun: (run: PaletteRun) => void
  /** 2.0 설정 › 기능 — 꺼진 기능에 배지를 붙인다. */
  features?: FeatureShown
  /** Ctrl+Enter — 꺼진 기능을 설정에서 켠다(그리고 실행한다). */
  onEnable?: (id: FeatureId) => void
  /** 2.0 다듬기 R1: 빈 검색어의 [열린 창] — 세션 탭(+ 탐색기 창). */
  sessions?: readonly { id: string; title: string; server?: string }[]
  explorerOpen?: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

// 줄 왼쪽 아이콘 — 종류별 하나(시안 Z-palette 의 24px 타일). 기능마다 그림을 따로 두면 표가 하나 더 생긴다.
const KIND_ICON: Record<PaletteKind, () => JSX.Element> = {
  session: () => <AppWindow />,
  action: () => <Zap />,
  command: () => <List />,
  profile: () => <SquareTerminal />,
  work: () => <Star />
}

const NO_SESSIONS: readonly { id: string; title: string; server?: string }[] = []

export function CommandPalette({
  open,
  onOpen,
  onClose,
  profiles,
  workProfiles,
  onRun,
  features,
  onEnable,
  sessions = NO_SESSIONS,
  explorerOpen = false
}: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => paletteItems(profiles, workProfiles, isMac, features),
    [profiles, workProfiles, features]
  )
  const opened = useMemo(() => openItems(sessions, explorerOpen), [sessions, explorerOpen])
  // 빈 검색어 = 열린 창 / 최근 서버 / 숨긴 기능(긴 단축키 목록 대신). 셋 다 비면 전체 목록.
  // 최근 서버는 열 때마다 다시 읽는다(접속은 이 컴포넌트 밖에서 일어난다).
  const groups = useMemo(() => {
    const home = q.trim() ? [] : paletteHome(items, opened, open ? recentServers() : [])
    if (home.length > 0) return home
    return groupPalette(filterPalette([...opened, ...items], q)).map((g) => ({
      key: PALETTE_GROUPS.find((x) => x.kind === g.kind)!.key,
      items: g.items
    }))
  }, [items, opened, q, open])
  // 커서는 **화면에 보이는 순서**를 따른다 — 묶어서 그린 목록과 어긋나면 ↑↓ 가 위아래로 튄다.
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups])
  // 맞은 글자 강조(시안) — 첫 낱말만. 낱말 순서를 바꿔 쳐도 찾히지만 강조까지 따라가진 않는다.
  const word = q.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

  useEffect(() => {
    if (!open) {
      // 닫힐 때 검색어를 버린다 — 다음에 열었을 때 지난 검색어가 남아 있으면 "왜 목록이 짧지"가 된다.
      setQ('')
      return
    }
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  // 검색어가 바뀌면 첫 항목으로. 커서가 사라진 항목을 가리킨 채 Enter 하는 일이 없게 한다.
  useEffect(() => setCursor(0), [q])

  // 커서가 목록 밖으로 나가면 따라 스크롤한다(↑↓ 로만 훑을 때 화면이 안 따라오면 못 쓴다).
  useEffect(() => {
    listRef.current?.querySelector('.cp-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, q])

  const pick = (i: number, enable = false): void => {
    const item = ordered[i]
    if (!item) return
    if (enable && item.off) onEnable?.(item.off.id)
    // **실행 전에 포커스를 내려놓는다.** onClose 는 React 상태라 이번 틱에 반영되지 않는데,
    // 그 사이에 실행된 기능이 "입력칸에 타이핑 중이면 무시"로 스스로를 막을 수 있다
    // (치트시트의 `?` 가 정확히 그렇다 — 이걸 빠뜨려 PAL-5 가 빨갰다).
    inputRef.current?.blur()
    onClose()
    onRun(item.run)
  }

  const mark = (text: string) => {
    const at = word ? text.toLowerCase().indexOf(word) : -1
    if (at < 0) return text
    return (
      <>
        {text.slice(0, at)}
        <mark>{text.slice(at, at + word.length)}</mark>
        {text.slice(at + word.length)}
      </>
    )
  }

  return (
    <>
      {/* 타이틀바 가운데 칸 — 여는 자리. 생김새는 검색칸 그대로(돋보기·안내·F1 칩)라 무엇인지 안다. */}
      <button type="button" className="tb-omni" data-action="palette.open" aria-label={t('palette.title')} onClick={onOpen}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <span className="tb-omni-ph">{t('palette.placeholder')}</span>
        <kbd className="tb-omni-key kbd">F1</kbd>
      </button>

      {open && (
        <>
          {/* 뒤 살짝 어둡게. mousedown 을 막아 입력칸이 blur 로 먼저 닫히며 두 번 닫히는 일을 피한다. */}
          <div
            className="cp-scrim"
            onMouseDown={(e) => {
              e.preventDefault()
              onClose()
            }}
          />
          <div
            className="cp-drop"
            role="dialog"
            aria-label={t('palette.title')}
            // 항목을 누를 때 입력칸이 먼저 포커스를 잃으면(onBlur → 닫힘) 클릭이 도착하기도 전에
            // 목록이 사라진다. 입력칸 밖의 mousedown 을 막아 포커스를 붙잡아 둔다.
            onMouseDown={(e) => {
              if (e.target !== inputRef.current) e.preventDefault()
            }}
          >
            <div className="cp-head">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4-4" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                data-field="palette"
                aria-label={t('palette.title')}
                spellCheck={false}
                placeholder={t('palette.placeholder')}
                value={q}
                onBlur={onClose}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  // 터미널·트리 단축키가 검색 중에 발동하지 않게 여기서 끊는다. 그래서 **여는 키를 다시
                  // 눌러 닫는 것도 여기서** 받아야 한다 — 안 그러면 창 단축키 핸들러까지 닿지 않는다.
                  // 키 조합은 여전히 keymap 단일 소스에서 온다(여기에 'F1' 을 적지 않는다).
                  e.stopPropagation()
                  if (matchBinding(e.nativeEvent, 'palette.all')) {
                    e.preventDefault()
                    onClose()
                  } else if (e.key === 'Escape') onClose()
                  else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setCursor((c) => moveCursor(c, 1, ordered.length))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setCursor((c) => moveCursor(c, -1, ordered.length))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    pick(cursor, e.ctrlKey || e.metaKey)
                  }
                }}
              />
              <kbd className="kbd">Esc</kbd>
            </div>
            <div className="cp-list" ref={listRef}>
              {ordered.length === 0 && <div className="cp-empty">{t('palette.empty')}</div>}
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="cp-group">{t(g.key)}</div>
                  {g.items.map((item) => {
                    const i = ordered.indexOf(item)
                    const Icon = KIND_ICON[item.kind]
                    return (
                      <div
                        key={item.id}
                        className={'cp-item' + (i === cursor ? ' on' : '')}
                        data-item={item.id}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => pick(i)}
                      >
                        <span className="cp-ic" aria-hidden>
                          <Icon />
                        </span>
                        <span className="cp-label">{mark(item.label)}</span>
                        {item.hint && <span className="cp-hint">{mark(item.hint)}</span>}
                        {item.off && (
                          <span className="cp-off">
                            {t(item.off.byDefault ? 'palette.off.default' : 'palette.off')}
                          </span>
                        )}
                        {item.key && <kbd className="cp-key kbd">{item.key}</kbd>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="cp-foot">
              <span>
                <kbd className="kbd">↑↓</kbd> {t('palette.foot.move')}
              </span>
              <span>
                <kbd className="kbd">Enter</kbd> {t('palette.foot.run')}
              </span>
              <span>
                <kbd className="kbd">{isMac ? 'Cmd Enter' : 'Ctrl Enter'}</kbd> {t('palette.foot.enable')}
              </span>
              <span className="cp-foot-note">{t('palette.foot.note')}</span>
            </div>
          </div>
        </>
      )}
    </>
  )
}
