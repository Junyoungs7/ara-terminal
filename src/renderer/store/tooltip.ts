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
export type Placed = { x: number; y: number; side: 'left' | 'right' }

/**
 * 툴팁 자리 — **요소 기준**이다(커서 기준이 아니라). 커서에 가리지 않는 이유가 이것뿐이다.
 *
 * 좌우로 붙인다(2026-08-10 준영님 요청). 아래로 붙이면 세로로 늘어선 아이콘 바에서 **바로 밑
 * 아이콘을 덮는다** — 그러면 다음 아이콘으로 마우스를 옮기는 길이 툴팁에 막힌 것처럼 보인다.
 * 좌우는 그 줄에 아무것도 없으니 무엇도 가리지 않는다.
 *
 * 고르는 규칙: 오른쪽에 들어가면 오른쪽, 아니면 왼쪽. 양쪽 다 좁으면 **넓은 쪽**에 붙이고 화면
 * 안으로 민다(어느 쪽이든 잘리느니 덜 잘리는 쪽이 낫다). 세로는 요소 가운데에 맞추고 화면 안으로 민다.
 */
export function placeTip(anchor: Rect, tipW: number, tipH: number, viewW: number, viewH: number): Placed {
  const roomRight = viewW - anchor.right - GAP - EDGE
  const roomLeft = anchor.left - GAP - EDGE
  const side: 'left' | 'right' = roomRight >= tipW || roomRight >= roomLeft ? 'right' : 'left'

  const rawX = side === 'right' ? anchor.right + GAP : anchor.left - GAP - tipW
  const x = Math.min(Math.max(rawX, EDGE), Math.max(EDGE, viewW - tipW - EDGE))

  const centered = anchor.top + anchor.height / 2 - tipH / 2
  const y = Math.min(Math.max(centered, EDGE), Math.max(EDGE, viewH - tipH - EDGE))
  return { x, y, side }
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
  const r = el.getBoundingClientRect()
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
