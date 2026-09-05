// 앱 전역 툴팁 — OS 기본 툴팁을 우리 것으로 갈아끼운다.
//
// 왜 바꿨나(준영님 지적, 2026-08-09): 브라우저 기본 툴팁은 **커서 오른쪽 아래**에 뜬다. 커서가
// 글자를 덮어 읽기 어렵고, 색·모서리·글꼴이 OS 것이라 앱과 따로 논다.
//
// 왜 전역 위임인가: `title` 속성이 89곳에 흩어져 있다. 컴포넌트를 하나씩 고치는 대신 document 에서
// 한 번 가로챈다 — 새로 추가되는 `title` 도 자동으로 이 경로를 탄다(고쳐야 할 목록이 안 생긴다).
//
// 네이티브를 어떻게 막나: hover 순간 `title` 을 떼어 `data-tip` 으로 옮긴다. 속성이 없으면 OS 는
// 툴팁을 띄우지 않는다. 되돌려 놓지 않는 게 핵심이다 — 되돌리면 다음 hover 때 OS 것이 다시 뜬다.
// React 가 리렌더하며 `title` 을 다시 붙여도 다음 hover 에서 또 떼면 그만이다(네이티브는 500ms 쯤
// 기다렸다 뜨는데 우리는 mouseover 즉시 떼므로 깜빡임도 없다).

/** 표시까지 기다리는 시간. 지나가다 스치는 것마다 뜨면 소음이다. */
const SHOW_DELAY_MS = 450
/** 요소와 툴팁 사이 간격. */
const GAP = 6
/** 화면 가장자리에서 이만큼은 띄운다. */
const EDGE = 8

export type TipParts = { text: string; key: string | null }

/**
 * 툴팁 문구에서 **끝에 붙은** 단축키만 뱃지로 분리한다.
 *
 * 끝에 있는 것만 보는 이유: 문장 속의 조합키는 설명의 일부다. "원격에서 Ctrl+V 로 붙여넣으세요"
 * 에서 Ctrl+V 를 뱃지로 떼면 문장이 부서진다. 반대로 "탐색기 닫기 (Ctrl+Shift+O)" 의 괄호는
 * 순전히 단축키 표기라 뱃지가 맞다.
 */
export function splitTip(raw: string): TipParts {
  const text = raw.trim()
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(text)
  if (!m) return { text, key: null }
  const inner = m[2].trim()
  // 조합키처럼 생겼을 때만. "탐색기 닫기 (실험)" 같은 괄호는 그대로 문장에 남는다.
  const looksLikeKey = /^(Ctrl|Alt|Shift|Meta|Cmd|⌘|⌥|⇧|F\d{1,2})(\s*\+\s*\S+)*$/i.test(inner)
  return looksLikeKey ? { text: m[1], key: inner } : { text, key: null }
}

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
export type Placed = { x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' }

/**
 * 툴팁 자리 — **요소 기준**이다(커서 기준이 아니라). 커서에 가리지 않는 이유가 이것뿐이다.
 *
 * 좌우를 먼저 본다(2026-08-10 준영님 요청). 아래로 붙이면 세로로 늘어선 아이콘 바에서 **바로 밑
 * 아이콘을 덮는다** — 그러면 다음 아이콘으로 마우스를 옮기는 길이 툴팁에 막힌 것처럼 보인다.
 * 좌우는 그 줄에 아무것도 없으니 무엇도 가리지 않는다. 이 우선순위를 뒤집지 마라.
 *
 * 위/아래는 **좌우가 둘 다 안 되는 앵커**만을 위한 폴백이다(2026-09-05 준영님 제보). 표 한 줄처럼
 * 패널 폭을 통째로 쓰는 앵커는 좌우 여유가 둘 다 tipW 에 못 미치는데, 예전엔 그래도 좌우 중 넓은
 * 쪽에 붙이고 화면 안으로 밀었다 — 밀린 끝이 EDGE(8) 라 툴팁이 **화면 왼쪽 끝**에 가서 붙었다.
 * 앵커에서 멀찍이 떨어진 곳에 뜨니 어느 줄의 설명인지 알 수 없었다. 아이콘 바는 앵커가 좁아
 * 이 가지에 애초에 안 들어온다(회귀 가드가 tests/tooltip.test.ts 에 있다).
 *
 * 세로는 좌우로 붙일 땐 요소 가운데, 위/아래로 붙일 땐 요소 바로 바깥. 둘 다 화면 안으로 민다.
 */
export function placeTip(anchor: Rect, tipW: number, tipH: number, viewW: number, viewH: number): Placed {
  const clampX = (v: number): number => Math.min(Math.max(v, EDGE), Math.max(EDGE, viewW - tipW - EDGE))
  const clampY = (v: number): number => Math.min(Math.max(v, EDGE), Math.max(EDGE, viewH - tipH - EDGE))

  const roomRight = viewW - anchor.right - GAP - EDGE
  const roomLeft = anchor.left - GAP - EDGE

  if (roomRight < tipW && roomLeft < tipW) {
    // 위를 먼저 보는 이유: 아래는 다음 줄(표에서는 바로 아래 행)을 덮는데, 마우스가 그리로 내려가는
    // 중이라면 방금 뜬 툴팁이 길을 막는다. 위가 모자랄 때만 아래로 간다.
    const side: 'top' | 'bottom' = anchor.top - GAP - EDGE >= tipH ? 'top' : 'bottom'
    const rawY = side === 'top' ? anchor.top - GAP - tipH : anchor.bottom + GAP
    // 가로는 앵커 왼쪽 끝에 맞춘다 — 넓은 앵커의 가운데에 맞추면 잘린 글자의 시작점에서 멀어진다.
    return { x: clampX(anchor.left), y: clampY(rawY), side }
  }

  // 여기 왔다는 건 한쪽은 tipW 가 들어간다는 뜻이다 — 그러니 오른쪽이 안 되면 왼쪽은 반드시 된다.
  const side: 'left' | 'right' = roomRight >= tipW ? 'right' : 'left'
  const rawX = side === 'right' ? anchor.right + GAP : anchor.left - GAP - tipW
  return { x: clampX(rawX), y: clampY(anchor.top + anchor.height / 2 - tipH / 2), side }
}

export type Measured = { text: string; scrollW: number; clientW: number }
export type Pick =
  | { kind: 'anchor'; index: number }
  | { kind: 'skip' }
  | { kind: 'asIs' }

/**
 * 이 `title` 을 띄울 것인가, 띄운다면 무엇에 붙일 것인가.
 *
 * 왜 필요한가(2026-09-05 준영님 제보): 화면에 다 보이는 글자에까지 툴팁이 떴다. `title` 이 그리는
 * 글자와 같은 말이면 툴팁은 아무것도 더 알려 주지 않는다 — **잘렸을 때만** 값이 있다.
 *
 * 왜 DOM 을 안 받나: vitest 환경이 `node` 다(vitest.config.ts). 판단만 떼어 놓으면 jsdom 없이
 * 검사할 수 있다. **여기에 Element 를 들이지 마라** — 들이는 순간 이 규칙은 검사 밖으로 나간다.
 *
 * 🔴 `asIs` 가 이 함수의 존재 이유다. `title` 대부분(89곳)은 아이콘 버튼의 이름이나 설명문이라
 * 화면에 같은 글자가 아예 없다. 그것까지 `skip` 으로 묶으면 툴팁 기능을 통째로 죽인다.
 *
 * `+1` 여유는 서브픽셀 반올림 때문이다. 0 으로 두면 안 잘린 셀이 잘렸다고 나온다.
 */
export function pickCut(tip: string, cands: Measured[]): Pick {
  const want = tip.trim()
  let sawSame = false
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].text.trim() !== want) continue
    sawSame = true
    if (cands[i].scrollW > cands[i].clientW + 1) return { kind: 'anchor', index: i }
  }
  return sawSame ? { kind: 'skip' } : { kind: 'asIs' }
}

let host: HTMLDivElement | null = null
let timer: number | null = null
let current: Element | null = null

function ensureHost(): HTMLDivElement {
  if (host && host.isConnected) return host
  host = document.createElement('div')
  host.className = 'ara-tip'
  host.setAttribute('role', 'tooltip')
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)
  return host
}

function hide(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  current = null
  if (host) host.classList.remove('on')
}

function show(el: Element, raw: string): void {
  // 🔴 재는 시점이 여기인 게 중요하다 — 450ms 지연이 **끝난 뒤**다. onOver 에서 재면 표 위를
  // 마우스로 훑을 때마다 scrollWidth 가 강제 리플로를 부른다(행마다 한 번씩). 지금 그 소음이
  // 없는 이유가 이 자리다. 여기로 내려온 요소는 사람이 450ms 머문 하나뿐이다.
  //
  // 자손까지 보는 이유: `title` 은 줄 전체(<tr>)에 붙는데 글자를 그리고 잘라 내는 건 그 안의
  // 셀(<td>)이다(ProcessTable.tsx). 형제 표들도 같은 모양이라 el 만 재면 늘 "안 잘렸다"가 나온다.
  const cands = [el, ...Array.from(el.querySelectorAll('*'))]
  const pick = pickCut(
    raw,
    cands.map((c) => ({ text: c.textContent ?? '', scrollW: c.scrollWidth, clientW: c.clientWidth }))
  )
  // 다 보이는 글자다. host 를 안 켠다 — `title` 은 이미 data-tip 으로 옮겨졌으니 OS 툴팁도 안 뜬다.
  if (pick.kind === 'skip') return
  // 잘린 셀을 찾았으면 **그 셀**이 앵커다. 줄 전체를 앵커로 두면 폭이 패널만 해서 좌우에 자리가 없다.
  const at = pick.kind === 'anchor' ? cands[pick.index] : el

  const h = ensureHost()
  const { text, key } = splitTip(raw)
  h.textContent = ''
  h.appendChild(document.createTextNode(text))
  if (key) {
    const b = document.createElement('span')
    b.className = 'ara-tip-k'
    b.textContent = key
    h.appendChild(b)
  }
  // 크기를 재려면 먼저 보여야 한다 — 화면 밖에 두고 재고 나서 제자리로 옮긴다(깜빡임 없음).
  h.style.left = '-9999px'
  h.style.top = '0px'
  h.classList.add('on')
  const r = at.getBoundingClientRect()
  const p = placeTip(r, h.offsetWidth, h.offsetHeight, window.innerWidth, window.innerHeight)
  h.style.left = `${Math.round(p.x)}px`
  h.style.top = `${Math.round(p.y)}px`
}

/** 이 요소가 보여 줄 문구. `title` 이 있으면 떼어 `data-tip` 으로 옮긴다(네이티브 억제). */
function tipTextOf(el: Element): string | null {
  const title = el.getAttribute('title')
  if (title !== null) {
    el.removeAttribute('title')
    if (title.trim() === '') {
      el.removeAttribute('data-tip')
      return null
    }
    el.setAttribute('data-tip', title)
    return title
  }
  const kept = el.getAttribute('data-tip')
  return kept && kept.trim() !== '' ? kept : null
}

function onOver(e: Event): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const el = target.closest('[title], [data-tip]')
  if (!el) {
    if (current) hide()
    return
  }
  const text = tipTextOf(el)
  if (!text) {
    if (current) hide()
    return
  }
  if (el === current) return
  hide()
  current = el
  timer = window.setTimeout(() => {
    timer = null
    // 기다리는 사이 요소가 사라졌을 수 있다(목록 갱신 등).
    if (current === el && el.isConnected) show(el, text)
  }, SHOW_DELAY_MS)
}

// 스크롤·클릭·타이핑 중에 떠 있으면 방해만 된다. 자리도 어긋난다(위치를 요소 기준으로 잡아 뒀다).
const onAway = (): void => hide()

/**
 * 요소 밖으로 나갔을 때 숨긴다.
 *
 * `mouseleave` 를 캡처로 듣지 않는 이유: mouseleave 는 버블하지 않지만 **캡처 단계에서는 document 도
 * 받는다**. 그래서 아이콘 안의 자식 요소(svg 등)를 지나가기만 해도 숨김이 걸려 툴팁이 깜빡인다.
 * `mouseout` 은 버블하므로 relatedTarget 으로 "정말 밖으로 나갔는지"를 볼 수 있다.
 */
function onOut(e: MouseEvent): void {
  if (!current) return
  const to = e.relatedTarget
  // relatedTarget 이 null 이면 창 밖으로 나간 것이다.
  if (to instanceof Node && current.contains(to)) return
  hide()
}

let installed = false

/** 앱이 뜰 때 한 번. 보조 창(편집기·다중 모니터)도 같은 번들이라 각자 자기 document 에 건다. */
export function installTooltips(): () => void {
  if (installed) return () => undefined
  installed = true
  document.addEventListener('mouseover', onOver, true)
  document.addEventListener('mouseout', onOut, true)
  document.addEventListener('mousedown', onAway, true)
  document.addEventListener('keydown', onAway, true)
  window.addEventListener('scroll', onAway, true)
  window.addEventListener('blur', onAway)
  return () => {
    installed = false
    document.removeEventListener('mouseover', onOver, true)
    document.removeEventListener('mouseout', onOut, true)
    document.removeEventListener('mousedown', onAway, true)
    document.removeEventListener('keydown', onAway, true)
    window.removeEventListener('scroll', onAway, true)
    window.removeEventListener('blur', onAway)
    hide()
    host?.remove()
    host = null
  }
}
