import { useEffect, useRef } from 'react'
import { Terminal, type IDecoration, type IMarker, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { lineBeforeCursor, registerTerm, unregisterTerm } from './termRegistry'
import { termPrefs } from './termPrefs'
import { notifyPasted, writeClipboard } from '../store/clipboardWrite'
import { appendHistory, cachedHistory, feedInput, ghostFor, loadHistory, shouldRecord } from '../store/history'
import { notifyPasteFallback, uploadFiles } from '../store/uploadBus'
import { filePaths, registerPasteTarget } from '../store/pasteFiles'
import { pastePaths } from '../components/filePath'
import { isAppShortcut } from '../../shared/keymap'
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
    selectionBackground: v('--sel-bg', 'rgba(56,189,248,0.28)'),
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
// F11 고스트를 그리기 전에 기다리는 시간. 입력은 pty 를 돌아 에코로 와야 커서가 움직이므로,
// 키를 누른 그 순간에 그리면 커서 위치가 한 칸 뒤처져 고스트가 어긋난다.
const GHOST_DELAY_MS = 45
// 에코를 기다리는 최대 횟수. 원격 SSH·conpty 가 밀릴 때 한두 번으로는 못 따라잡는다
// (실측: 백스페이스를 연달아 보낸 뒤 첫 글자 에코가 100ms 넘게 늦는다). 총 대기 ≈ 0.4초.
const GHOST_RETRIES = 8
const UTF8 = new TextDecoder('utf-8', { fatal: false })

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
let webglUsable: boolean | null = null
function canUseWebgl(): boolean {
  if (webglUsable !== null) return webglUsable
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return (webglUsable = false)
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return (webglUsable = !/swiftshader|software|llvmpipe/i.test(renderer))
  } catch {
    return (webglUsable = false)
  }
}

type Props = {
  sessionId: string
  active: boolean
  local: boolean
  // F11 히스토리 scope — SSH 는 서버별(serverKey), 로컬은 'local'. 서버마다 쓰는 명령이 달라서
  // 한 통에 섞으면 고스트가 남의 서버 명령을 물어 온다.
  serverKey: string
  // R3.6: 셸이 보낸 OSC 0/2 제목. 사용자가 rename 한 세션이면 상위(MainArea)가 무시한다.
  onTitle?: (sessionId: string, title: string) => void
  // F8: Ctrl+클릭한 URL. 라우팅(포워딩·내장 브라우저·OS 브라우저)은 MainArea 가 한다 —
  // 실패를 알릴 다이얼로그가 거기 있고, 여기(xterm 배선)에 IPC 흐름을 두면 두 관심사가 섞인다.
  onLink?: (sessionId: string, url: string, isSsh: boolean) => void
}

// 단일 세션 xterm 페인. 인스턴스 수명 = 세션 수명이다: PaneGrid 가 세션마다 이 컴포넌트를 하나씩
// 마운트해 두고 표시 위치만 바꾸므로(패널의 세션이 바뀌어도 언마운트되지 않는다) 스크롤백이 보존된다.
// 그래도 xterm 이 새로 만들어지는 경우(세션 신규·앱 재기동·StrictMode 이중 마운트)는 남으므로,
// mount 직후 session.attach 로 main 의 재생 버퍼를 받아 화면을 되살린다.
export function TerminalPane({ sessionId, active, local, serverKey, onTitle, onLink }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // onTitle 은 상위 렌더마다 새 함수라 effect deps 에 넣으면 xterm 이 재생성된다(스크롤백 증발).
  const titleRef = useRef(onTitle)
  titleRef.current = onTitle
  const linkRef = useRef(onLink)
  linkRef.current = onLink

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
    const scope = local ? 'local' : serverKey
    void loadHistory(scope)
    let lineBuf = '' // 사용자가 지금 줄에 친 내용(입력 스트림에서 재구성)
    let ghostSuffix = '' // 화면에 떠 있는 나머지 — 비어 있으면 Tab·ESC 는 셸로 그대로 간다
    let ghostDeco: IDecoration | null = null
    let ghostMarker: IMarker | null = null
    let ghostTimer: ReturnType<typeof setTimeout> | null = null

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
    }

    const renderGhost = (retry: number) => {
      ghostTimer = null
      if (!lineBuf) return
      // 에코가 아직 안 왔으면 커서가 한 칸 뒤처져 고스트가 어긋난다 — 한 번 더 기다린다.
      if (!lineBeforeCursor(sessionId).endsWith(lineBuf)) {
        if (retry > 0) ghostTimer = setTimeout(() => renderGhost(retry - 1), GHOST_DELAY_MS)
        return
      }
      const match = ghostFor(cachedHistory(scope), lineBuf)
      if (!match) return
      const suffix = match.slice(lineBuf.length)
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

    const scheduleGhost = () => {
      clearGhost()
      if (!lineBuf) return
      ghostTimer = setTimeout(() => renderGhost(GHOST_RETRIES), GHOST_DELAY_MS)
    }

    // Tab 채택: 나머지를 셸에 실제로 입력한다(화면의 흐린 글자를 진짜 입력으로 바꾼다).
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
      // F11: 고스트가 떠 있을 때만 Tab=채택 / ESC=해제. 없으면 셸의 자동완성·인터럽트를 그대로
      // 통과시킨다(R3.8 정책 — 앱이 셸 기능을 뺏지 않는다).
      if (ghostSuffix && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'Tab') {
          // false 만 돌려주면 xterm 이 손을 떼면서 브라우저 기본 동작(Tab = 포커스 이동)이 살아나
          // 터미널이 포커스를 잃는다 — 채택 직후 타이핑이 먹통이 된다.
          e.preventDefault()
          acceptGhost()
          return false
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          clearGhost()
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
        void navigator.clipboard
          .readText()
          .then((t2) => {
            if (t2) notifyPasted()
          })
          .catch(() => {})
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
          if (e.ctrlKey || e.metaKey) linkRef.current?.(sessionId, uri, !local)
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
        webgl.onContextLoss(() => webgl?.dispose())
        term.loadAddon(webgl)
      } catch (err) {
        webgl = null
        console.warn('[term] WebGL 렌더러 초기화 실패 — DOM 폴백', err)
      }
    }
    termRef.current = term

    // F14 + A-3: 클립보드 **파일** 붙여넣기. 키다운이 아니라 진짜 paste 이벤트에서 받는다 —
    // 그래야 Windows 에서도 여러 개가 다 온다. 텍스트는 여기 오지 않는다(xterm 이 처리).
    const offPaste = registerPasteTarget({
      el: host,
      allowEditable: true, // xterm 의 숨은 textarea 가 곧 터미널이다
      onFiles: (files) => {
        const paths = filePaths(files)
        // 텍스트 붙여넣기는 xterm 이 자기 textarea 로 처리한다(bracketed paste 포함) — 넘긴다.
        if (paths.length === 0) return false
        // 원격이라도 [파일] 탭이 그 세션에 붙어 있지 않으면 큐가 없다 → 경로 붙여넣기로 폴백.
        if (!local && uploadFiles(sessionId, paths)) return true
        window.ev.session.input(sessionId, pastePaths(paths))
        // 원격인데 업로드로 못 넘어갔다면 **기대와 다르게 동작한 것**이다 — 조용히 넘기지 않는다
        // (2026-08-16). 업로더 슬롯이 하나뿐이라 작업대를 열면 이쪽이 밀려나 "됐다 안 됐다" 한다.
        if (!local) notifyPasteFallback(t('paste.noQueue'))
        return true
      }
    })
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
    })

    // 초기 fit + pty에 초기 크기 전달.
    fit.fit()
    void window.ev.session.resize(sessionId, term.cols, term.rows)

    // 컨테이너 리사이즈 관찰 → fit.
    const ro = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      host.removeEventListener('mouseup', onMouseUp)
      offData()
      offExit()
      onDataDisp.dispose()
      onResizeDisp.dispose()
      onTitleDisp.dispose()
      onBellDisp.dispose()
      if (bellTimer) clearTimeout(bellTimer)
      clearGhost()
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
  }, [sessionId, local, serverKey])

  // 탭이 활성화될 때 fit + 포커스(숨김→표시 시 xterm 크기 0이었던 문제 보정).
  useEffect(() => {
    if (active && fitRef.current && hostRef.current?.clientWidth) {
      fitRef.current.fit()
      termRef.current?.focus()
    }
  }, [active])

  return <div className="term-pane" ref={hostRef} />
}
