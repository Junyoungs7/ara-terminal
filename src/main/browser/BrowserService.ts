// F8 내장 브라우저 — 메인 창과 별개인 크로미움 창 **하나**를 만들어 재사용한다.
// 용도는 둘뿐이다: 원격 CLI 의 OAuth loopback 콜백을 받는 것, 포워딩한 웹 미리보기를 보는 것.
//
// 창을 따로 두는 이유(설계 §1): WebContentsView 를 메인 창에 붙이면 React 오버레이(설정 드로어·모달·
// 컨텍스트 메뉴·검색 바)가 전부 그 밑에 깔려 R1~R8 레이아웃 코드 전역에 숨김/복원 배선을 심어야 한다.
// 창 하나면 webPreferences 경계가 통째로 하나라 "이 창은 window.ev 를 절대 못 본다"를 여기서 증명할 수 있다.
//
// 불변식 (설계 §1.1 / 보안 체크리스트 — 자동 어서션 대상: tests/w2-browser.cjs):
//   · preload 미주입 · sandbox · contextIsolation · nodeIntegration 없음 · webviewTag 없음
//   · 전용 파티션(앱 세션 쿠키·저장소와 완전 분리)
//   · http/https 외 스킴은 진입(browser:open)과 이동(will-navigate/will-redirect) 양쪽에서 차단
//   · 권한 요청 전부 거부 · 다운로드 차단 · 새 창 금지
//   · 인증서 오류 핸들러를 **등록하지 않는다** → Electron 기본값(거부)이 그대로 산다
//   · 창 제목은 우리가 현재 오리진으로 정한다(원격 페이지가 제목을 위장할 수 없다)
import { BrowserWindow, session, type WebContents } from 'electron'
import { isSafeExternal } from '../util/safeExternal'

// 앱 default 세션과 쿠키 저장소를 분리한다. persist 인 이유: 같은 구글 계정으로 두 번째 CLI 를
// 인증할 때 재로그인을 다시 시키지 않기 위해서다.
export const BROWSER_PARTITION = 'persist:ara-browser'
export const BROWSER_TITLE = 'A.R.A 브라우저'

const WIDTH = 1100
const HEIGHT = 800
const BACKGROUND = '#0d1119'

export type BrowserService = {
  // 스킴이 http/https 가 아니면 창을 열지 않고 false. 렌더러를 신뢰하지 않는 이중 방어다.
  open(url: string): boolean
  // 테스트·스크린샷용 현재 창(없으면 null).
  current(): BrowserWindow | null
  close(): void
}

// 파티션 세션 단위 정책. 창을 닫았다 다시 열어도 세션 객체는 같으므로 한 번만 걸면 된다.
function hardenSession(partition: string): Electron.Session {
  const ses = session.fromPartition(partition)
  // 카메라·마이크·위치·알림·클립보드 읽기·USB/시리얼/HID … 전부 거부. OAuth 와 미리보기에 필요한 권한은 없다.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  // 다운로드 차단: 이 기능의 목적은 인증과 미리보기지 파일 받기가 아니다(파일은 SFTP 가 담당).
  // ponytail: 전면 차단이 상한 — 실제 요구가 나오면 저장 대화상자 경유로 승격한다.
  ses.on('will-download', (e) => e.preventDefault())
  return ses
}

// 이 창 안에서 일어나는 모든 이동·팝업·키를 통제한다.
function wireWebContents(wc: WebContents, win: BrowserWindow): void {
  // 스킴 게이트(app:openExternal 과 같은 isSafeExternal 단일 소스). 막는 것: 원격 페이지가
  // file:/// · ms-msdt: · slack: 같은 스킴으로 로컬 파일 열람·외부 프로그램 실행을 유도하는 경로.
  const gate = (e: { preventDefault: () => void }, url: string): void => {
    if (!isSafeExternal(url)) e.preventDefault()
  }
  wc.on('will-navigate', (e, url) => gate(e, url))
  wc.on('will-redirect', (e, url) => gate(e, url))
  // will-navigate 는 메인 프레임 전용이라 서브프레임 탐색은 놓친다(W2 보안 리뷰 L4). 실측으로
  // 서브프레임 file:// 탈출은 Chromium 자체가 막았지만, 심층 방어 차원에서 같은 스킴 게이트를 건다.
  wc.on('will-frame-navigate', (e) => gate(e, e.url))

  // 새 창은 만들지 않는다. http/https 면 같은 창에서 이어 간다 — 팝업 난립·오리진 위장보다 낫다.
  // ponytail: 팝업 기반 OAuth(window.opener postMessage)는 이 정책에서 깨진다. CLI 의 loopback
  // 리다이렉트 플로우는 팝업을 쓰지 않으므로 지금은 문제없다. 실제로 막히면 그때 팝업을 허용한다.
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })

  // 제목은 우리가 정한다. 페이지가 보낸 제목을 그대로 쓰면 원격 콘텐츠가 "A.R.A 설정" 같은 이름으로
  // 앱 UI 인 척할 수 있다. OS 타이틀바가 항상 현재 오리진을 보여 주는 것이 피싱 인지의 최소선이다.
  win.on('page-title-updated', (e) => e.preventDefault())
  const showOrigin = (url: string): void => {
    if (win.isDestroyed()) return
    let origin = ''
    try {
      origin = new URL(url).origin
    } catch {
      origin = ''
    }
    win.setTitle(origin ? `${origin} — ${BROWSER_TITLE}` : BROWSER_TITLE)
  }
  wc.on('did-navigate', (_e, url) => showOrigin(url))
  wc.on('did-navigate-in-page', (_e, url) => showOrigin(url))

  // 최소 조작키만. OAuth 는 "계정을 잘못 골랐다 → 뒤로"가 흔해서 뒤로가기 없는 브라우저는 실사용이 안 된다.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.alt && input.key === 'ArrowLeft' && wc.canGoBack()) {
      e.preventDefault()
      wc.goBack()
    } else if (input.alt && input.key === 'ArrowRight' && wc.canGoForward()) {
      e.preventDefault()
      wc.goForward()
    } else if (input.control && input.key.toLowerCase() === 'r') {
      e.preventDefault()
      wc.reload()
    } else if (input.control && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      win.close()
    }
  })
}

// getParent: 메인 창(없으면 null). parent 를 주면 앱 뒤로 사라지지 않고 앱과 함께 닫힌다.
export function createBrowserService(getParent: () => BrowserWindow | null): BrowserService {
  let win: BrowserWindow | null = null

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win
    const parent = getParent()
    win = new BrowserWindow({
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      // modal 아님 — 인증하는 동안에도 터미널을 계속 조작할 수 있어야 한다.
      modal: false,
      width: WIDTH,
      height: HEIGHT,
      title: BROWSER_TITLE,
      backgroundColor: BACKGROUND,
      // 네이티브 프레임을 쓴다: 사용자가 "이건 앱 UI 가 아니라 브라우저 창"이라고 즉시 알아야 한다.
      // 앱의 프레임리스 타이틀바를 흉내 내면 원격 웹 콘텐츠가 A.R.A UI 인 척할 여지가 생긴다.
      frame: true,
      show: false,
      webPreferences: {
        // preload 를 주지 않는다 — 이 창은 window.ev 를 절대 보지 못한다(테스트로 어서션).
        session: hardenSession(BROWSER_PARTITION),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false
      }
    })
    // 인증서 오류 핸들러를 여기에 **등록하지 않는다**. Electron 기본 동작 = 거부 + 오류 페이지.
    // 알려진 한계: 원격 개발 서버가 자체서명 https 를 서빙하면 열리지 않는다(http 로 쓰면 된다).
    wireWebContents(win.webContents, win)
    win.once('ready-to-show', () => win?.show())
    win.on('closed', () => {
      win = null
    })
    return win
  }

  return {
    open(url) {
      if (!isSafeExternal(url)) return false
      const w = ensure()
      void w.loadURL(url)
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      return true
    },
    current: () => (win && !win.isDestroyed() ? win : null),
    close() {
      if (win && !win.isDestroyed()) win.close()
      win = null
    }
  }
}
