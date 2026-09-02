// F32 세션 창 — 탭을 떼어내 별도 OS 창으로 띄운다(다른 모니터에 놓으려고).
//
// 준영님 요청(2026-08-17): "창을 떼서 스플릿 뿐만 아니라 다른 모니터 혹은 창을 아예 분리하는거지.
// 그리고 거기에도 분할을 할 수 있게. 그 창에서도 따로 하단바가 보이는거지."
//
// **왜 이게 가능한가**: pty·SSH 세션은 main 프로세스에 살고(MainSessionManager) 렌더러는 IPC 로
// 화면만 받는다. 그래서 창을 떼어내도 세션이 안 죽고, "떼어내기"는 **소유 창 표시(Session.winId)를
// 바꾸는 일**로 끝난다. 프로세스를 옮기거나 다시 붙이는 절차가 없다.
//
// 창 자체는 EditorWindows·RdpWindows 와 **같은 방식**이다: 같은 렌더러 번들을 해시(#sessionwin)로
// 갈라 쓴다 — 별도 번들·별도 preload 를 만들지 않는다(폰트·토큰·CSS 가 전부 이미 거기 있다).
//
// 창 안에 무엇이 있나(준영님 확정 — "작업 창"): 탭바 · 분할 그리드 · 하단바 · 상태바.
// 연결 트리·아라·설정은 **넣지 않는다** — 그것들은 본창에서 하고, 이 창은 "이 서버를 보는 화면"에
// 집중한다. 설정 드로어가 두 창에 동시에 뜨는 상태를 만들지 않는 것도 이 선택의 이유다.
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { sessionWinHash } from '@shared/sessionWin'

const WIDTH = 1100
const HEIGHT = 720
// G(Fleet) 팔레트의 --bg-canvas. 첫 페인트 전 잠깐 보이는 색이라 앱 배경과 같아야 깜빡임이 없다
// (2026-08-22: 리브랜딩·팔레트 교체 때 빠져 옛 남색 #0d1119 가 남아 있었다).
const BACKGROUND = '#1e1e20'

/** winId → 창. 창이 닫히면 지워진다(닫힘 정리는 여는 쪽이 콜백으로 받는다). */
const windows = new Map<string, BrowserWindow>()
/** 닫아도 된다고 답을 받은 창 — 다음 close 는 묻지 않고 통과시킨다(아래 forceClose 가 넣는다). */
const cleared = new Set<string>()

// 끌어다 놓은 자리에 창을 놓을 때 커서를 창의 어디에 두는가. 탭바가 커서 밑에 오도록 —
// 제목줄(약 30) 아래가 탭바다. 크롬이 탭을 떼어낼 때와 같은 감각.
const GRAB_X = 120
const GRAB_Y = 40

export type SessionWinBounds = { x: number; y: number; width: number; height: number }

export function sessionWindowOf(winId: string): BrowserWindow | null {
  const w = windows.get(winId)
  return w && !w.isDestroyed() ? w : null
}

/**
 * 그 화면 좌표에 **우리 창**이 있는가(2026-08-23 제보 5).
 *
 * 탭을 놓은 자리가 다른 아라 창이면 새 창을 만들지 않는다 — 그쪽 창이 이미 자기 방식대로
 * 처리했거나(탭바 = 합치기), 처리하지 않기로 한 자리다. 렌더러는 **자기 창의 좌표만** 알아서
 * 이 판단을 못 한다(다른 창은 다른 프로세스의 화면이다). main 만 전부의 자리를 안다.
 *
 * `exclude` 는 드래그를 시작한 창 — 자기 자신 위에 놓은 것은 "다른 창"이 아니다(그 경우는
 * 사이드바·하단바에 놓은 것이라 새 창이 맞다).
 */
export function araWindowAt(x: number, y: number, exclude: BrowserWindow | null, extra: readonly (BrowserWindow | null)[] = []): boolean {
  const inside = (w: BrowserWindow | null): boolean => {
    try {
      if (!w || w.isDestroyed() || w === exclude || w.isMinimized()) return false
      const b = w.getBounds()
      return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
    } catch {
      return false // 파괴 레이스 — 그 창은 없는 것으로 친다
    }
  }
  return [...extra, ...windows.values()].some(inside)
}

/**
 * 창을 놓을 자리 — **화면 안에 있는지 확인한다.**
 *
 * 왜 필요한가: 듀얼 모니터에서 오른쪽 화면에 떼어 놓고 저장한 뒤, 노트북만 들고 나가서 켜면
 * 그 좌표(예: x=2560)가 **아무 디스플레이에도 없다**. 창은 열리지만 화면 밖이라 찾을 수도,
 * 끌어올 수도 없다 — 사용자에게는 "창이 안 뜬다"로 보인다. 그때는 저장된 자리를 버리고
 * 기본 크기로 연다(기본 자리는 OS 가 주 모니터에 잡아 준다).
 *
 * 판정은 **좌상단 한 점**으로 한다: 일부만 걸쳐 있어도 제목줄이 보이면 잡아 옮길 수 있다.
 * 순수 함수 — tests/sessionWin.test.ts 가 검증한다(실제 모니터 구성 없이).
 */
export function usableBounds(
  saved: SessionWinBounds | undefined,
  displays: readonly { bounds: SessionWinBounds }[]
): SessionWinBounds | null {
  if (!saved) return null
  const onScreen = displays.some(({ bounds: b }) => {
    return saved.x >= b.x && saved.x < b.x + b.width && saved.y >= b.y && saved.y < b.y + b.height
  })
  return onScreen ? saved : null
}

/** 놓은 점 → 창 자리. 화면 밖 판정은 usableBounds 가 마저 한다(끝에 놓으면 기본 자리로). */
function droppedAt(at: { x: number; y: number } | undefined): SessionWinBounds | undefined {
  if (!at) return undefined
  return { x: Math.round(at.x - GRAB_X), y: Math.round(at.y - GRAB_Y), width: WIDTH, height: HEIGHT }
}

export function openSessionWindow(
  winId: string,
  title: string,
  opts: {
    bounds?: SessionWinBounds
    /** 탭을 놓은 화면 좌표(드래그로 떼어낼 때). bounds 가 있으면 그쪽이 이긴다 — 복원은 저장한 자리로. */
    at?: { x: number; y: number }
    onClosed: (winId: string) => void
    /**
     * 창을 닫으려 할 때 — true 를 돌려주면 **닫기를 막는다**(물어보는 중이라는 뜻).
     * 답은 forceCloseSessionWindow 로 온다. 없으면 예전처럼 그냥 닫힌다.
     */
    onCloseAsk?: (winId: string) => boolean
  }
): BrowserWindow {
  const existing = sessionWindowOf(winId)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  const box = usableBounds(opts.bounds ?? droppedAt(opts.at), screen.getAllDisplays())
  const win = new BrowserWindow({
    ...(box ?? { width: WIDTH, height: HEIGHT }),
    title,
    backgroundColor: BACKGROUND,
    show: false,
    /**
     * 2026-08-23 준영님: "새창 상단 닫기 내리기 전체 디자인도 우리 아라 디자인과 동일해야해."
     * 프레임을 끄고 본창과 **같은 타이틀바 컴포넌트**를 그린다(TitleBar) — 신호등·드래그 영역까지
     * 같은 CSS 를 쓴다. 창 제목은 그 바 안에 있고, 작업표시줄용 제목은 document.title 이 맡는다.
     */
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  /**
   * 2026-08-23 준영님: "새 창에서는 상단에 file, edit 등 설정 버튼은 제거해줘".
   *
   * 그 메뉴는 **우리 것이 아니다** — 우리 메뉴바는 타이틀바 안의 HTML 이고(파일·편집·세션…),
   * 본창은 프레임리스라 그것만 보인다. 여기 뜨던 영문 File/Edit/View/Window/Help 는 앱 메뉴를
   * 지정하지 않았을 때 Electron 이 붙이는 **기본 메뉴**다. 프레임이 있는 창에만 그려져서
   * 이 창에서만 튀어나왔다. 없앤다 — 화면에서 지우는 김에 그 메뉴가 들고 있던 기본 단축키
   * (Ctrl+W 창 닫기 · Ctrl+R 새로고침)도 함께 사라진다. 우리 Ctrl+W 는 탭 닫기다.
   */
  win.removeMenu()
  windows.set(winId, win)
  // 2026-08-22 준영님 결정("물어보고 세션 종료"): 이 창의 세션이 어떻게 될지 **먼저 보여 준다.**
  // 렌더러가 죽어 있으면 묻지 않는다 — 답할 사람이 없는데 막으면 못 닫는 창이 된다.
  win.on('close', (e) => {
    if (cleared.has(winId) || !opts.onCloseAsk) return
    try {
      if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return
    } catch {
      return
    }
    if (opts.onCloseAsk(winId)) e.preventDefault()
  })
  win.on('closed', () => {
    cleared.delete(winId)
    if (windows.get(winId) === win) windows.delete(winId)
    opts.onClosed(winId)
  })
  /**
   * 새 창은 **앞에 온다.** 두 번 고쳤고 두 번 다 모자랐다:
   *  · 2026-08-22 제보 31: show() 만으로는 본창 뒤에 열렸다 → focus() 를 붙였다.
   *  · 2026-09-01: *"분리한 창이 왜 가장 아래로 가는 거야?"* → moveTop() 을 붙였다.
   *  · 2026-09-02: *"현재 프로그램 위에 창 분리를 하면 **해당 프로그램 바로 뒤에** 뜨더라고."*
   *
   * 마지막 제보가 진단을 확정해 준다. 원인은 전과 같다 — 윈도우는 **포그라운드가 아닌 프로세스의
   * 활성화 요청을 거부한다**(SetForegroundWindow 제한). 탭을 창 밖에 놓는 그 동작이 정확히 그
   * 조건을 만든다: 크롬·메모장·탐색기는 텍스트 드롭을 받아들이고(그래서 dropEffect 로는 판정할 수
   * 없었다 — store/tabDetach.ts 주석) 받으면서 **자기를 앞으로 가져온다.**
   *
   * 틀렸던 것은 처방이다. `moveTop()` 은 SetWindowPos(HWND_TOP) 이고, 그 자리는 **일반(비-topmost)
   * 창들의 맨 위**다 — 방금 포그라운드가 된 그 앱보다는 아래다. 그래서 "가장 아래"가 아니라
   * "바로 뒤"로 옮겨 간 것이고, 준영님 관찰이 그 차이를 정확히 짚었다.
   *
   * 그 앱 **위**로 가는 길은 topmost 를 한 번 거치는 것뿐이다. 켰다가 **즉시** 끄면
   * SetWindowPos(HWND_NOTOPMOST) 가 창을 일반 창들의 맨 위에 다시 꽂는데, 그때는 방금 앞으로
   * 나온 그 앱도 포함이라 **그 위**에 선다. 활성화가 아니므로 포그라운드 제한에도 안 걸린다.
   *
   * ⚠️ **켜 둔 채로 두면 안 된다** — 그러면 "항상 위"가 되어 다른 앱을 영영 가린다. 필요한 것은
   * 만들 때 한 번 앞으로다. 아래 순서에서 setAlwaysOnTop(false) 는 show() 바로 다음이고
   * (focus() 가 던져도 이미 꺼져 있다), tests/sessionWinFront.test.ts 가 "마지막 호출은 false"를
   * 회귀로 잡는다.
   *
   * moveTop() 은 남긴다 — 맥에서는 setAlwaysOnTop(false) 가 창 레벨만 되돌리고(z-order 는
   * 그 자리) moveTop 이 orderFrontRegardless 다. 창을 옮기지는 않는다(끌어다 놓은 자리는 그대로).
   */
  win.once('ready-to-show', () => {
    win.setAlwaysOnTop(true)
    win.show()
    win.setAlwaysOnTop(false)
    win.focus()
    win.moveTop()
  })

  const hash = sessionWinHash(winId)
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl + hash)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
  return win
}

/**
 * F32 R2 저장용 — 지금 떠 있는 창들의 자리. **main 만 이 값을 정확히 안다**(렌더러는 자기 창
 * 크기는 알아도 다른 창 것은 모른다). 최대화 중이면 복원 크기를 쓴다 — 최대화 상태로 껐다고
 * 다음에 화면만 한 창이 뜨면 그 창을 옮기기 어렵다(본창 F6 이 같은 판단을 한다).
 */
export function detachedWindowStates(): { winId: string; bounds: SessionWinBounds }[] {
  const out: { winId: string; bounds: SessionWinBounds }[] = []
  for (const [winId, w] of windows) {
    try {
      if (w.isDestroyed()) continue
      out.push({ winId, bounds: w.isMaximized() ? w.getNormalBounds() : w.getBounds() })
    } catch {
      // 파괴 레이스 — 이 창의 자리는 이번 저장에서 빠진다(다음 저장 때 어차피 없다).
    }
  }
  return out
}

export function closeSessionWindow(winId: string): void {
  const w = sessionWindowOf(winId)
  if (w) w.close()
}

/** 확인이 끝난 창을 닫는다 — 다시 묻지 않는다(답을 들은 뒤에 부른다). */
export function forceCloseSessionWindow(winId: string): void {
  cleared.add(winId)
  closeSessionWindow(winId)
}

/** 앱을 끝낼 때 남은 창을 정리한다(본창 종료 경로가 부른다 — #44 의 종료 실패를 되풀이하지 않게). */
export function closeAllSessionWindows(): void {
  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  windows.clear()
}
