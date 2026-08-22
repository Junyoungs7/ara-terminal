import { useEffect, useRef, useState } from 'react'

// 디자인 시스템 드롭다운 — 네이티브 <select> 대체(앱 내 유일한 셀렉트 컴포넌트).
// 네이티브 팝업은 OS 크롬으로 그려져 앱 테마와 어긋나므로 쓰지 않는다.
// 키보드: ↑↓ 이동 / Enter·Space 열기·선택 / ESC 닫기. 스타일은 .fld input 과 동일 톤(styles/shell.css).
//
// R6 editable: 콤보 입력(기존 그룹 고르기 + 새 그룹 타이핑). 목록이 고정 배열이 아니게 되면서
// "없는 값은 못 고른다"가 곧 "새 그룹을 만들 수 없다"가 됐다. 새 컴포넌트를 만드는 대신
// 값 표시부만 입력칸으로 바꾼다 — 목록·키보드·바깥클릭 동작은 그대로다.
//
// FB-dropdown: 목록(.dd-list)은 스크롤 가능한 부모(예: 연결 관리자 .prof-form, overflow-y:auto)
// 안에 있으면 position:absolute 로는 그 부모 경계에서 잘려 버튼 뒤로 사라진다. 뷰포트 기준
// position:fixed 로 좌표를 직접 계산해 붙인다(포털 없이 — .dd-list 는 DOM 은 그대로, CSS/좌표만
// 바뀐다. overflow:hidden/auto 조상은 fixed 자손을 클리핑하지 않음을 실측 확인함).
const DD_LIST_MAX_H = 240 // styles/shell.css .dd-list max-height 와 맞춘다
/**
 * 아래로 열 때 최소한 이만큼은 보여야 한다. 이보다도 좁으면 그때만 위로 뒤집는다.
 * 2026-08-22 준영님 제보 1번("그룹칸의 리스트가 위로 뜨는데 아래로 뜨게"): 예전엔 240px 이
 * 안 나오면 무조건 위로 뒤집었는데, 연결 관리자의 그룹 칸은 폼 아래쪽이라 **늘** 그 조건에
 * 걸렸다. 목록은 스크롤되므로 240 이 다 필요하지 않다 — 세 줄쯤 보이면 고를 수 있다.
 */
const DD_MIN_H = 96

// 뷰포트 기준 목록 배치(순수 — 단위 테스트 대상). vh: 뷰포트 높이(bottom 앵커링 계산용, position:fixed
// 는 뷰포트 기준). belowBoundary: 아래쪽 "시각적" 경계 — 기본은 뷰포트 자체지만, 스크롤 부모가 있으면
// 그 바닥을 넘겨받는다(연결 관리자에서 그룹 필드가 폼의 마지막 행이면 뷰포트 기준 "아래 여유"는
// 넉넉해도 실제로는 모달 푸터를 그대로 덮어 버튼이 안 보이던 문제의 원인이었다).
// 아래 공간이 모자라고 위가 더 넓으면 위로 연다(flip).
export function placeDropdown(
  anchor: { left: number; right: number; top: number; bottom: number },
  vh: number,
  belowBoundary: number = vh
): { left: number; width: number; top?: number; bottom?: number; maxHeight: number } {
  const spaceBelow = belowBoundary - anchor.bottom - 4
  const spaceAbove = anchor.top - 4
  // **아래가 기본이다.** 아래가 최소치(DD_MIN_H)도 안 되고 위가 더 넓을 때만 뒤집는다.
  // 넘치는 만큼은 목록 높이를 줄여 흡수한다(스크롤) — 그래야 모달 푸터 버튼을 덮지 않으면서도
  // 아래로 열린다. 예전엔 이 자리에서 바로 위로 뒤집어 그룹 칸이 늘 위로 떴다(제보 1번).
  const openUp = spaceBelow < DD_MIN_H && spaceAbove > spaceBelow
  const room = openUp ? spaceAbove : spaceBelow
  return {
    left: anchor.left,
    width: anchor.right - anchor.left,
    maxHeight: Math.min(DD_LIST_MAX_H, Math.max(DD_MIN_H, room)),
    ...(openUp ? { bottom: vh - anchor.top + 4 } : { top: anchor.bottom + 4 })
  }
}

// 앵커의 실제 시각적 아래 경계: 조상 중 overflow(auto/hidden/scroll)로 잘리는 가장 가까운
// 스크롤 컨테이너의 바닥. 없으면 뷰포트 바닥(기존 동작 — 예: 사이드바 패널 헤더의 콤보).
function belowClipBoundary(el: HTMLElement | null): number {
  let node = el?.parentElement ?? null
  while (node) {
    const cs = getComputedStyle(node)
    if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') return node.getBoundingClientRect().bottom
    node = node.parentElement
  }
  return window.innerHeight
}

type Props = {
  value: string
  options: string[]
  onChange: (v: string) => void
  ariaLabel?: string
  editable?: boolean
  placeholder?: string
}

type Pos = { left: number; width: number; top?: number; bottom?: number; maxHeight: number }

export function Dropdown({ value, options, onChange, ariaLabel, editable, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 열기: 목록을 그리기 전에 앵커(.dd) 위치를 재서 뷰포트 기준 좌표를 정한다.
  const openList = () => {
    const r = rootRef.current?.getBoundingClientRect()
    if (r) setPos(placeDropdown(r, window.innerHeight, belowClipBoundary(rootRef.current)))
    setOpen(true)
  }

  // 타이핑 중에는 입력값으로 목록을 좁힌다. 값이 이미 목록에 있으면(= 골라 둔 상태) 전부 보여 준다 —
  // 안 그러면 고른 직후 다른 그룹으로 바꿀 수가 없다.
  const shown =
    editable && value && !options.includes(value)
      ? options.filter((o) => o.toLowerCase().includes(value.toLowerCase()))
      : options

  // 열 때 현재 값에 하이라이트를 맞춘다(네이티브 select 동작과 동일).
  useEffect(() => {
    if (open) setIdx(Math.max(0, shown.indexOf(value)))
    // shown 은 매 렌더 새 배열이라 deps 에 넣으면 하이라이트가 매번 초기화된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options, value])

  // 바깥 클릭으로 닫기.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // position:fixed 목록은 스크롤을 따라가지 않는다 — 열린 채로 두면 앵커와 어긋나므로 닫는다
  // (부모 스크롤 컨테이너 포함 — capture 로 어느 스크롤이든 잡는다).
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openList()
        return
      }
      const d = e.key === 'ArrowDown' ? 1 : -1
      setIdx((i) => (shown.length ? (i + d + shown.length) % shown.length : 0))
    } else if (e.key === 'Enter' || (e.key === ' ' && !editable)) {
      // 입력 모드에서 Space 는 그룹 이름의 공백이다 — 선택 키로 쓰지 않는다.
      e.preventDefault()
      if (open) pick(shown[idx] ?? value)
      else openList()
    }
  }

  const caret = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )

  return (
    <div className={'dd' + (open ? ' open' : '') + (editable ? ' editable' : '')} ref={rootRef}>
      {editable ? (
        <div className="dd-btn">
          <input
            className="dd-input"
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value)
              openList()
            }}
            onFocus={openList}
            onKeyDown={onKey}
          />
          <span
            className="dd-caret"
            onMouseDown={(e) => e.preventDefault()} // 입력 포커스를 뺏지 않는다.
            onClick={() => (open ? setOpen(false) : openList())}
          >
            {caret}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="dd-btn"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onKey}
        >
          <span className="dd-val">{value}</span>
          {caret}
        </button>
      )}
      {open && shown.length > 0 && pos && (
        <div
          className="dd-list"
          role="listbox"
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
        >
          {shown.map((o, i) => (
            <div
              key={o}
              role="option"
              aria-selected={o === value}
              className={'dd-opt' + (o === value ? ' sel' : '') + (i === idx ? ' cur' : '')}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
