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

export type SessionWinBounds = { x: number; y: number; width: number; height: number }

export function sessionWindowOf(winId: string): BrowserWindow | null {
  const w = windows.get(winId)
  return w && !w.isDestroyed() ? w : null
}

export function sessionWindowIds(): string[] {
  return [...windows.keys()]
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

  const box = usableBounds(opts.bounds, screen.getAllDisplays())
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
  // show() 만으로는 본창 뒤에 열릴 수 있다(특히 본창이 최대화돼 있을 때) — 그러면 사용자에게는
  // "떼어냈는데 창이 안 뜬다"로 보인다(2026-08-22 준영님 제보 31번). 앞으로 가져온다:
  // 내장 브라우저 창이 이미 같은 규칙이다(BrowserTabs.ts 의 show()+focus()).
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
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

/** 앱을 끝낼 때 남은 창을 정리한다(본창 종료 경로가 부른다 — #44 의 종료 실패를 되풀이하지 않게). */
export function closeAllSessionWindows(): void {
  for (const w of windows.values()) if (!w.isDestroyed()) w.destroy()
  windows.clear()
}
