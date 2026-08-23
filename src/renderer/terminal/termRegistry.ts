import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { CursorStyle } from '@shared/types'

// 세션별 xterm 인스턴스 레지스트리 — 우클릭 메뉴 '복사'(F4c) + F5 폰트 실시간 적용 + R3.2 검색.
// TerminalPane 이 mount 시 등록, unmount 시 해제. UI 상태가 아니므로 스토어가 아닌 모듈 맵으로 관리.
type Entry = { term: Terminal; fit: FitAddon; search: SearchAddon }
const terms = new Map<string, Entry>()

export function registerTerm(sessionId: string, entry: Entry): void {
  terms.set(sessionId, entry)
}
export function unregisterTerm(sessionId: string): void {
  terms.delete(sessionId)
}

// E2E 하네스 seam(__evPersist·__evAdopt 와 같은 패턴): 세션 xterm 의 실제 옵션을 읽고 선택을 만든다.
// 스크롤백·유니코드·ANSI 테마는 DOM 으로 확인할 방법이 없어 이 창구가 유일한 검증 경로다.
// 프로덕션에도 존재하나 아무도 호출하지 않는다.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __evTerm?: unknown }).__evTerm = (sessionId: string) => {
    const e = terms.get(sessionId)
    if (!e) return null
    return {
      scrollback: e.term.options.scrollback,
      cursorStyle: e.term.options.cursorStyle,
      cursorBlink: e.term.options.cursorBlink,
      windowsMode: e.term.options.windowsMode,
      unicode: e.term.unicode.activeVersion,
      theme: e.term.options.theme,
      selectAll: () => e.term.selectAll(),
      getSelection: () => e.term.getSelection(),
      // WebGL 렌더러가 붙으면 화면 내용이 canvas 로 가서 DOM textContent 가 비어 있다.
      // 렌더러 종류와 무관하게 버퍼를 읽는 유일한 경로.
      text: () => {
        const buf = e.term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
        return lines.join('\n')
      }
    }
  }
}
export function getSelection(sessionId: string): string {
  return terms.get(sessionId)?.term.getSelection() ?? ''
}

// F11: 커서 왼쪽까지의 현재 줄(= 프롬프트 + 사용자가 친 것). 비밀번호 프롬프트 판정과
// 고스트 위치 맞추기에 쓴다 — 셸이 무엇을 물었는지는 화면에만 있고 입력 스트림에는 없다.
//
// 커서 뒤를 잘라 내는 것이 핵심이다: 셸이 글자를 지울 때(백스페이스·줄 다시 그리기) conpty 는
// 지운 자리를 공백으로 덮어쓴다. 그 공백은 "쓰인 셀"이라 translateToString(true) 도 지우지 않아,
// 줄 전체를 보면 사용자가 친 내용으로 끝나지 않는다(백스페이스 한 번에 고스트가 죽던 원인).
export function lineBeforeCursor(sessionId: string): string {
  const e = terms.get(sessionId)
  if (!e) return ''
  const buf = e.term.buffer.active
  // trimRight=false — 사용자가 끝에 친 공백('npm run ')도 그대로 살려야 접두 비교가 맞는다.
  return buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false, 0, buf.cursorX) ?? ''
}

// F15 미니 프리뷰: 세션 버퍼의 마지막 n 줄(꼬리의 빈 줄은 건너뛴다).
// 캔버스 캡처가 아니라 텍스트다 — WebGL 캔버스를 세션 수만큼 복사하면 GPU 메모리를 그만큼 먹고,
// 소프트웨어 래스터 환경(canUseWebgl=false)에서는 프레임을 통째로 잡아먹는다.
export function tailLines(sessionId: string, n: number): string[] {
  const e = terms.get(sessionId)
  if (!e) return []
  const buf = e.term.buffer.active
  const out: string[] = []
  for (let i = buf.baseY + e.term.rows - 1; i >= 0 && out.length < n; i--) {
    const text = buf.getLine(i)?.translateToString(true) ?? ''
    if (out.length === 0 && !text.trim()) continue
    out.push(text)
  }
  return out.reverse()
}

/**
 * 미니 프리뷰용 **색 있는** 꼬리 (2026-08-22 준영님 제보 20번: "실제 터미널처럼 텍스트 색상이
 * 다양했으면 좋겠어. 지금은 그냥 전부 하얀색이라 가독성이 떨어져").
 *
 * 셀마다 span 을 만들면 카드 하나에 수백 개다(6줄 × 80칸). **같은 색이 이어지는 구간으로 묶으면**
 * 줄당 두어 개로 떨어진다 — 실제 터미널 출력은 색이 자주 바뀌지 않는다(프롬프트·경로·에러 정도).
 * 1.5초 주기로 세션 수만큼 돌아도 부담이 없는 이유가 그것이다.
 *
 * 색은 **xterm 팔레트 인덱스**로만 넘긴다(0~255). 실제 색 문자열로 바꾸는 일은 화면 쪽이 CSS 변수로
 * 한다 — 여기서 getComputedStyle 을 부르면 셀마다 레이아웃을 건드리게 된다.
 * mode 2(24bit RGB)는 인덱스가 아니라 색값이라 그대로 담고, 기본색(mode 0)은 undefined 로 둔다
 * (그 자리는 화면의 기본 글자색이 맡는다).
 */
export type TailSeg = { text: string; fg?: number; rgb?: boolean; bold?: boolean }

export function tailSegs(sessionId: string, n: number): TailSeg[][] {
  const e = terms.get(sessionId)
  if (!e) return []
  const buf = e.term.buffer.active
  const rows: TailSeg[][] = []
  for (let i = buf.baseY + e.term.rows - 1; i >= 0 && rows.length < n; i--) {
    const line = buf.getLine(i)
    if (!line) continue
    const segs: TailSeg[] = []
    let cur: TailSeg | null = null
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell) continue
      // **넓은 글자(한글·CJK·이모지)는 셀 두 칸을 차지한다.** 뒤쪽 칸은 폭 0 이고 글자가 비어 있다 —
      // 그걸 공백으로 채우면 `카 드 A_표 식` 처럼 글자 사이가 벌어진다(2026-08-23 PREV-4 가 잡았다.
      // 색을 입히면서 translateToString 대신 셀을 직접 훑기 시작한 그 순간 생긴 결함이다).
      if (cell.getWidth() === 0) continue
      const ch = cell.getChars() || ' '
      const mode = cell.getFgColorMode()
      // mode: 0=기본 · 1=P16 · 2=P256 · 3=RGB(xterm 내부 상수와 같은 순서).
      const rgb = mode === 3
      const fg = mode === 0 ? undefined : cell.getFgColor()
      const bold = cell.isBold() > 0
      // rgb·bold 는 **참일 때만** 키를 넣으므로(아래) 비교는 Boolean 으로 정규화한다 —
      // 안 그러면 `undefined !== false` 라 모든 셀이 따로 놀아 글자 수만큼 span 이 생긴다
      // (구간 병합이 이 함수의 존재 이유인데 조용히 무력화된다 — tests/tailSegs.test.ts 가 잡았다).
      if (cur && cur.fg === fg && Boolean(cur.rgb) === rgb && Boolean(cur.bold) === bold) cur.text += ch
      else {
        cur = { text: ch, ...(fg !== undefined ? { fg } : {}), ...(rgb ? { rgb: true } : {}), ...(bold ? { bold: true } : {}) }
        segs.push(cur)
      }
    }
    // 꼬리의 빈 줄은 건너뛴다(tailLines 와 같은 규칙 — 아래가 비어 있으면 카드가 빈 것처럼 보인다).
    const empty = segs.every((s) => !s.text.trim())
    if (rows.length === 0 && empty) continue
    // 오른쪽 여백은 잘라 낸다. 터미널 줄은 폭만큼 공백으로 채워져 오는데, 병합 뒤에는 그 공백이
    // **마지막 구간의 꼬리**로 붙어 있다 — 구간째 버리는 것만으로는 안 되고 꼬리도 깎아야 한다.
    while (segs.length > 0 && !segs[segs.length - 1].text.trim()) segs.pop()
    const last = segs[segs.length - 1]
    if (last) last.text = last.text.replace(/\s+$/, '')
    rows.push(segs)
  }
  return rows.reverse()
}

// R3.2 검색: 매치가 있으면 true. 한글은 xterm 이 유니코드 문자열로 그대로 비교하므로 별도 처리 없다.
// 대소문자 무시 + 검색 바가 떠 있는 동안 전체 매치를 강조(decorations)한다.
const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function highlight() {
  const active = cssVar('--accent-bright', '#7dd3fc')
  const match = cssVar('--accent', '#38bdf8')
  return {
    decorations: {
      matchBackground: cssVar('--t-yellow-line', 'rgba(227,179,65,0.25)'),
      matchOverviewRuler: match,
      activeMatchBackground: active,
      activeMatchColorOverviewRuler: active
    }
  }
}

export function findInTerm(sessionId: string, term: string, back = false): boolean {
  const e = terms.get(sessionId)
  if (!e || !term) return false
  const opts = highlight()
  return back ? e.search.findPrevious(term, opts) : e.search.findNext(term, opts)
}

export function clearSearch(sessionId: string): void {
  terms.get(sessionId)?.search.clearDecorations()
}

// 검색 바를 닫을 때 터미널로 포커스를 돌려준다(닫자마자 계속 타이핑할 수 있게).
export function focusTerm(sessionId: string): void {
  terms.get(sessionId)?.term.focus()
}

// R5: 설정 창에서 바꾼 터미널 동작을 이미 열려 있는 xterm 에도 즉시 반영한다(재마운트 금지 —
// 재마운트하면 스크롤백이 증발한다). copyOnSelect·bell 은 termPrefs 를 이벤트 시점에 읽으므로
// 여기서 할 일이 없고, xterm 옵션인 셋만 옮긴다.
export function applyTermPrefsToAll(scrollback: number, cursorStyle: CursorStyle, cursorBlink: boolean): void {
  for (const { term } of terms.values()) {
    term.options.scrollback = scrollback
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
  }
}

// F5: 열려 있는 모든 xterm 에 폰트/크기/행간 즉시 반영(재마운트 금지).
// xterm options 갱신 → fit 재계산 → onResize 이벤트가 pty resize 를 자동 전파한다.
export function applyFontToAll(fontFamily: string, fontSize: number, lineHeight: number): void {
  for (const { term, fit } of terms.values()) {
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.lineHeight = lineHeight
    try {
      fit.fit() // 셀 치수 변화 → cols/rows 재계산. term.onResize 가 pty resize 를 전파.
    } catch {
      // 숨김 패널(clientWidth 0) 등에서 fit 실패 무시 — 표시 시 ResizeObserver 가 재fit.
    }
  }
}
