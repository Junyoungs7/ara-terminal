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
const BACKGROUND = '#0d1119'

/** winId → 창. 창이 닫히면 지워진다(닫힘 정리는 여는 쪽이 콜백으로 받는다). */
const windows = new Map<string, BrowserWindow>()

export type SessionWinBounds = { x: number; y: number; width: number; height: number }

export function sessionWindowOf(winId: string): BrowserWindow | null {
  const w = windows.get(winId)
  return w && !w.isDestroyed() ? w : null
}

export function sessionWindowIds(): string[] {
  return [...windows.keys()]
}

/**
 * 창을 놓을 자리. 저장된 값이 있으면 쓰되 **화면 안에 있는지 확인**한다 — 듀얼 모니터에서 떼어
 * 놓고 노트북만 들고 나가면 그 좌표가 화면 밖이라 창을 다시 찾을 수 없다(F32 R2 복원의 전제).
 */
export function usableBounds(saved: SessionWinBounds | undefined): SessionWinBounds | null {
  if (!saved) return null
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const b = d.bounds
    // 창 좌상단이 어느 디스플레이 안에 들어오면 "찾을 수 있다"로 본다(일부만 걸쳐도 잡아 옮길 수 있다).
    return saved.x >= b.x && saved.x < b.x + b.width && saved.y >= b.y && saved.y < b.y + b.height
  })
  return onScreen ? saved : null
}

export function openSessionWindow(
  winId: string,
  title: string,
  opts: { bounds?: SessionWinBounds; onClosed: (winId: string) => void }
): BrowserWindow {
  const existing = sessionWindowOf(winId)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  const box = usableBounds(opts.bounds)
  const win = new BrowserWindow({
    ...(box ?? { width: WIDTH, height: HEIGHT }),
    title,
    backgroundColor: BACKGROUND,
    show: false,
    // 네이티브 프레임 — 창 제목이 보여야 어느 서버 창인지 작업표시줄에서 구분된다.
    // (본창은 커스텀 타이틀바지만 이 창은 그 바를 안 그린다 — 메뉴·검색이 없으니 그릴 것이 없다.)
    frame: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  windows.set(winId, win)
  win.on('closed', () => {
    if (windows.get(winId) === win) windows.delete(winId)
    opts.onClosed(winId)
  })
  win.once('ready-to-show', () => win.show())

  const hash = sessionWinHash(winId)
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl + hash)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
  return win
}

export function closeSessionWindow(winId: string): void {
  const w = sessionWindowOf(winId)
  if (w) w.close()
}

/** 앱을 끝낼 때 남은 창을 정리한다(본창 종료 경로가 부른다 — #44 의 종료 실패를 되풀이하지 않게). */
export function closeAllSessionWindows(): void {
  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  windows.clear()
}
