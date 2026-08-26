// F8 내장 브라우저 — **탭**. 2026-08-21 준영님 제보:
//   "모니터를 열고 다른 포트에서 열면 그전에가 사라지는데 이 모니터도 탭 형식으로."
// 그전까지 `open(url)` 은 창 하나를 `loadURL` 로 **덮어썼다.** 포트 8080 을 보다가 3000 을 열면
// 앞의 것이 사라진다 — 서버 둘을 나란히 보려고 미리보기를 쓰는데 그게 안 됐다.
//
// ── 보안 경계는 그대로다 (중요) ────────────────────────────────────────────
// 예전 설계 근거: "창 하나면 webPreferences 경계가 통째로 하나라 '이 창은 window.ev 를 절대
// 못 본다'를 여기서 증명할 수 있다." 탭을 넣으면 그 창 안에 **우리 UI(탭 줄)** 도 들어온다.
//
// 그래서 경계를 창이 아니라 **WebContents 단위**로 옮긴다:
//   · 창의 최상위 webContents = 우리 렌더러(#browserwin). preload 있음. 우리 코드만 산다
//   · 탭 하나 = WebContentsView. **preload 없음 · sandbox · 전용 파티션 · 스킴 게이트**
// 원격 페이지는 여전히 preload 를 못 보고 window.ev 에 닿을 수 없다 — 창 경계가 하던 증명을
// contents 경계가 그대로 한다(tests/w2-browser.cjs 가 탭 쪽 webContents 를 검사하도록 바뀐다).
//
// 남은 위장 위험 하나: 탭 라벨. **페이지 제목을 쓰지 않고 오리진만 쓴다** — 제목을 쓰면
// 원격 페이지가 "A.R.A 설정" 같은 이름의 탭으로 앉을 수 있다(옛 창 제목 규칙과 같은 이유).
import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'
import { isSafeExternal } from '../util/safeExternal'
import { pushSend } from '../util/windowPush'
import { BROWSER_PARTITION, BROWSER_TITLE, hardenSession, wireTabContents } from './BrowserService'
import { BROWSER_WIN_HASH } from '../../shared/browserWin'

const WIDTH = 1100
const HEIGHT = 800
const BACKGROUND = '#1e1e20'
/** 탭 줄 높이. 렌더러 CSS(.bw-tabs)와 **같은 값**이어야 뷰가 그 아래에 정확히 앉는다. */
export const TAB_STRIP_H = 34

export type BrowserTab = { id: string; origin: string; url: string; loading: boolean }

let win: BrowserWindow | null = null
let seq = 0
const tabs: { id: string; view: WebContentsView; url: string }[] = []
let activeId: string | null = null
/**
 * 본창을 찾는 길. **탭 상태를 본창에도 알리려고** 들고 있다 (2026-08-22 준영님 제보 1번:
 * 포트 모니터의 [열기]가 브라우저에 그 포트가 떠 있으면 [닫기]로 바뀌어야 한다). 그러려면
 * 포트 표가 "지금 무엇이 열려 있는지"를 알아야 하는데, 그 사실은 여기에만 있다.
 * openTab 이 처음 불릴 때 채워진다(창을 만들기 전에도 알림이 필요할 일은 없다).
 */
let getMain: (() => BrowserWindow | null) | null = null

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * 렌더러(탭 줄)에 지금 상태를 알린다. 라벨은 **오리진만** — 페이지 제목은 쓰지 않는다.
 *
 * 본창에도 같은 것을 보낸다: 포트 표의 [열기]/[닫기]가 이 목록을 보고 라벨을 정한다.
 * 창이 닫혀 목록이 비었을 때도 보내야 한다 — 그래야 [닫기]가 [열기]로 돌아온다.
 */
function publish(): void {
  const alive = win !== null && !win.isDestroyed()
  const list: BrowserTab[] = alive
    ? tabs.map((t) => ({
        id: t.id,
        origin: originOf(t.url) || t.url,
        url: t.url,
        loading: !t.view.webContents.isDestroyed() && t.view.webContents.isLoading()
      }))
    : []
  const payload = { tabs: list, activeId: alive ? activeId : null }
  // 이 push 도 단일 지점을 거친다(scan:push).
  if (alive && win) pushSend(win.webContents, 'browser:tabs', payload)
  const main = getMain?.() ?? null
  if (main && !main.isDestroyed()) pushSend(main.webContents, 'browser:tabs', payload)
}

/** 활성 탭만 보이게 한다. 숨김은 bounds 0 이 아니라 visible 로 — 0 크기 뷰는 리사이즈가 튄다. */
function layout(): void {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getContentBounds()
  for (const t of tabs) {
    const on = t.id === activeId
    t.view.setVisible(on)
    if (on) t.view.setBounds({ x: 0, y: TAB_STRIP_H, width, height: Math.max(0, height - TAB_STRIP_H) })
  }
}

function ensureWindow(getParent: () => BrowserWindow | null): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  const parent = getParent()
  win = new BrowserWindow({
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    modal: false,
    width: WIDTH,
    height: HEIGHT,
    title: BROWSER_TITLE,
    backgroundColor: BACKGROUND,
    // 네이티브 프레임 — "앱 UI 가 아니라 브라우저"임이 즉시 읽혀야 한다(옛 규칙 유지).
    frame: true,
    show: false,
    webPreferences: {
      // 이 최상위 contents 는 **우리 탭 줄**이다. 원격 콘텐츠는 아래 WebContentsView 에만 산다.
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  // Electron 기본 메뉴(File/Edit/View/Window/Help)를 뗀다 — 우리 메뉴바는 본창 타이틀바의 HTML 이고
  // 이 창에는 그릴 메뉴가 없다. 프레임이 있는 창에만 그려져서 여기서만 튀어나온다(2026-08-23).
  win.removeMenu()
  const w = win
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void w.loadURL(devUrl + '/' + BROWSER_WIN_HASH)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: BROWSER_WIN_HASH.slice(1) })

  w.once('ready-to-show', () => w.show())
  // 첫 탭은 창을 만들자마자 열리는데 그때 렌더러는 아직 로딩 중이라 `browser:tabs` 를 못 받는다
  // — 그러면 **탭 줄이 빈 채로 뜬다.** 로드가 끝나면 한 번 더 알린다(값은 main 이 갖고 있다).
  w.webContents.on('did-finish-load', () => {
    layout()
    publish()
  })
  w.on('resize', layout)
  w.on('closed', () => {
    for (const t of tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    tabs.length = 0
    activeId = null
    if (win === w) win = null
    // 창을 통째로 닫아도 포트 표의 [닫기]가 [열기]로 돌아와야 한다 — 빈 목록을 알린다.
    publish()
  })
  return w
}

/** 새 탭을 만든다(같은 오리진이 이미 있으면 그 탭을 재사용 — 미리보기는 오리진 단위로 본다). */
export function openTab(url: string, getParent: () => BrowserWindow | null): boolean {
  if (!isSafeExternal(url)) return false
  getMain = getParent // 본창에도 탭 상태를 알리기 위해(publish 주석 참고)
  const w = ensureWindow(getParent)

  const same = tabs.find((t) => originOf(t.url) === originOf(url) && originOf(url) !== '')
  if (same) {
    if (same.url !== url) void same.view.webContents.loadURL(url)
    same.url = url
    activeId = same.id
  } else {
    const view = new WebContentsView({
      webPreferences: {
        // preload 를 주지 않는다 — 원격 페이지는 window.ev 를 절대 못 본다(테스트로 어서션).
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
    const id = `t${++seq}`
    const rec = { id, view, url }
    tabs.push(rec)
    activeId = id
    w.contentView.addChildView(view)
    wireTabContents(view.webContents, {
      onNavigate: (u) => {
        rec.url = u
        publish()
      },
      onLoading: publish,
      close: () => closeTab(id)
    })
    void view.webContents.loadURL(url)
  }

  layout()
  publish()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  return true
}

export function selectTab(id: string): void {
  if (!tabs.some((t) => t.id === id)) return
  activeId = id
  layout()
  publish()
}

export function closeTab(id: string): void {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  const [gone] = tabs.splice(i, 1)
  if (win && !win.isDestroyed()) win.contentView.removeChildView(gone.view)
  if (!gone.view.webContents.isDestroyed()) gone.view.webContents.close()
  // 닫힌 것이 활성이었으면 옆 탭으로. 마지막 하나였으면 창을 닫는다 — 빈 브라우저 창을 남기지 않는다.
  if (activeId === id) activeId = (tabs[i] ?? tabs[i - 1])?.id ?? null
  if (tabs.length === 0) {
    if (win && !win.isDestroyed()) win.close()
    return
  }
  layout()
  publish()
}

/**
 * 그 오리진의 탭을 닫는다 (2026-08-22 준영님 제보 1번 — 포트 표의 [닫기]).
 *
 * "브라우저 창에서 단일로 있을 경우 브라우저 닫기, 탭으로 있을 경우 탭 닫기"는 closeTab 이 이미
 * 그렇게 한다(마지막 탭이면 창을 닫는다) — 여기서 두 번째 규칙을 만들지 않는다.
 * 열려 있지 않으면 false: 호출측이 "이미 닫혔다"를 알 수 있다.
 */
export function closeTabByOrigin(origin: string): boolean {
  const hit = tabs.find((t) => originOf(t.url) === origin)
  if (!hit) return false
  closeTab(hit.id)
  return true
}

export function reloadActive(): void {
  const t = tabs.find((x) => x.id === activeId)
  if (t && !t.view.webContents.isDestroyed()) t.view.webContents.reload()
}

export function goBackActive(): void {
  const wc = tabs.find((x) => x.id === activeId)?.view.webContents
  if (wc && !wc.isDestroyed() && wc.canGoBack()) wc.goBack()
}

export function closeBrowserWindow(): void {
  if (win && !win.isDestroyed()) win.close()
  win = null
}

/** 테스트·스크린샷용. 창 자체와 **활성 탭의 webContents**(보안 검사 대상). */
export function browserWindowForTest(): { win: BrowserWindow | null; tab: WebContents | null } {
  const tab = tabs.find((t) => t.id === activeId)?.view.webContents ?? null
  return { win: win && !win.isDestroyed() ? win : null, tab }
}

// 호출부 계약은 그대로 둔다(registerForwardIpc 가 이 모양을 본다) — 속만 탭으로 바뀌었다.
export type BrowserService = {
  /** 스킴이 http/https 가 아니면 열지 않고 false. 렌더러를 신뢰하지 않는 이중 방어. */
  open(url: string): boolean
  /** 그 오리진 탭을 닫는다(마지막이면 창째). 안 열려 있었으면 false — MCP browser_close 가 쓴다. */
  closeOrigin(origin: string): boolean
  current(): BrowserWindow | null
  close(): void
}

export function createBrowserService(getParent: () => BrowserWindow | null): BrowserService {
  return {
    open: (url) => openTab(url, getParent),
    closeOrigin: closeTabByOrigin,
    current: () => browserWindowForTest().win,
    close: closeBrowserWindow
  }
}
