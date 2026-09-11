import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

// 컴팩트 컨텍스트 메뉴 (F4c — .sp-* 오버레이와 같은 표면·헤어라인·등장 애니메이션).
// 앱 전체에서 이 컴포넌트 하나만 쓴다: 사이드바 트리 우클릭, 탭바 ＋ 메뉴.
// 항목 정의는 호출측이 넘긴다(액션 레지스트리의 id + 라벨) — 메뉴는 배치·키보드·닫기만 책임진다.

// icon/hint 는 터미널 메뉴(아이콘 + 단축키)에서만 쓰고, 트리 메뉴는 라벨만 넣는다.
export type MenuItem = {
  id: string
  label: string
  danger?: boolean
  icon?: ReactNode
  hint?: string
  dim?: boolean // 미래 기능(로그 저장·AI) — 눌리되 "추후 지원" 안내
  disabled?: boolean // FB-monitor: 정보 전용 행(로딩·상태 안내) — 클릭·Enter 모두 무시
  /**
   * 행에 붙는 설명(전역 툴팁이 받는다 — store/tooltip.ts 가 `[title]` 을 위임으로 가로챈다).
   * 버튼을 메뉴로 접으면 버튼이 달고 있던 툴팁이 함께 사라진다 — **왜 비활성인지**처럼
   * hint 한 칸에 안 들어가는 말이 그때 없어진다(2026-09-01 RDP 툴바). 접는 쪽이 그 말을 여기 옮긴다.
   */
  title?: string
  // FB-monitor(F19 tmux): 1단계 서브메뉴(호버로 열림). 중첩은 이 한 단계만 지원한다.
  submenu?: readonly MenuItem[]
}

// 배치 계산에 쓰는 메뉴 실측 치수(styles/interactions.css .ctx-menu 와 일치).
const MENU_W = 224
const ROW_H = 29
const MENU_PAD = 10
// 화면 가장자리에서 띄울 거리. 2026-08-22 준영님 제보 24번("가장 마지막 파일 우클릭했을 때 나오는
// 리스트가 하단에 딱 붙어있음")으로 8 → 14 로 키웠다. 파일 메뉴는 항목이 스무 개가 넘어(높이 600px
// 남짓) 목록 아래쪽에서 열면 늘 상한에 걸리는데, 그때 남는 8px 은 붙은 것으로 보인다.
export const MENU_EDGE = 14
const EDGE = MENU_EDGE

// 뷰포트 경계 안으로 보정한 좌표(순수 — 단위 테스트 대상). 높이는 항목 수로 산출한다.
export function clampMenu(
  x: number,
  y: number,
  count: number,
  vw: number,
  vh: number
): { left: number; top: number } {
  // 화면보다 긴 메뉴는 위치로 못 구한다(파일 메뉴는 항목이 열넷이다) — 그때는 위에 붙이고
  // 나머지는 CSS 의 max-height + 스크롤이 받는다. 여기서는 **넘치지 않는 경우**만 정확히 잡는다.
  const h = Math.min(count * ROW_H + MENU_PAD, vh - EDGE * 2)
  return {
    left: Math.max(EDGE, Math.min(x, vw - MENU_W - EDGE)),
    top: Math.max(EDGE, Math.min(y, vh - h - EDGE))
  }
}

/**
 * 서브메뉴 자리 — 부모 **옆**에 붙인다(순수 — 단위 테스트 대상).
 *
 * 2026-09-02 준영님(RDP): *"리스트가 겹쳐서 보여서 이전으로 리스트가 가려지고 있어."* 가로 자리를
 * `clampMenu` 로 구한 것이 원인이었다 — 그건 **뷰포트 안으로 밀어 넣는** 함수라, 부모가 이미
 * 오른쪽 상한(`vw - MENU_W - EDGE`)에 서 있으면 `부모 + MENU_W` 를 같은 값으로 되밀어 부모를
 * 정확히 덮는다. 서브메뉴 자체는 처음부터 있었고(F19 tmux) 우클릭 메뉴는 커서 자리에 열려
 * 어쩌다 걸렸을 뿐인데, RDP [옵션] 은 헤더 오른쪽 끝이라 **항상** 그 조건이다.
 *
 * 그래서 가로는 밀지 않고 **뒤집는다**: 오른쪽에 한 장이 안 들어가면 부모 왼쪽에 붙인다.
 * 세로는 미는 것이 맞다 — 위아래로 밀려도 부모를 가리지 않는다.
 */
export function submenuPos(
  parent: { left: number; top: number },
  index: number,
  count: number,
  vw: number,
  vh: number
): { left: number; top: number } {
  const right = parent.left + MENU_W
  // 뷰포트가 메뉴 두 장 + 여백(462px)보다 좁으면 어디에 놔도 겹친다 — 그때는 왼쪽 가장자리에
  // 붙인다(화면 밖으로 내보내는 쪽이 더 나쁘다).
  const left = right + MENU_W + EDGE <= vw ? right : Math.max(EDGE, parent.left - MENU_W)
  return { left, top: clampMenu(parent.left, parent.top + index * ROW_H, count, vw, vh).top }
}

type Props = {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  onPick: (id: string) => void
  onClose: () => void
}

export function ContextMenu({ open, x, y, items, onPick, onClose }: Props) {
  const [idx, setIdx] = useState(0)
  /**
   * 메뉴를 열기 **직전에** 포커스가 있던 자리. 고르지 않고 닫을 때 여기로 돌려준다.
   *
   * 왜 필요한가(2026-09-10 준영님 제보): *"터미널창에서 붙여넣기 위해 우클릭하고 붙여넣기
   * 안하기 위해서 그냥 다시 터미널창을 클릭하면 터미널 창에 바로 텍스트가 작성되야하는데
   * 작성이 안되서 다시 터미널 창을 클릭해야해."*
   *
   * 원인은 **backdrop 이 그 클릭을 먹는 것**이다. 메뉴가 열려 있는 동안 화면 전체를 덮는
   * `.ctx-backdrop` 이 있고, 터미널을 누른 줄 알았던 그 mousedown 은 사실 backdrop 이 받는다.
   * backdrop 은 focusable 이 아니라 크로미움이 포커스를 `<body>` 로 옮기고, 그 사이 backdrop 은
   * 사라진다 — 터미널은 클릭당한 적이 없으니 포커스가 없다. 그래서 한 번 더 눌러야 했다.
   */
  const prevFocus = useRef<HTMLElement | null>(null)
  // FB-monitor(F19 tmux): 서브메뉴를 열고 있는 상위 항목 인덱스(마우스 호버로만 연다 — 중첩 1단계).
  const [subIdx, setSubIdx] = useState<number | null>(null)

  useEffect(() => {
    if (open) {
      setIdx(0)
      setSubIdx(null)
    }
  }, [open, x, y])

  // 열리는 순간의 포커스를 잡아 둔다. x·y 는 안 본다 — 같은 메뉴를 옮겨 여는 동안(서브메뉴 등)
  // 다시 잡으면 이미 body 로 넘어간 뒤라 돌려줄 자리를 잃는다.
  useEffect(() => {
    if (open) prevFocus.current = document.activeElement as HTMLElement | null
  }, [open])

  /**
   * **고르지 않고** 닫는다 — backdrop 클릭 · 바깥 우클릭 · ESC.
   * 항목을 고른 경우(onPick)는 여기 오지 않는다: 그 동작이 스스로 포커스를 옮길 수 있어
   * (모달·입력칸을 여는 항목이 있다) 되돌리면 서로 싸운다.
   */
  const closeRestoring = useCallback((e?: { preventDefault: () => void }) => {
    /**
     * 🔴 **기본 동작을 먼저 막는다**(2026-09-10 재제보: *"우클릭 후 다시 터미널창 클릭하면
     * 터미널 한번에 안눌림"* — 1.0.7 의 포커스 되돌리기만으로는 안 됐다).
     *
     * 아래 `el.focus()` 는 **mousedown 핸들러 안**에서 도는데, 포커스를 `<body>` 로 옮기는 것은
     * 그 핸들러가 끝난 **뒤에 일어나는 기본 동작**이다. 그래서 되돌려 놔도 브라우저가 곧바로
     * 다시 빼앗아 갔다 — 순서를 안 보고 고친 자리다.
     * `preventDefault` 로 그 기본 동작 자체를 막으면 **포커스가 애초에 안 움직인다.**
     * `focus()` 는 그래도 남긴다 — ESC 경로에는 막을 기본 동작이 없다.
     */
    e?.preventDefault()
    const el = prevFocus.current
    onClose()
    el?.focus?.()
  }, [onClose])

  // ↑↓ 이동 / →로 서브메뉴 열기 · ←로 닫기 / Enter 실행(서브메뉴가 있으면 열기) / ESC 닫기.
  // 캡처 단계로 잡아 뒤쪽 전역 단축키(ESC 등)와 겹치지 않게 한다.
  useEffect(() => {
    if (!open || items.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRestoring()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setIdx((i) => (i + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setIdx((i) => (i - 1 + items.length) % items.length)
      } else if (e.key === 'ArrowRight') {
        if (items[idx]?.submenu) {
          e.preventDefault()
          e.stopPropagation()
          setSubIdx(idx)
        }
      } else if (e.key === 'ArrowLeft') {
        if (subIdx !== null) {
          e.preventDefault()
          e.stopPropagation()
          setSubIdx(null)
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const it = items[idx]
        if (!it || it.disabled) return
        if (it.submenu) setSubIdx(idx)
        else onPick(it.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, items, idx, subIdx, onPick, onClose, closeRestoring])

  if (!open || items.length === 0) return null
  const pos = clampMenu(x, y, items.length, window.innerWidth, window.innerHeight)
  const subItems = subIdx !== null ? items[subIdx]?.submenu : undefined
  const subPos = subItems ? submenuPos(pos, subIdx!, subItems.length, window.innerWidth, window.innerHeight) : null

  return (
    <>
      <div
        className="ctx-backdrop"
        onMouseDown={(e) => closeRestoring(e)}
        onContextMenu={(e) => closeRestoring(e)}
      />
      <div className="ctx-menu open" style={{ left: pos.left, top: pos.top }} role="menu">
        {items.map((it, i) => (
          <div
            key={it.id}
            role="menuitem"
            data-action={it.id}
            {...(it.title ? { title: it.title } : {})}
            className={
              'ctx-item' +
              (it.danger ? ' danger' : '') +
              (it.dim ? ' dim' : '') +
              (it.disabled ? ' disabled' : '') +
              (it.submenu ? ' has-sub' : '') +
              (i === idx ? ' cur' : '')
            }
            onMouseEnter={() => {
              if (it.disabled) return
              setIdx(i)
              setSubIdx(it.submenu ? i : null)
            }}
            onClick={() => {
              if (it.disabled || it.submenu) return
              onPick(it.id)
            }}
          >
            {it.icon && <span className="ci-ic">{it.icon}</span>}
            <span className="ci-lbl">{it.label}</span>
            {it.hint && <span className="ci-kbd">{it.hint}</span>}
            {/* 트리 캐럿과 달리 **안 돌린다** — 펼침 상태가 아니라 "오른쪽에 더 있다"는 방향 표시다. */}
            {it.submenu && (
              <span className="ci-sub-arrow">
                <ChevronRight />
              </span>
            )}
          </div>
        ))}
      </div>
      {subItems && subPos && (
        <div className="ctx-menu open ctx-submenu" style={{ left: subPos.left, top: subPos.top }} role="menu">
          {subItems.map((sub) => (
            <div
              key={sub.id}
              role="menuitem"
              data-action={sub.id}
              {...(sub.title ? { title: sub.title } : {})}
              className={'ctx-item' + (sub.danger ? ' danger' : '') + (sub.disabled ? ' disabled' : '')}
              onClick={() => {
                if (sub.disabled) return
                onPick(sub.id)
              }}
            >
              {sub.icon && <span className="ci-ic">{sub.icon}</span>}
              <span className="ci-lbl">{sub.label}</span>
              {sub.hint && <span className="ci-kbd">{sub.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
