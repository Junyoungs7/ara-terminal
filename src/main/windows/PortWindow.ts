// 포트 모니터 독립 창 (2026-08-21 준영님 요청 — "포트 모니터만 든 독립 창").
//
// EditorWindows 와 같은 방식이다: **앱 렌더러를 그대로 재사용하고 해시(#portwin)로 진입점만
// 바꾼다.** 별도 번들·별도 preload 를 만들지 않는다 — 폰트·토큰·CSS 가 전부 거기 이미 있다.
//
// 편집기 창과 다른 점 하나: **창이 하나뿐이다.** 편집기는 파일마다 창을 열지만 포트 모니터는
// 서버가 늘어나면 **그 창 안의 탭**이 는다(준영님 확정). 그래서 키가 없고 인스턴스도 하나다 —
// 두 번째 호출은 있는 창을 앞으로 가져온다.
//
// 이 창은 세션을 소유하지 않는다(F32 SessionWindows 와 다른 점). 포트 목록은 main 의 텔레메트리를
// 구독해 받아 오는 **읽기 화면**이라, 창이 죽어도 세션·포워딩은 그대로 산다.
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { PORT_WIN_HASH } from '../../shared/portWin'

const WIDTH = 980
const HEIGHT = 620
const MIN_WIDTH = 720
const MIN_HEIGHT = 320
// 첫 페인트까지 흰 화면이 번쩍이지 않게. 토큰 --bg-canvas 와 같은 값이다(G 팔레트).
const BACKGROUND = '#1e1e20'

let win: BrowserWindow | null = null

/** 열려 있으면 그 창을, 없으면 새로 만든다. 어느 쪽이든 앞으로 가져온다. */
export function openPortWindow(getParent: () => BrowserWindow | null): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }
  const parent = getParent()
  win = new BrowserWindow({
    // parent 를 주면 항상 본창 위에 뜬다. 포트 모니터는 **다른 모니터에 띄워 두고 보는** 용도라
    // (그래서 앱 안 떠 있는 창이 아니라 진짜 창으로 골랐다) 종속시키지 않는다.
    ...(parent && !parent.isDestroyed() ? {} : {}),
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: '포트 모니터',
    backgroundColor: BACKGROUND,
    // 네이티브 프레임 — 다른 모니터로 옮기고 Alt+Tab 으로 오가는 창이라 OS 관례를 그대로 쓴다.
    frame: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  const w = win
  w.on('closed', () => {
    if (win === w) win = null
  })
  w.once('ready-to-show', () => w.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void w.loadURL(devUrl + '/' + PORT_WIN_HASH)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: PORT_WIN_HASH.slice(1) })
}

/** 앱을 닫을 때 함께 정리한다 — 이 창만 남아 프로세스가 살아 있으면 안 된다. */
export function closePortWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/** 이 창의 webContents(있으면). main 이 텔레메트리를 push 할 대상. */
export function portWindowContents(): Electron.WebContents | null {
  return win && !win.isDestroyed() ? win.webContents : null
}
