import { useCallback, type RefObject } from 'react'

// #82(2026-08-15) — 행 목록(트리·표·리스트)을 키보드로 훑는 공용 훅.
//
// 왜 컴포넌트마다 안 만드나: 클릭되는 행이 앱 전체에 70곳 넘게 흩어져 있다(사이드바 트리 ·
// 파일 목록 · 프로세스/서비스 표 · 그 밖 목록). 행마다 핸들러를 달면 그만큼 갈리고, 다음에
// 표가 하나 더 생기면 또 갈린다. **컨테이너 하나가 위임**받아 처리한다.
//
// 왜 role="button" 이 아닌가: #71 에서 진짜 버튼(런치패드 타일·창 버튼)은 `<button>` 으로 바꿨다.
// 하지만 **행은 버튼이 아니다** — 트리 행은 `treeitem`, 표 행은 `row`, 목록 행은 `option` 이다.
// 아무 데나 role="button" 을 붙이면 스크린 리더에게 거짓말이 되고, 그건 안 붙인 것보다 나쁘다.
//
// 포커스 방식(roving tabindex): 행은 전부 `tabIndex={-1}` 이고 **컨테이너만 Tab 정거장**이다.
// 행마다 Tab 이 서면 서버 20개짜리 트리에서 Tab 을 20번 눌러야 다음 영역으로 넘어간다.
//
// 아래 rowKeyAction 이 **판단 전부**를 갖는다(순수 함수 — tests/rowKeys.test.ts). 훅은 DOM 에서
// 값을 읽어 넘기고 결과를 집행할 뿐이다. 판단을 DOM 과 섞으면 jsdom 없이는 검사할 수 없다.

/** 키 하나에 대한 결정. 훅이 이대로 집행한다. */
export type RowAction =
  | { kind: 'none' }
  /** 이 인덱스의 행으로 포커스를 옮긴다(범위 밖이면 훅이 양끝으로 붙인다). */
  | { kind: 'focus'; index: number }
  /** 지금 행을 누른다. */
  | { kind: 'click' }
  /** 지금 행의 트위스티를 눌러 펼침/접힘을 뒤집는다 — 상태의 주인은 각 컴포넌트다. */
  | { kind: 'twisty' }

export type RowContext = {
  /** 지금 포커스가 있는 행의 인덱스(보이는 행들 기준). */
  cur: number
  /** 보이는 행 수. */
  count: number
  /** 지금 행의 aria-expanded. 펼칠 것이 없는 행은 null. */
  expanded: boolean | null
  /** →← 로 펼치고 접는 목록인가(트리 = true, 표·목록 = false). */
  tree: boolean
  /** 입력칸(검색·이름 편집) 안에서 눌렀는가 — 거기선 화살표가 커서 이동이다. */
  inInput: boolean
}

export function rowKeyAction(key: string, c: RowContext): RowAction {
  if (c.inInput || c.count === 0) return { kind: 'none' }
  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', index: c.cur + 1 }
    case 'ArrowUp':
      return { kind: 'focus', index: c.cur - 1 }
    case 'Home':
      return { kind: 'focus', index: 0 }
    case 'End':
      return { kind: 'focus', index: c.count - 1 }
    case 'Enter':
    case ' ':
      return { kind: 'click' }
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (!c.tree || c.expanded === null) return { kind: 'none' }
      const wantOpen = key === 'ArrowRight'
      // 이미 원하는 상태면 → 는 자식으로 내려가고, ← 는 그대로 둔다(다시 토글하지 않는다).
      if (c.expanded === wantOpen) return wantOpen ? { kind: 'focus', index: c.cur + 1 } : { kind: 'none' }
      return { kind: 'twisty' }
    }
    default:
      return { kind: 'none' }
  }
}

/** 지금 화면에 보이는 행들. display:none 인 것(접힌 그룹·숨은 탭)은 제외한다. */
function visibleRows(root: HTMLElement, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => el.offsetParent !== null)
}

function focusRow(rows: HTMLElement[], i: number): void {
  const el = rows[Math.max(0, Math.min(rows.length - 1, i))]
  el?.focus()
  el?.scrollIntoView({ block: 'nearest' })
}

export type RowKeysOptions = {
  /** 행을 고르는 선택자. 예: '[role="treeitem"]' · '[role="row"]' · '[role="option"]'. */
  selector: string
  /** 트위스티 선택자. 주면 트리(→← 로 펼침·접힘), 안 주면 표·목록. */
  twisty?: string
}

/** 컨테이너에 그대로 펼쳐 넣는다: `<div {...useRowKeys(ref, {...})}>`. */
export function useRowKeys(
  ref: RefObject<HTMLElement>,
  { selector, twisty }: RowKeysOptions
): { onKeyDown: (e: React.KeyboardEvent) => void; onFocus: (e: React.FocusEvent) => void; tabIndex: 0 } {
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const root = ref.current
      if (!root) return
      const t = e.target as HTMLElement
      const rows = visibleRows(root, selector)
      const row = t.closest<HTMLElement>(selector)
      const exp = row?.getAttribute('aria-expanded')

      const action = rowKeyAction(e.key, {
        cur: row ? rows.indexOf(row) : 0,
        count: rows.length,
        expanded: exp === undefined || exp === null ? null : exp === 'true',
        tree: Boolean(twisty),
        inInput: t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
      })
      if (action.kind === 'none') return
      e.preventDefault()
      if (action.kind === 'focus') focusRow(rows, action.index)
      else if (action.kind === 'click') row?.click()
      else if (twisty) row?.querySelector<HTMLElement>(twisty)?.click()
    },
    [ref, selector, twisty]
  )

  // 컨테이너로 Tab 이 들어오면 행으로 넘긴다 — 컨테이너에 머무르면 아무 것도 못 한다.
  const onFocus = useCallback(
    (e: React.FocusEvent) => {
      const root = ref.current
      if (!root || e.target !== root) return
      const rows = visibleRows(root, selector)
      const active = rows.findIndex((r) => r.classList.contains('active') || r.getAttribute('aria-selected') === 'true')
      focusRow(rows, active >= 0 ? active : 0)
    },
    [ref, selector]
  )

  return { onKeyDown, onFocus, tabIndex: 0 }
}
