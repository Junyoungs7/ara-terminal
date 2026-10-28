import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import { matchBinding } from '../../shared/keymap'
import { filterPalette, groupPalette, moveCursor, paletteItems, PALETTE_GROUPS, type PaletteRun } from '../store/palette'
import { t } from '../i18n'
import type { FeatureId, FeatureShown } from '@shared/features'

// F31 통합 검색 — 타이틀바에 **박혀 있는 검색창**이다. 목록·검색·묶기는 store/palette.ts 의
// 순수 함수이고 여기는 그리기만 한다.
//
// 2026-08-13 준영님 재요청("단축키 뿐만 아니라 상단에 검색창을 추가해줘. vscode처럼")으로 모양을
// 바꿨다. 처음엔 **누르면 가운데 창이 뜨는 버튼**이었는데, 그건 검색창처럼 보이지 않았다.
// 지금은 타이틀바 그 자리에서 바로 타이핑하고 결과가 **그 아래로** 펼쳐진다.
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
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

export function CommandPalette({
  open,
  onOpen,
  onClose,
  profiles,
  workProfiles,
  onRun,
  features,
  onEnable
}: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 펼침 목록의 자리. 타이틀바 안에 두면 아래 본문이 덮으므로 position:fixed 로 띄우고
  // 검색창 사각형에 맞춘다(폭까지 같게 — VS Code 와 같은 모양).
  const [drop, setDrop] = useState<{ left: number; top: number; width: number } | null>(null)

  const items = useMemo(
    () => paletteItems(profiles, workProfiles, isMac, features),
    [profiles, workProfiles, features]
  )
  const shown = useMemo(() => filterPalette(items, q), [items, q])
  const groups = useMemo(() => groupPalette(shown), [shown])
  // 커서는 **화면에 보이는 순서**를 따라야 한다 — 검색 순위대로 정렬된 shown 을 그대로 세면
  // 묶어서 그린 목록과 어긋나 ↑↓ 가 위아래로 튄다.
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups])

  /**
   * 목록 자리는 검색 상자를 재서 정한다. 목록이 `position: fixed` 라 **화면 좌표**이고,
   * 그래서 **상자가 움직이면 다시 재야 한다.**
   *
   * 2026-09-02 준영님 제보: *"Ctrl+Shift+I 로 콘솔을 킨 상태에서 F1 으로 리스트가 나온 상태에서
   * 콘솔을 끄면, 리스트가 원래 콘솔이 켜진 상태의 위치에 계속 있어서 검색바와 위치가 안 맞는다."*
   * DevTools 를 여닫으면 뷰포트가 바뀌어 상자가 움직이는데 `[open]` 만 보고 있었다.
   *
   * **걷지 않고 다시 잰다.** 터미널 고스트는 리사이즈 때 걷는 쪽을 골랐는데(TerminalPane 의
   * onResize → clearGhost) 그건 커서를 쫓아다닐 값이 없어서였다. 여기는 사용자가 **검색어를 치던
   * 중**이라 목록이 사라지면 그게 더 나쁘다.
   */
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = boxRef.current?.getBoundingClientRect()
      if (r) setDrop({ left: r.left, top: r.bottom + 4, width: r.width })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) {
      // 닫힐 때 검색어를 버린다 — 다음에 열었을 때 지난 검색어가 남아 있으면 "왜 목록이 짧지"가 된다.
      setQ('')
      inputRef.current?.blur()
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

  return (
    <div
      className="tb-omni"
      ref={boxRef}
      data-action="palette.open"
      // 칸 어디를 눌러도 타이핑을 시작할 수 있어야 한다(돋보기·여백을 눌렀을 때도).
      // **여는 것도 여기서** 한다 — 아래 input 의 onFocus 가 아니라(그 이유는 onChange 위 주석).
      onClick={() => {
        inputRef.current?.focus()
        onOpen()
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
        /**
         * 2026-09-02 준영님 제보: *"Ctrl+Shift+I 로 콘솔을 키고 다시 끄면 왜 F1 즉 검색 리스트가
         * 계속 켜지는 거야?"*
         *
         * 여기 있던 `onFocus={onOpen}` 이 원인이다 — **"칸에 포커스가 있다" 를 "목록이 열렸다"로
         * 읽고 있었다.** 그런데 이 칸은 문서에서 **처음 나오는 포커스 가능한 요소**이고, 포커스는
         * 우리가 주지 않아도 온다: 창이 다시 활성화될 때 브라우저가 마지막 포커스를 되돌려 주고,
         * DevTools 를 닫는 그 순간이 정확히 그 자리다(Alt+Tab 으로 돌아올 때도 같다).
         * 그래서 콘솔을 여닫을 때마다 **한 번씩** 목록이 켜졌다(반복 루프가 아니라 토글 1회당 1회다).
         *
         * ⚠️ 어제 고친 `9abcfa4` 는 **떠 있는 목록의 위치**였고 이건 **열리는 것 자체**라 다른
         * 문제다. 위 useLayoutEffect 의 resize 리스너는 `open` 일 때만 붙고 `setDrop` 만 하므로
         * 이 증상과 무관하다(그것까지 확인했다).
         *
         * 여는 계기를 **사람의 뜻**으로 좁힌다: 칸을 누르거나(위 onClick), 치거나(여기), F1
         * (Shell 의 keydown → open → 아래 이펙트가 포커스를 준다). 브라우저가 되돌려 준 포커스는
         * 그중 어느 것도 아니다.
         */
        onChange={(e) => {
          setQ(e.target.value)
          onOpen()
        }}
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
      <kbd className="tb-omni-key kbd">F1</kbd>

      {open && drop && (
        <div
          className="cp-drop"
          style={{ left: drop.left, top: drop.top, width: drop.width }}
          // 항목을 누를 때 입력칸이 먼저 포커스를 잃으면(onBlur → 닫힘) 클릭이 도착하기도 전에
          // 목록이 사라진다. mousedown 을 막아 포커스를 붙잡아 둔다.
          onMouseDown={(e) => e.preventDefault()}
          // 목록은 검색 상자 **안에** 그려진다(position:fixed 라 눈에는 아래로 떨어져 보인다).
          // 그래서 항목 클릭이 상자의 onClick 까지 올라가 pick() 이 방금 닫은 목록을 다시 연다 —
          // 여기서 끊는다(빈 목록·안내줄을 눌렀을 때도 같다).
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cp-list" ref={listRef}>
            {shown.length === 0 && <div className="cp-empty">{t('palette.empty')}</div>}
            {groups.map((g) => (
              <div key={g.kind}>
                <div className="cp-group">{t(PALETTE_GROUPS.find((x) => x.kind === g.kind)!.key)}</div>
                {g.items.map((item) => {
                  const i = ordered.indexOf(item)
                  return (
                    <div
                      key={item.id}
                      className={'cp-item' + (i === cursor ? ' on' : '')}
                      data-item={item.id}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => pick(i)}
                    >
                      <span className="cp-label">{item.label}</span>
                      {item.off && (
                        <span className="cp-off">
                          {t(item.off.byDefault ? 'palette.off.default' : 'palette.off')}
                        </span>
                      )}
                      {item.hint && <span className="cp-hint">{item.hint}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="cp-foot">{t('palette.hint')}</div>
        </div>
      )}
    </div>
  )
}
