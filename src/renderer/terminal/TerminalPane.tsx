import { useEffect, useRef, useState } from 'react'
import { Terminal, type IDecoration, type IMarker, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { shouldUseWebgl, termRenderer, type WebglProbe } from './webglChoice'
import { fitIfUsable, lineBeforeCursor, registerTerm, unregisterTerm } from './termRegistry'
import { completionKey } from './completionKeys'
import { cancelPendingResize, whenResizeAllowed } from './resizeGate'
import { termPrefs } from './termPrefs'
import { notifyPasted, readClipboard, writeClipboard } from '../store/clipboardWrite'
import {
  appendHistory,
  cachedHistory,
  feedInput,
  ghostEligible,
  ghostList,
  historyScope,
  loadHistory,
  shouldRecord
} from '../store/history'
import { notifyPasteFallback, uploadFiles } from '../store/uploadBus'
import { filePaths, registerPasteTarget } from '../store/pasteFiles'
import { pastePaths } from '../components/filePath'
import { isAppShortcut } from '../../shared/keymap'
import type { AiCliId } from '../../shared/aiCli'
import { t } from '../i18n'
import '@xterm/xterm/css/xterm.css'

// 터미널 폰트·색은 tokens.css 변수에서 파생(매직넘버 금지). CSS 변수를 읽어 xterm 테마에 주입.
function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// R3.5 ANSI 16색 — design-system §1.6 팔레트를 xterm 테마로 옮긴다. 8 normal 은 문서의 토큰 그대로,
// 8 bright 는 같은 색상의 밝은 파생(--t-*-b)이다. black/white 는 표면·텍스트 토큰을 재사용해
// 터미널 배경과 한 계열로 유지한다. 폴백 HEX 는 CSS 가 아직 없는 순간(테스트 하네스)용 최후 수단.
function ansiTheme(): ITheme {
  const v = (name: string, fallback: string) => readVar(name) || fallback
  return {
    background: v('--bg-terminal', '#0e1219'),
    foreground: v('--t-fg', '#cdd6e4'),
    cursor: v('--accent-bright', '#7dd3fc'),
    // 커서 위 글자색 — 배경과 같게 둬야 블록 커서 안 글자가 읽힌다.
    cursorAccent: v('--bg-terminal', '#0e1219'),
    selectionBackground: v('--sel-bg', 'rgba(201,162,109,0.3)'),
    selectionForeground: v('--text-hi', '#e8edf5'),
    black: v('--t-black', '#3b4653'),
    red: v('--t-red', '#ff7b72'),
    green: v('--t-green', '#7ee787'),
    yellow: v('--t-yellow', '#e3b341'),
    blue: v('--t-blue', '#79c0ff'),
    magenta: v('--t-purple', '#d2a8ff'),
    cyan: v('--t-cyan', '#56d4dd'),
    white: v('--t-fg', '#cdd6e4'),
    brightBlack: v('--t-gray', '#6e7a8a'),
    brightRed: v('--t-red-b', '#ffa198'),
    brightGreen: v('--t-green-b', '#a2f2ab'),
    brightYellow: v('--t-yellow-b', '#f2cc60'),
    brightBlue: v('--t-blue-b', '#a5d6ff'),
    brightMagenta: v('--t-purple-b', '#e2c5ff'),
    brightCyan: v('--t-cyan-b', '#84e8ef'),
    brightWhite: v('--text-hi', '#e8edf5')
  }
}

// 백프레셔 메커니즘 2: xterm write 콜백 백로그가 임계치를 넘으면 pty read를 일시정지 요청.
// write 콜백이 밀리는 개수로 백로그를 근사한다.
const BACKLOG_PAUSE = 4 // 미완료 write 4개 초과 시 pause
const BACKLOG_RESUME = 1 // 1개 이하로 소진되면 resume
// 시각 벨 번쩍임 지속(R5). 눈에 걸리되 작업을 방해하지 않는 길이.
const BELL_FLASH_MS = 160
/**
 * **손이 멈춘 것**으로 볼 시간(#194 ②, 2026-09-08). 45ms 였다 — 사람 타이핑(보통 120~250ms/글자)
 * 보다 빨라서 **치는 도중에** 제안이 끼어들었다. 250ms 는 다음 글자가 안 오는 순간을 고른다.
 *
 * ⚠️ 아래 GHOST_ECHO_MS 와 **다른 일**이다. 하나로 합치지 마라 — 합치면 둘 중 하나가 틀린 값이 된다.
 */
const GHOST_IDLE_MS = 250
/**
 * 에코를 기다리는 재시도 간격. 입력은 pty 를 돌아 에코로 와야 커서가 움직이므로, 그 전에 그리면
 * 커서가 한 칸 뒤처져 고스트가 어긋난다. **이것은 사람을 기다리는 시간이 아니라 선로를 기다리는
 * 시간이라** 위(GHOST_IDLE_MS)와 함께 올리면 안 된다 — 늦게 오는 에코를 더 늦게 잡을 뿐이다.
 */
const GHOST_ECHO_MS = 45
// 에코를 기다리는 최대 횟수. 원격 SSH·conpty 가 밀릴 때 한두 번으로는 못 따라잡는다
// (실측: 백스페이스를 연달아 보낸 뒤 첫 글자 에코가 100ms 넘게 늦는다).
// 8 × 45ms ≈ 0.36초 — 그 실측이 정한 값이라 ②에서 지연을 올릴 때도 **그대로 뒀다**(줄이면 원격에서
// 고스트가 어긋난다. e2e 시나리오 HIST-M1 이 이 0.4초를 전제로 적혀 있다).
// 최악 총 대기 = 250 + 360 ≈ 0.61초, 보통은 250ms(에코가 제때 오면 첫 판에 그린다).
const GHOST_RETRIES = 8
/**
 * 목록에 보여 줄 후보 수(2026-08-22 준영님 제보 10번 "자동완성을 IDE 처럼 목록으로").
 * 여섯이면 터미널을 크게 가리지 않으면서 "고를 것이 있다"가 보인다 — 더 늘리면 화면을 덮는다.
 */
const COMP_MAX = 6
/** 후보 한 줄의 높이(px). 목록을 **위로 열지** 정할 때 필요한데, 그리기 전에는 잴 수가 없다.
 *  shell.css `.term-comp .ci` 와 같은 값이어야 한다(어긋나면 화면 끝에서 몇 px 잘린다). */
const COMP_ROW_H = 22
/** 목록 맨 아래 안내 줄(↑↓ 고르기…) + 테두리·여백. 위 값과 같은 이유로 여기 있다. */
const COMP_CHROME_H = 26
const UTF8 = new TextDecoder('utf-8', { fatal: false })

/** 커서 옆에 뜨는 후보 목록의 자리·내용. null 이면 목록이 없다(고스트만 있거나 그것도 없다). */
type Comp = { items: string[]; index: number; left: number; y: number; up: boolean }

// 로컬 셸은 Windows 에서 conpty 를 통해 붙는다. conpty 는 출력 줄을 터미널 폭까지 공백으로
// 채워 보내는데, 창을 좁히면 xterm 이 그 padding 까지 리플로우해 한 줄을 여러 줄로 쪼갠다
// (실측: 163칸에서 찍힌 dir 출력을 66칸으로 줄이면 줄마다 빈 줄 2개가 끼어 줄 간격이 벌어진다).
// conpty 는 리사이즈 때 화면을 스스로 다시 그리므로 xterm 쪽 리플로우는 꺼야 맞다.
//
// 끄는 스위치는 windowsMode 뿐이다. xterm 의 게이트는
//   _isReflowEnabled = windowsPty?.buildNumber ? (conpty && buildNumber >= 21376) : !windowsMode
// 라서, 실제 빌드번호(26200)를 정직하게 넘기면 리플로우가 켜진 채로 남아 증상이 그대로 재현된다.
// deprecated 표기가 있지만 windowsPty 를 함께 주지 않는 한 유효하며, 현재 이 동작을 얻는 유일한 경로다.
// 원격(SSH)은 실제 pty 라 리플로우가 정상 동작하므로 적용하지 않는다.
const isWindows = navigator.userAgent.includes('Windows')
// mac 은 복사/붙여넣기 수식자가 ⌘ 다(Ctrl 은 셸 제어문자 그대로 유지).
const isMacUA = navigator.userAgent.includes('Mac')

// WebGL 렌더러(R3.4)는 진짜 GPU 가 있을 때만 이득이다. 소프트웨어 래스터라이저(SwiftShader/llvmpipe)로
// 떨어진 환경에서는 DOM 렌더러보다 오히려 느리고, Electron 종료 시 GL 컨텍스트 정리에서 프로세스가
// 접근 위반으로 죽는 사례가 있다(GPU 끈 E2E 하네스에서 재현). 그런 환경은 처음부터 DOM 으로 간다.
// 프로브는 창당 한 번만 — 결과는 세션 수명 내내 변하지 않는다.
//
// 판정 자체는 webglChoice.ts 의 shouldUseWebgl 이 한다(창 없이 검사하려고 뗐다 — 그 구멍에 대한
// 🔴 경고도 거기 있다). 여기 남은 것은 **브라우저에게 사실을 묻는 일**뿐이다.
let webglUsable: boolean | null = null
function canUseWebgl(): boolean {
  if (webglUsable !== null) return webglUsable
  const probe: WebglProbe = { optOut: window.ev?.app?.webglOptOut, gl: false, renderer: '' }
  try {
    // 🔴 `ARA_NO_WEBGL=1` 이면 **GL 컨텍스트를 만들지도 않는다.** 만드는 것 자체가 이번 제보의
    // 후보라(#190 — 아틀라스가 깨지는 것은 컨텍스트 로스트가 아니어서 폴백 핸들러가 안 걸린다)
    // 탈출구가 프로브보다 앞이다. 이 스위치는 두 몫을 한다:
    //   · **진단** — "WebGL 을 빼면 증상이 사라지나"를 가르는 유일한 방법이다(우리에게 그 PC 가 없다)
    //   · **임시 처방** — 증상을 만난 사람에게 줄 손잡이가 지금 이것뿐이다. 원인이 확정되고
    //     판정이 고쳐지면 그때 다시 볼 것이고, 그전에는 지우지 마라.
    if (probe.optOut !== '1') {
      const gl = document.createElement('canvas').getContext('webgl2')
      probe.gl = !!gl
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        probe.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
    }
  } catch {
    probe.gl = false
  }
  // 프로브가 본 것을 [정보] 탭이 그대로 보여 준다 — 제보자 PC 와 비교할 기준이 이것이다.
  termRenderer.gpu = probe.renderer
  termRenderer.optOut = probe.optOut
  return (webglUsable = shouldUseWebgl(probe))
}

type Props = {
  sessionId: string
  active: boolean
  local: boolean
  // F11 히스토리 scope — SSH 는 서버별(serverKey), 로컬은 'local'. 서버마다 쓰는 명령이 달라서
  // 한 통에 섞으면 고스트가 남의 서버 명령을 물어 온다.
  serverKey: string
  // #204: 이 탭에서 돌고 있는 AI CLI. 있으면 히스토리가 메모리 전용 통으로 간다 —
  // 판정은 historyScope 하나가 한다(거기 주석에 이 갈래의 한계도 적혀 있다).
  aiCli?: AiCliId
  // R3.6: 셸이 보낸 OSC 0/2 제목. 사용자가 rename 한 세션이면 상위(MainArea)가 무시한다.
  onTitle?: (sessionId: string, title: string) => void
  // F8: Ctrl+클릭한 URL. 라우팅(포워딩·내장 브라우저·OS 브라우저)은 MainArea 가 한다 —
  // 실패를 알릴 다이얼로그가 거기 있고, 여기(xterm 배선)에 IPC 흐름을 두면 두 관심사가 섞인다.
  /** external=true 면 OS 기본 브라우저로(Ctrl+Alt+클릭) — 라우팅 판단은 MainArea 가 한다. */
  onLink?: (sessionId: string, url: string, isSsh: boolean, external?: boolean) => void
}

// 단일 세션 xterm 페인. 인스턴스 수명 = 세션 수명이다: PaneGrid 가 세션마다 이 컴포넌트를 하나씩
// 마운트해 두고 표시 위치만 바꾸므로(패널의 세션이 바뀌어도 언마운트되지 않는다) 스크롤백이 보존된다.
// 그래도 xterm 이 새로 만들어지는 경우(세션 신규·앱 재기동·StrictMode 이중 마운트)는 남으므로,
// mount 직후 session.attach 로 main 의 재생 버퍼를 받아 화면을 되살린다.
export function TerminalPane({ sessionId, active, local, serverKey, aiCli, onTitle, onLink }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // onTitle 은 상위 렌더마다 새 함수라 effect deps 에 넣으면 xterm 이 재생성된다(스크롤백 증발).
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  const linkRef = useRef(onLink)
  linkRef.current = onLink
  // F11 R2 후보 목록(제보 10). 화면에 그릴 것만 state 로 두고, 키 핸들러가 읽는 선택 상태는
  // ref 로 둔다 — xterm 배선은 effect 안의 명령형 코드라 state 를 읽으면 낡은 값을 본다.
  const [comp, setComp] = useState<Comp | null>(null)
  // 목록은 position:fixed 라 **패널이 숨어도 화면에 남는다**(고스트 데코레이션은 패널과 함께
  // 사라진다). 탭을 옮기거나 터미널에서 포커스가 빠지면 지워야 한다 — 그 두 자리에서 부를 손잡이.
  const clearGhostRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: readVar('--term') || 'monospace',
      fontSize: parseInt(readVar('--tt'), 10) || 14,
      lineHeight: parseFloat(readVar('--tl')) || 1.58,
      cursorStyle: termPrefs.cursorStyle,
      cursorBlink: termPrefs.cursorBlink,
      allowProposedApi: true,
      windowsMode: isWindows && local,
      scrollback: termPrefs.scrollback,
      theme: ansiTheme()
    })
    // ── F11 인라인 고스트 자동완성 ──
    // 히스토리 scope 를 미리 읽어 둔다(키 입력마다 IPC 왕복을 둘 수 없다). 고스트는 xterm 데코레이션
    // (공개 API)으로 그린다 — 터미널에 실제로 써 넣으면 셸의 화면 갱신과 싸우게 된다.
    const scope = historyScope({ local, serverKey, aiCli })
    void loadHistory(scope)
    let lineBuf = '' // 사용자가 지금 줄에 친 내용(입력 스트림에서 재구성)
    let ghostSuffix = '' // 화면에 떠 있는 나머지 — 비어 있으면 Tab·ESC 는 셸로 그대로 간다
    let ghostDeco: IDecoration | null = null
    let ghostMarker: IMarker | null = null
    let ghostTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * 한글을 **조합하는 중**인가(IME). 고스트는 조합이 끝날 때까지 손을 뗀다.
     *
     * 왜 필요한가(2026-09-10 준영님 제보 — *"'안녕하세요' 를 치면 'ㅇ나ㅅㅇ' 이렇게 씹힌다,
     * 창을 나갔다 들어오면 정상"*): GHOST_IDLE_MS 는 **손을 멈춘 시간**을 재는데, 한글은 글자마다
     * 멈춘다. `안` 을 확정하면 onData → scheduleGhost 가 250ms 타이머를 걸고, 그 사이 사람은
     * `녕` 을 **조합하기 시작**한다. 250ms 뒤 renderGhost 가 조합 한가운데서 데코레이션을
     * 등록·해제하며 xterm 을 다시 그리게 한다. 로마자는 조합이 없어 이 창이 아예 안 열린다 —
     * **한글에서만 나는 이유가 그것이다.**
     *
     * ⚠️ `attachCustomKeyEventHandler` 의 `e.isComposing` 으로는 못 막는다. 그건 **키가 올 때**의
     * 판정이고, 여기서 문제가 되는 것은 **키 없이 타이머가 스스로 깨는 것**이다.
     */
    let composing = false

    // 지금 쥐고 있는 후보들(키 핸들러가 읽는다 — state 는 이 명령형 코드에서 낡는다).
    // #194 ①: 후보가 있다고 목록이 떠 있는 것은 아니다. 떠 있는지는 compOpen 이 안다(= comp state).
    let compItems: string[] = []
    let compIndex = 0
    let compOpen = false

    const clearGhost = () => {
      if (ghostTimer) {
        clearTimeout(ghostTimer)
        ghostTimer = null
      }
      ghostSuffix = ''
      ghostDeco?.dispose()
      ghostDeco = null
      ghostMarker?.dispose()
      ghostMarker = null
      if (compItems.length > 0) {
        compItems = []
        compIndex = 0
        // 목록이 안 떠 있었으면 React 를 깨우지 않는다 — 이제 후보는 있어도 목록은 없는 것이
        // 보통이라(#194 ①), 여기서 무조건 setComp 하면 키마다 헛 렌더가 한 번씩 돈다.
        if (compOpen) {
          compOpen = false
          setComp(null)
        }
      }
    }

    clearGhostRef.current = clearGhost

    /** 커서 뒤에 흐린 나머지를 얹는다(데코레이션 하나). 이미 있으면 지우고 다시 그린다. */
    const drawGhost = (suffix: string) => {
      ghostDeco?.dispose()
      ghostDeco = null
      ghostMarker?.dispose()
      ghostMarker = null
      ghostSuffix = ''
      if (!suffix) return
      const x = term.buffer.active.cursorX
      const marker = term.registerMarker(0)
      if (!marker) return
      const deco = term.registerDecoration({
        marker,
        x,
        width: Math.min(suffix.length, Math.max(1, term.cols - x)),
        layer: 'top'
      })
      if (!deco) {
        marker.dispose()
        return
      }
      deco.onRender((el) => {
        el.textContent = suffix
        el.classList.add('term-ghost')
      })
      ghostDeco = deco
      ghostMarker = marker
      ghostSuffix = suffix
    }

    /**
     * 후보 목록을 커서 아래(자리가 없으면 위)에 놓는다 — 제보 10번.
     * #194 ①: **`↓` 를 눌렀을 때만** 불린다(전에는 타이핑 중 저절로 떴다). 화면을 덮는 것은
     * 고스트가 아니라 이 목록이라, 부를 때만 여는 것으로 바꿨다.
     * 셀 크기는 xterm 내부값을 훔치지 않고 **화면 요소를 재서** 얻는다(`.xterm-screen` 의 폭은
     * 정확히 cols × 셀 폭이다). 좌표는 화면 기준(position:fixed) — 우클릭 메뉴와 같은 방식이라
     * 패널의 overflow 에 잘리지 않는다.
     */
    const placeComp = (items: string[]) => {
      const screen = host.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return
      const r = screen.getBoundingClientRect()
      const cellW = r.width / Math.max(1, term.cols)
      const cellH = r.height / Math.max(1, term.rows)
      const lineTop = r.top + term.buffer.active.cursorY * cellH
      /**
       * 아래로 열 자리가 있는가 — 기준은 **터미널 화면의 아래 끝**이지 창 아래 끝이 아니다
       * (2026-08-23 준영님 제보 2번). 창 높이로 재면 하단바가 열려 있을 때 목록이 그 위를 덮는다:
       * 그림 순서상 위에 그려지긴 하지만, 남의 패널을 침범한 목록은 "가려졌다"로 읽힌다(실측:
       * 목록 591~663 · 하단바 614~874). 터미널 밖으로 나갈 것 같으면 커서 줄 **위로** 띄운다.
       */
      const listH = items.length * COMP_ROW_H + COMP_CHROME_H
      const up = lineTop + cellH + listH > r.bottom
      compOpen = true
      setComp({
        items,
        index: compIndex,
        left: Math.round(r.left + term.buffer.active.cursorX * cellW),
        y: Math.round(up ? window.innerHeight - lineTop : lineTop + cellH),
        up
      })
    }

    const renderGhost = (retry: number) => {
      ghostTimer = null
      // 조합이 시작되기 **전에** 걸린 타이머가 조합 한가운데서 깨는 길이 남아 있다(scheduleGhost 의
      // 가드는 그 뒤에 걸린 것만 막는다). 재시도도 걸지 않는다 — compositionend 가 다시 부른다.
      if (composing) return
      if (!lineBuf) return
      // 에코가 아직 안 왔으면 커서가 한 칸 뒤처져 고스트가 어긋난다 — 한 번 더 기다린다.
      if (!lineBeforeCursor(sessionId).endsWith(lineBuf)) {
        if (retry > 0) ghostTimer = setTimeout(() => renderGhost(retry - 1), GHOST_ECHO_MS)
        return
      }
      const items = ghostList(cachedHistory(scope), lineBuf, COMP_MAX)
      if (items.length === 0) return
      compItems = items
      compIndex = 0
      drawGhost(items[0].slice(lineBuf.length))
      // #194 ①: 목록은 여기서 열지 않는다. 후보가 여럿이라는 사실은 쥐고만 있다가 `↓` 를 누르면
      // openComp 가 연다 — 회색 고스트 한 줄은 방해가 적지만 목록은 화면을 덮기 때문이다.
    }

    /** `↓` — 쥐고 있던 후보를 목록으로 편다. 후보가 하나면 부르지 않는다(고스트가 곧 그 하나다). */
    const openComp = () => {
      if (compItems.length > 1) placeComp(compItems)
    }

    /** ↓/↑ 로 후보를 옮긴다. 고스트도 함께 바뀐다 — 지금 `→` 를 누르면 무엇이 들어올지가 그것이다. */
    const moveComp = (delta: number) => {
      const n = compItems.length
      if (n === 0) return
      compIndex = (compIndex + delta + n) % n
      drawGhost(compItems[compIndex].slice(lineBuf.length))
      setComp((c) => (c ? { ...c, index: compIndex } : c))
    }

    const scheduleGhost = () => {
      clearGhost()
      /**
       * 안 뜰 입력에는 **타이머조차 만들지 않는다**(#194 ③·곁들여). 여기서 걸러 내면 그 키는
       * setTimeout 도, 250ms 뒤의 xterm 버퍼 읽기(lineBeforeCursor)도, 히스토리 훑기(ghostList)도
       * 하지 않는다 — `cd ` 처럼 낱말이 빈 줄과 한 글자 접두가 매 키마다 그것을 다 하고 있었다.
       * 판정은 ghostList 와 같은 함수를 쓴다(두 벌로 갈리면 한쪽만 고쳐진다).
       */
      if (!termPrefs.termCompletion || !ghostEligible(lineBuf)) return
      // 조합 중에는 타이머조차 만들지 않는다 — compositionend 가 다시 부른다.
      if (composing) return
      ghostTimer = setTimeout(() => renderGhost(GHOST_RETRIES), GHOST_IDLE_MS)
    }

    /**
     * 커서 뒤에 글자가 없나 — `→` 로 고스트를 받을 유일한 조건(completionKeys.ts 참고).
     *
     * 커서 위치는 **화면에만** 있다: 리드라인이 줄 어디를 편집 중인지는 입력 스트림으로 알 수 없다
     * (`lineBeforeCursor` 가 앞쪽을 화면에서 읽는 것과 같은 이유). 오른쪽 여백은 conpty 가 폭까지
     * 공백으로 채워 보내므로 trimRight 로 걷어 낸다 — 안 그러면 어떤 줄도 "끝"이 되지 못한다.
     * 줄을 못 읽으면 **가로채지 않는다**: 확신이 없을 때 커서 이동을 뺏는 쪽이 더 큰 손해다.
     */
    const atLineEnd = (): boolean => {
      const buf = term.buffer.active
      const line = buf.getLine(buf.baseY + buf.cursorY)
      return line ? line.translateToString(true, buf.cursorX) === '' : false
    }

    // 채택(`→`·목록의 Enter): 나머지를 셸에 실제로 입력한다(화면의 흐린 글자를 진짜 입력으로 바꾼다).
    // 우리가 보낸 입력은 term.onData 를 거치지 않으므로 줄 버퍼도 여기서 직접 맞춘다.
    const acceptGhost = () => {
      const suffix = ghostSuffix
      clearGhost()
      lineBuf += suffix
      window.ev.session.input(sessionId, suffix)
      scheduleGhost()
    }

    // 앱 단축키는 셸로 보내지 않는다(R2.5). 창 단축키 핸들러는 여기서 false 를 돌려줘도 그대로 받는다
    // — xterm 은 전파를 멈추지 않는다.
    //
    // R3.1 Ctrl+C/V (Windows Terminal 관례):
    //   Ctrl+C — 선택이 있으면 복사(복사 후 선택 해제), 없으면 그대로 셸로 보내 SIGINT 가 되게 한다.
    //   Ctrl+V — 항상 붙여넣기. 리드라인 literal-next(quoted-insert)보다 붙여넣기를 우선한다(사용자 확정).
    // KEYMAP 에는 넣지 않는다 — 넣으면 isAppShortcut 이 무조건 true 라 선택 없는 Ctrl+C 의 SIGINT 까지 막힌다.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (isAppShortcut(e)) return false
      // F11: 고스트가 떠 있을 때만 →=채택 / ↓=목록 열기 / 목록에서 ↑↓=고르기·Enter=고르기 / ESC=해제
      // (#194: Tab 은 셸에 돌려줬다 — 파일 이름 완성이 히스토리 제안보다 자주 필요하다).
      // 무엇을 가로챌지는 completionKeys 가 정한다(순수 판정 — 여기는 그 결정을 실행만 한다).
      // 고스트가 없으면 셸의 자동완성·인터럽트·커서 이동을 그대로 통과시킨다(R3.8 정책).
      // isComposing: 한글을 조합하는 중이면 Enter 는 **글자를 확정하는 키**다(IME 가 먼저 가져간다).
      // 그 Enter 까지 고르기로 쓰면 조합 중인 글자가 사라지고 엉뚱한 후보가 들어간다.
      if (ghostSuffix && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const act = completionKey({
          key: e.key,
          ghost: true,
          items: compItems.length,
          listOpen: compOpen,
          // 버퍼를 읽는 값이라 필요한 키에서만 잰다(키다운마다 줄을 훑을 이유가 없다).
          atLineEnd: e.key === 'ArrowRight' && atLineEnd()
        })
        if (act !== 'pass') {
          // false 만 돌려주면 xterm 이 손을 떼면서 브라우저 기본 동작(Tab = 포커스 이동)이 살아나
          // 터미널이 포커스를 잃는다 — 채택 직후 타이핑이 먹통이 된다.
          e.preventDefault()
          if (act === 'accept') acceptGhost()
          else if (act === 'dismiss') clearGhost()
          else if (act === 'open') openComp()
          else moveComp(act === 'next' ? 1 : -1)
          return false
        }
      }
      const plainCtrl = (isMacUA ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey
      if (!plainCtrl) return true
      const key = e.key.toLowerCase()
      if (key === 'c' && term.hasSelection()) {
        // 2026-08-18 제보: 단축키로 복사하면 화면에 아무 일도 안 일어나 **됐는지 알 수 없었다**
        // (우클릭 메뉴 쪽에만 토스트가 있었다). 사람이 키를 누른 경로라 알린다.
        void writeClipboard(term.getSelection(), true)
        term.clearSelection()
        return false
      }
      if (key === 'v') {
        // 붙여넣기는 **브라우저 paste 이벤트**에 맡긴다(store/pasteFiles.ts).
        //  · 파일이면 그쪽이 가로채 업로드한다 — Electron clipboard API 와 달리 **여러 개가 다 온다**(A-3).
        //  · 텍스트면 xterm 이 자기 textarea 로 받아 붙여넣는다(bracketed paste 처리까지 그쪽이 맞다).
        // 여기서 preventDefault 하면 paste 이벤트 자체가 안 와서 예전엔 파일 하나만 올라갔다.
        // false 만 돌려 터미널이 ^V 를 셸로 보내지 않게 막는다(리드라인 literal-next 방지).
        //
        // 2026-08-18 제보: 붙여넣기도 알린다. **비밀번호 프롬프트처럼 화면에 안 보이는 자리**가
        // 있어서, 붙었는지 아닌지가 이 안내 말고는 단서가 없다. 실제 붙여넣기는 위 paste 이벤트가
        // 하므로 여기서는 "보냈다"가 아니라 한 박자 뒤에 알린다 — 파일 붙여넣기(업로드)는
        // 그쪽이 자기 안내를 내므로 겹치지 않게 텍스트일 때만.
        // main 경유(readClipboard) — 같은 권한 문제로 이 읽기도 늘 실패했고, 그래서 텍스트를
        // 붙여넣어도 "붙여넣기됨" 안내가 뜬 적이 없다(2026-09-02 · RDP 와 같은 뿌리).
        void readClipboard().then((t2) => {
          if (t2) notifyPasted()
        })
        return false
      }
      return true
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // R3.4 유니코드 11 폭 계산 — 한글·이모지가 차지하는 칸 수를 맞춰 표·박스 그리기가 어긋나지 않게.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // R3.3 URL: Ctrl(⌘)+클릭만 연다. 그냥 클릭으로 열면 로그를 훑다가 브라우저가 튀어나온다.
    // 여는 주체는 언제나 main 이다(OS 브라우저든 내장 브라우저든) — 렌더러는 스킴 검증된 IPC 만 호출한다.
    // F8: SSH 세션의 loopback·OAuth 링크는 포워딩을 거쳐 내장 브라우저로 간다(라우팅은 상위가 판단).
    term.loadAddon(
      new WebLinksAddon(
        (e, uri) => {
          if (!e.ctrlKey && !e.metaKey) return
          // 2026-08-23 준영님 제보 6번: **Alt 를 같이 누르면 OS 기본 브라우저로.**
          // Ctrl+클릭(현행)은 원격 링크를 아라 브라우저로 연다 — 사내 서버 인증처럼 그 편이 맞는
          // 경우가 대부분이라 기본으로 뒀지만, 즐겨찾기·로그인 세션이 있는 크롬으로 열고 싶을 때가
          // 있다. 그 선택을 수식자 하나로 준다(링크마다 묻지 않는다).
          linkRef.current?.(sessionId, uri, !local, e.altKey)
        },
        {
          hover: (_e, uri) => {
            host.title = `${uri}\n${t('term.link.hint')}`
          },
          leave: () => {
            host.title = ''
          }
        }
      )
    )
    term.open(host)
    // R3.4 WebGL 렌더러 — 실패(드라이버 없음·headless)나 컨텍스트 로스트 시 DOM 렌더러로 되돌린다.
    // dispose 만 하면 xterm 이 자동으로 DOM 폴백을 쓰므로 별도 재생성은 없다.
    // 언마운트 때 term.dispose() 보다 먼저 GL 컨텍스트를 끊어야 한다 — 순서가 뒤바뀌면 창을 닫는
    // 순간 GPU 쪽에서 접근 위반으로 프로세스가 죽는다(F6 재기동 E2E 에서 재현).
    let webgl: WebglAddon | null = null
    if (canUseWebgl()) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl?.dispose()
          // 폴백했으면 [정보]도 DOM 이라고 말해야 한다 — 프로브 값을 그대로 두면 화면이
          // "WebGL" 이라고 거짓말을 하고, 제보와 비교할 기준이 거짓이 된다.
          termRenderer.kind = 'dom'
        })
        // 오류 신고 #17(tmux 안 AI 화면 글자 깨짐) — addon-webgl 0.18 의 글자 그림(아틀라스)이 가득 차
        // 페이지를 합칠 때 두 버그가 난다: ① 페이지 판 번호가 칸마다 따로라 우연히 같으면 텍스처를 다시
        // 안 올린다 ② 그리는 도중 합쳐지면 다음 프레임까지 옛 좌표가 남는다(tmux 처럼 제자리 다시 그리기는
        // 다음 프레임이 안 와서 그대로 남는다). 옵션이 바뀌면 xterm 이 텍스처를 전부 다시 올리고 화면을 다시
        // 그린다 — 합쳐질 때만 오는 이 사건에 아무 영향 없는 옵션을 두 번 뒤집어 그것만 일으킨다.
        // headless 재현(agent_talk/webgl-atlas-repro-done.md): 틀린 칸 90~679 → 0.
        // ponytail: 우회책. upstream PR #5883(addon-webgl 0.20 / xterm 6.1)으로 올리면 지운다.
        // 0.18 의 typings 에는 빠졌지만 실제로 있는 사건이다(WebglAddon.ts _onRemoveTextureAtlasCanvas — 합칠 때만 온다).
        ;(webgl as WebglAddon & { onRemoveTextureAtlasCanvas: (cb: () => void) => unknown }).onRemoveTextureAtlasCanvas(() => {
          const o = term.options
          o.altClickMovesCursor = !o.altClickMovesCursor
          o.altClickMovesCursor = !o.altClickMovesCursor
        })
        term.loadAddon(webgl)
      } catch (err) {
        webgl = null
        console.warn('[term] WebGL 렌더러 초기화 실패 — DOM 폴백', err)
      }
    }
    // 프로브가 아니라 **결과**를 적는다(loadAddon 이 던지면 xterm 은 조용히 DOM 으로 돌아간다).
    termRenderer.kind = webgl ? 'webgl' : 'dom'
    termRef.current = term
    // 포커스가 터미널을 떠나면 후보 목록을 걷는다(제보 10). 목록은 fixed 라 스스로 사라지지
    // 않는다 — 사이드바를 누르러 간 사이 화면에 떠 있으면 그냥 쓰레기다.
    const textarea = term.textarea
    const onBlur = () => clearGhost()
    textarea?.addEventListener('blur', onBlur)
    // IME 조합 경계. 시작하면 떠 있던 고스트까지 걷는다(조합 글자 위에 흐린 글자가 겹치면
    // 무엇을 치고 있는지 안 보인다). 끝나면 그때 다시 잰다.
    const onCompStart = (): void => {
      composing = true
      clearGhost()
    }
    const onCompEnd = (): void => {
      composing = false
      scheduleGhost()
    }
    textarea?.addEventListener('compositionstart', onCompStart)
    textarea?.addEventListener('compositionend', onCompEnd)

    // F14 + A-3: 클립보드 **파일** 붙여넣기. 키다운이 아니라 진짜 paste 이벤트에서 받는다 —
    // 그래야 Windows 에서도 여러 개가 다 온다. 텍스트는 여기 오지 않는다(xterm 이 처리).
    /**
     * 파일이 이 터미널로 들어왔다 — 붙여넣기와 드롭이 **같은 함수를 지난다.**
     *
     * 하는 일: 원격이면 [파일] 탭 큐로 업로드하고, 아니면 **경로를 입력칸에 넣는다.**
     * 🔴 실행하지 않는다 — `pastePaths` 는 꼬리 개행을 안 붙인다(`filePath.ts:46`).
     *    떨군 사람이 읽고 Enter 를 눌러야 실행된다. AI CLI 에게는 그 경로가 곧 첨부다.
     */
    const takeFiles = (files: readonly File[]): boolean => {
      const paths = filePaths(files)
      // 텍스트 붙여넣기는 xterm 이 자기 textarea 로 처리한다(bracketed paste 포함) — 넘긴다.
      if (paths.length === 0) return false
      // 원격이라도 [파일] 탭이 그 세션에 붙어 있지 않으면 큐가 없다 → 경로 붙여넣기로 폴백.
      if (!local && uploadFiles(sessionId, paths)) return true
      window.ev.session.input(sessionId, pastePaths(paths))
      // 원격인데 업로드로 못 넘어갔다면 **기대와 다르게 동작한 것**이다 — 조용히 넘기지 않는다
      // (2026-08-16). 슬롯은 이제 세션별이라(#201 B-2) 여기 오는 것은 그 세션에 원격 트리가 없을 때뿐이다.
      if (!local) notifyPasteFallback(t('paste.noQueue'))
      return true
    }

    // F14 + A-3: 클립보드 **파일** 붙여넣기. 키다운이 아니라 진짜 paste 이벤트에서 받는다 —
    // 그래야 Windows 에서도 여러 개가 다 온다. 텍스트는 여기 오지 않는다(xterm 이 처리).
    const offPaste = registerPasteTarget({
      el: host,
      allowEditable: true, // xterm 의 숨은 textarea 가 곧 터미널이다
      onFiles: takeFiles
    })

    /**
     * 🔴 **터미널에 파일을 끌어다 놓는다**(1.0.9, 준영님 요청: *"실제 ai cli 세션창에 파일을
     * 드래그하면 올려달라는거였어. orca가 그렇게 동작할거야."*).
     *
     * 그동안 터미널은 받는 자리가 아니었다 — `main.tsx` 의 전역 가드(#154)가 "여기 못 놓는다"고
     * 커서로 말할 뿐이었다. 그 가드는 **`preventDefault` 안 한 드롭만** 가로채므로, 여기서
     * 받겠다고 말하면 그쪽은 물러난다(그 파일이 창을 통째로 갈아 끼우는 사고도 그대로 막힌다).
     *
     * xterm 이 아니라 `host` 에 건다: xterm 의 화면 요소는 자기가 다시 그리고, 우리는 그 위에
     * 리스너를 얹을 자리가 없다. `host` 는 우리 것이고 이벤트는 버블로 올라온다.
     *
     * ⚠️ **파일만 받는다.** 탭 드래그는 `text/plain` 에 세션 id 를 싣는데 그것까지 받으면
     *    터미널이 "여기 놓을 수 있다"고 거짓말한다(아라 패널·파일 트리가 같은 검사를 한다).
     */
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      host.classList.add('drag-over')
    }
    const onDragLeave = (e: DragEvent): void => {
      // 자식 요소 사이를 지날 때도 dragleave 가 온다 — 진짜로 벗어났을 때만 표시를 걷는다.
      if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return
      host.classList.remove('drag-over')
    }
    const onDrop = (e: DragEvent): void => {
      host.classList.remove('drag-over')
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      takeFiles([...e.dataTransfer.files])
      // 떨군 뒤에는 바로 칠 수 있어야 한다 — 드롭은 포커스를 주지 않는다.
      term.focus()
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('dragleave', onDragLeave)
    host.addEventListener('drop', onDrop)
    fitRef.current = fit
    registerTerm(sessionId, { term, fit, search }) // 선택 복사(F4c)·폰트 적용(F5)·검색(R3.2)

    // R3.1 선택 즉시 복사(X11·PuTTY 관례). 드래그가 끝난 시점 한 번만 — onSelectionChange 는
    // 드래그 중 수십 번 발화해 클립보드를 그만큼 두드린다.
    const onMouseUp = () => {
      if (!termPrefs.copyOnSelect) return
      const sel = term.getSelection()
      if (sel) void writeClipboard(sel)
    }
    host.addEventListener('mouseup', onMouseUp)

    // R5 시각 벨: xterm 5 에는 bellStyle 옵션이 없고 onBell 이벤트만 있다. 설정이 visual 일 때만
    // 패널을 한 번 번쩍인다(CSS .term-pane.bell). off 면 BEL 은 아무 표시도 남기지 않는다.
    let bellTimer: ReturnType<typeof setTimeout> | null = null
    const onBellDisp = term.onBell(() => {
      if (termPrefs.bell !== 'visual') return
      host.classList.add('bell')
      if (bellTimer) clearTimeout(bellTimer)
      bellTimer = setTimeout(() => host.classList.remove('bell'), BELL_FLASH_MS)
    })

    // R3.6 OSC 0/2 제목 → 탭 이름. 적용 여부 판정(사용자 rename 우선)은 main 이 한다.
    const onTitleDisp = term.onTitleChange((title) => {
      const trimmed = title.trim()
      if (trimmed) titleRef.current?.(sessionId, trimmed)
    })

    let pending = 0
    let paused = false
    let disposed = false
    const onWritten = () => {
      pending--
      if (paused && pending <= BACKLOG_RESUME) {
        paused = false
        window.ev.session.resume(sessionId)
      }
    }
    // 재생 중에는 xterm 이 만들어 내는 응답을 셸로 보내지 않는다(아래 onData 참고).
    let replaying = false
    const write = (chunk: Uint8Array, quiet = false) => {
      pending++
      if (quiet) replaying = true
      // Uint8Array → UTF-8 문자열(한글 무결). stream:true로 멀티바이트 경계 보존.
      term.write(UTF8.decode(chunk, { stream: true }), () => {
        if (quiet) replaying = false
        onWritten()
      })
      if (!paused && pending > BACKLOG_PAUSE) {
        paused = true
        window.ev.session.pause(sessionId)
      }
    }

    // 구독 → attach(재생 버퍼) → 그 사이 도착한 라이브 청크 순서대로. attach 응답을 기다리는 동안의
    // 청크를 큐에 담지 않으면 백로그보다 먼저 찍혀 출력 순서가 뒤집힌다.
    let queued: Uint8Array[] | null = []
    const offData = window.ev.session.onData(sessionId, (chunk) => {
      if (queued) queued.push(chunk)
      else write(chunk)
    })
    void window.ev.session
      .attach(sessionId)
      // attach 미지원 경로(구 하네스)에서도 라이브 스트림만으로 동작하도록 폴백.
      .catch(() => ({ backlog: new Uint8Array(0) }))
      .then(({ backlog }) => {
        if (disposed) return
        // quiet=true: 재생 버퍼에는 셸/conpty 가 예전에 보낸 DA(ESC[c) 같은 질의가 그대로 들어 있다.
        // 그걸 다시 파싱한 xterm 은 "지금 물어본 것"으로 알고 `\x1b[?1;2c` 를 pty 로 보내고, 셸은 그것을
        // 입력으로 받아 프롬프트에 `[?1;2c` 를 찍는다. 재생은 과거 화면 복원일 뿐이니 응답하지 않는다.
        if (backlog.length > 0) write(backlog, true)
        const rest = queued ?? []
        queued = null
        for (const c of rest) write(c)
      })
    const offExit = window.ev.session.onExit(sessionId, ({ exitCode }) => {
      term.write(`\r\n\x1b[90m[프로세스 종료 — code ${exitCode}]\x1b[0m\r\n`)
    })

    // 키 입력 → pty로 단방향 send. 라이브 질의(프로그램이 터미널 능력을 물어보는 정상 경로)에는
    // 그대로 답하고, 재생 중 생긴 응답만 버린다.
    const onDataDisp = term.onData((data) => {
      if (replaying) return
      // F11 수집: Enter 로 끊긴 줄만 히스토리에 넣는다. 비밀번호 프롬프트 뒤의 입력은 커밋 시점
      // 커서 줄로 걸러 낸다 — 그 판정은 화면에만 있고 입력 스트림에는 없다.
      const fed = feedInput(lineBuf, data)
      lineBuf = fed.buf
      for (const cmd of fed.commands) {
        if (shouldRecord(cmd, lineBeforeCursor(sessionId))) appendHistory(scope, cmd)
      }
      if (fed.commands.length > 0) clearGhost()
      else scheduleGhost()
      window.ev.session.input(sessionId, data)
    })
    // xterm 리사이즈 → pty resize (창 크기 변경 시 cols/rows 재계산).
    const onResizeDisp = term.onResize(({ cols, rows }) => {
      void window.ev.session.resize(sessionId, cols, rows)
      // 후보 목록은 화면 좌표에 고정돼 있다(fixed) — 셀 크기가 바뀌면 커서와 어긋난 자리에 남는다.
      // 다시 재는 대신 걷는다: 리사이즈 중에 뜬 목록을 쫓아다니게 만들 값어치가 없다.
      clearGhost()
    })

    /**
     * 🔴 **쓸 수 없는 크기로는 화면(xterm)도 맞추지 않는다**(2026-09-29 오류 신고 #4).
     *
     * main 이 먼저 만든 세션(탐색기 `아라` · MCP)은 칸이 정해지기 **전에** 마운트되어, 그 순간 호스트가
     * 아주 작다 — fit 이 9칸으로 맞췄다. main 은 1.0.14 부터 그런 치수를 pty·저장값에서 거르지만
     * (`shared/termSize.ts`) **xterm 자신은 9칸이 된다.** 윈도우 로컬은 windowsMode 라 폭이 돌아와도
     * **줄을 다시 접지 않으므로**, 그 순간 찍힌 프롬프트가 9칸에서 접힌 채 굳었다.
     * 쓸 만한 크기가 나올 때까지 기본값(80×24)으로 두고 기다린다 — ResizeObserver 가 곧 다시 부른다.
     */
    // 초기 fit + pty에 초기 크기 전달.
    fitIfUsable(fit)
    void window.ev.session.resize(sessionId, term.cols, term.rows)

    // 컨테이너 리사이즈 관찰 → fit.
    // 하단바 경계를 끄는 동안은 미룬다(resizeGate) — 안 그러면 프레임마다 fit → term.resize →
    // pty resize IPC 가 나가고, 분할해 둔 칸 수만큼 곱해진다. 놓으면 한 번에 따라잡는다.
    // doFit 은 이 effect 안에서 한 번만 만들어지므로 게이트의 대기 Set 에 중복으로 쌓이지 않는다.
    const doFit = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fitIfUsable(fit)
    }
    const ro = new ResizeObserver(() => whenResizeAllowed(doFit))
    ro.observe(host)

    // 자가 치유(2026-08-31). 행 수가 실제 높이보다 많아지면 프롬프트가 화면 밖으로 내려가 안 보이는데,
    // 다시 맞출 계기는 **크기가 또 바뀔 때**(ResizeObserver)뿐이라 한 번 어긋나면 그대로 굳는다.
    // 포커스는 드물게 오고 값이 싸다 — fit() 은 치수가 이미 맞으면 아무것도 하지 않는다.
    // 게이트를 거치지 않는 것이 핵심이다: 게이트가 붙들린 채 남은 상황이 바로 나아야 할 상황이다.
    const onFocus = (): void => doFit()
    textarea?.addEventListener('focus', onFocus)

    return () => {
      disposed = true
      ro.disconnect()
      // 죽은 pane 의 fit 을 대기줄에 남기지 않는다(게이트가 붙들린 동안 탭을 닫은 경우).
      cancelPendingResize(doFit)
      textarea?.removeEventListener('focus', onFocus)
      host.removeEventListener('mouseup', onMouseUp)
      offData()
      offExit()
      onDataDisp.dispose()
      onResizeDisp.dispose()
      onTitleDisp.dispose()
      onBellDisp.dispose()
      if (bellTimer) clearTimeout(bellTimer)
      clearGhost()
      textarea?.removeEventListener('blur', onBlur)
      textarea?.removeEventListener('compositionstart', onCompStart)
      textarea?.removeEventListener('compositionend', onCompEnd)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('dragleave', onDragLeave)
      host.removeEventListener('drop', onDrop)
      offPaste()
      unregisterTerm(sessionId)
      try {
        webgl?.dispose()
      } catch {
        // 이미 컨텍스트 로스트로 해제된 경우 — 무시.
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // local·serverKey 는 세션 수명 동안 불변이라 재실행을 유발하지 않는다.
    // aiCli 도 같다 — 세션을 만들 때 한 번 정해지고 살아 있는 동안 안 바뀐다(그래서 히스토리
    // 통이 세션 도중에 갈리지 않는다. 바뀌게 만들면 여기서 xterm 이 다시 만들어져 스크롤백이 증발한다).
  }, [sessionId, local, serverKey, aiCli])

  // 탭이 활성화될 때 fit + 포커스(숨김→표시 시 xterm 크기 0이었던 문제 보정).
  useEffect(() => {
    if (active && fitRef.current && hostRef.current?.clientWidth) {
      // 쓸 수 없는 크기로는 맞추지 않는다(오류 신고 #4·#10 — termRegistry.fitIfUsable).
      fitIfUsable(fitRef.current)
      termRef.current?.focus()
    }
    // 이 패널이 숨으면 후보 목록도 걷는다 — 안 그러면 다른 패널 위에 남는다(fixed 라서).
    if (!active) clearGhostRef.current()
  }, [active])

  return (
    <div className="term-pane" ref={hostRef}>
      {/* F11 R2 후보 목록(제보 10) — 커서 옆에 뜨는 IDE 식 목록. #194 ① 이후로 **`↓` 를 눌러야**
          열린다(타이핑 중에는 회색 고스트 한 줄뿐이다). 클릭 대상이 아니다: 손이 키보드에 있는
          자리라 ↑↓ 로 고르고 →·Enter 로 넣는다(마우스로 집으려면 터미널 포커스가 빠져 다음 글자를
          놓친다). xterm 이 이 div 를 건드리지 않도록 형제로 둔다. */}
      {comp && (
        <div
          className="term-comp"
          style={comp.up ? { left: comp.left, bottom: comp.y } : { left: comp.left, top: comp.y }}
          aria-hidden
        >
          {comp.items.map((it, i) => (
            <div key={it} className={'ci' + (i === comp.index ? ' on' : '')}>
              {it}
            </div>
          ))}
          <div className="ci-hint">{t('term.comp.hint')}</div>
        </div>
      )}
    </div>
  )
}
