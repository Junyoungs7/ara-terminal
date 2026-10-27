import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { CursorStyle } from '@shared/types'
import { usableSize } from '../../shared/termSize'

// 세션별 xterm 인스턴스 레지스트리 — 우클릭 메뉴 '복사'(F4c) + F5 폰트 실시간 적용 + R3.2 검색.
// TerminalPane 이 mount 시 등록, unmount 시 해제. UI 상태가 아니므로 스토어가 아닌 모듈 맵으로 관리.
type Entry = { term: Terminal; fit: FitAddon; search: SearchAddon }
const terms = new Map<string, Entry>()

/**
 * 🔴 **xterm 을 맞추는 모든 길이 지나는 곳**(2026-09-30 오류 신고 #10).
 *
 * FitAddon 은 칸이 아무리 작아도 undefined 가 아니라 `max(2, …)` 를 내놓는다 — 부팅 중 레이아웃이
 * 잡히기 전의 호스트에서는 9칸이 나온다. 1.0.15 는 TerminalPane 의 fit 셋만 막았고, 폰트가 늦게
 * 도착할 때 부르는 `remeasureAll`(JetBrains Mono 처럼 번들 웹폰트일 때만 뜬다)은 **그대로 fit 했다.**
 * main 은 9칸 resize 를 버리므로 pty·저장값은 139 로 멀쩡한데 **xterm 만 9칸**이 되어, 셸의 프롬프트가
 * 9칸에서 접히고 커서는 8열(= cols-1)로 눌린다. windowsMode 라 넓어져도 다시 펴지지 않는다.
 * 새 fit 호출은 반드시 이 함수로 — 한쪽만 막으면 또 샌다.
 */
export function fitIfUsable(fit: FitAddon): void {
  const d = fit.proposeDimensions()
  if (d && usableSize(d.cols, d.rows)) fit.fit()
}

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
/**
 * #158: **접속 전에 셸 크기를 아는 유일한 창구.**
 *
 * 새 SSH 세션은 `layout.showSession` 이 **포커스 칸의 sessionId 를 갈아 끼우는** 식으로 뜬다 —
 * 칸은 그대로고 안에 든 세션만 바뀐다. 그러니 지금 그 칸에 있는 xterm 의 cols·rows 가 곧 새
 * 세션이 갖게 될 치수다(픽셀 상자도 폰트도 그대로다). 포커스 칸의 세션 = `sessions.activeId`
 * 이므로(MainArea 가 둘을 양방향으로 잇는다) 부르는 쪽은 그 id 만 주면 된다.
 *
 * 없으면 null — 칸이 비었거나(첫 세션) 그 칸이 xterm 이 아닌 경우(RDP·복원 placeholder)다.
 * 그때는 main 이 80×24 로 열고 마운트 직후의 resize 가 따라잡는다(예전 동작 그대로).
 */
export function sizeOf(sessionId: string | null): { cols: number; rows: number } | null {
  const e = sessionId ? terms.get(sessionId) : null
  if (e) return { cols: e.term.cols, rows: e.term.rows }
  /**
   * 없으면 null — 예전 그대로다. **아무 터미널의 치수로 떨어지지 않는다**(2026-09-16 에 그렇게
   * 해 봤다가 걷었다): 분할 중이면 남의 칸 폭이라 틀린 값이고, 부팅 복원 때는 떠 있는 xterm 이
   * 아예 없어 **어차피 안 도는 길**이었다. 추측값을 넣으면 "대충 맞는데 가끔 틀린" 자리가 생긴다.
   *
   * 복원의 정답은 추측이 아니라 **저장해 둔 값**이다 — `Session.cols`(main 이 resize 때마다 적는다)를
   * 복원이 그대로 실어 보낸다. 여기는 **새 세션이 지금 칸에 뜨는 경우**만 답하면 된다.
   */
  return null
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

// 세션 버퍼의 마지막 n 줄(꼬리의 빈 줄은 건너뛴다). F15 미니 프리뷰가 만들었고(2.0 에서 삭제) 지금은 AiPanel 이 쓴다.
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
      fitIfUsable(fit) // 셀 치수 변화 → cols/rows 재계산. term.onResize 가 pty resize 를 전파.
    } catch {
      // 숨김 패널(clientWidth 0) 등에서 fit 실패 무시 — 표시 시 ResizeObserver 가 재fit.
    }
  }
}

/**
 * 웹폰트가 **나중에** 도착했을 때 셀 치수를 다시 재고 열린 터미널을 전부 맞춘다.
 *
 * 번들 폰트는 `font-display: swap` 이라(styles/fonts.css) 파일이 오기 전에는 스택의 **다음
 * 폰트**로 그려진다. 그런데 xterm 은 `term.open()` 때 딱 한 번 셀을 재고 `document.fonts` 를
 * 보지 않는다 — 진짜 폰트가 도착해도 **폴백의 셀 크기로 굳는다.**
 *
 * 실측(2026-08-31, 준영님 설정 JetBrains Mono 14px/1.3, 폴백=나눔고딕코딩):
 *   굳은 셀 7×18 → 126칸 44행. 진짜 치수 8.4×23 으로는 107칸 34행이다.
 * 셸에는 126×44 라고 알려 주고, 글자는 자기 칸보다 넓고 높게 그려져 가로·세로로 겹친다.
 * 기본 글꼴(나눔고딕코딩)에서는 안 난다 — `--mono` 가 UI 전반에 쓰여 이미 받아져 있기 때문이다.
 * **기본값으로 시험하면 재현되지 않는다.**
 *
 * 🔴 **행이 화면 밖으로 넘치는 진짜 고리는 여기다.** "굳는다"만으로는 안 넘친다 — 굳은 셀로
 * 일관되게 그리면 `행 수 × 셀 ≤ 보이는 높이` 라 마지막 행이 그대로 보인다. 넘치는 이유는
 * xterm 이 **resize 를 적용한 뒤에 셀을 다시 재기 때문**이다:
 *   `_bufferService.onResize → _afterResize → _charSizeService.measure()`  (xterm.js 실물 확인)
 * 순서가 이렇게 된다:
 *   ① `open()` — 폴백으로 잰다(셀 18)
 *   ② `fit()` — 그 18 로 44행을 정하고 `resize(126, 44)`
 *   ③ `resize` 가 `_afterResize` 를 부르고 **그 순간 도착해 있던 진짜 폰트로 다시 잰다**(셀 23)
 *   ④ 다시 `fit()` 하는 사람이 없다 → 44행 × 23 = **1012px 를 800px 칸에** 넣는다
 * 실측 넘침: 400px 칸 +83 · 600px +136 · 800px **+212(≈9행)**. 그 9행이 화면 아래로 사라진다.
 * 준영님 제보의 정체가 이것이다 — *"ll·ls 를 치면 명령어 줄이 하단바 밑으로 내려가 안 보이고,
 * clear 를 치면 검은 화면"*. 이 함수를 태우면 셋 다 넘침이 음수로 떨어진다(−9·−25·−18).
 *
 * ③이 **폰트 도착 시점에 걸린 경합**이라 "가끔씩"이다. 폰트가 마지막 resize 뒤에 오면 ③이 안
 * 걸려 멀쩡하다. 이 경합을 모르고 짠 하네스(`term.write()` 없이 잰 것)는 늘 멀쩡한 쪽만 밟아
 * **맞는 가설을 기각하게 만들었다** — 재현 순서가 실앱과 다르면 그 측정은 반증이 아니다.
 *
 * ⚠ `applyFontToAll` 로는 못 고친다. 값이 그대로라서다 — xterm 의 OptionsService 는
 * `rawOptions[k] !== v` 일 때만 이벤트를 쏘고, 셀을 다시 재는 곳은 `fontFamily`·`fontSize` 가
 * **실제로 바뀔 때** 걸린 리스너 하나뿐이다(CharSizeService). 그래서 크기를 한 번 흔든다.
 * 같은 태스크 안에서 되돌리므로 중간 값이 그려지지는 않는다.
 */
export function remeasureAll(): void {
  for (const { term, fit } of terms.values()) {
    const size = term.options.fontSize
    if (size === undefined) continue
    term.options.fontSize = size + 1
    term.options.fontSize = size
    try {
      fitIfUsable(fit)
    } catch {
      // 위와 같은 이유(숨김 패널) — 한 칸이 실패해도 나머지는 맞춘다.
    }
  }
}
