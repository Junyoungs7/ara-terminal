// 탐색기 독립 창 (2026-10-28 준영님 제보 — "탐색기가 별도의 창으로 떠야하는데 아라 툴 내부에서만 떠").
//
// PortWindow.ts 를 그대로 따른다: 앱 렌더러를 재사용하고 해시(#explorerwin)로 진입점만 바꾼다.
// 창은 하나 — 두 번째 호출은 있는 창을 앞으로.
//
// **× 는 숨김이다(다듬기 R2, #74 복구).** 파괴하면 대상·열린 도구·경로·탭이 다 날아가 다시 열 때
// [홈]부터다 — 1.x 의 "닫았다 열어도 그대로"가 그것을 지켰다. 파괴는 본창이 닫힐 때와 앱 종료
// (quitStep → closeExplorerWindow 의 destroy, close 이벤트를 안 지난다)·로그오프 때뿐이다.
// 숨은 동안 원격 폴링은 렌더러가 멈춘다(document.visibilityState — ExplorerWindow.tsx).
//
// 다른 점 둘:
//  1. **프레임리스**다. 2.0 디자인의 타이틀바(− □ ×)를 본창·세션 창과 같은 TitleBar 로 그린다.
//  2. **본창 상태의 사본**을 받는다. 세션·프로필·즐겨찾기의 주인은 본창(Shell)이고, main 은
//     마지막 사본과 마지막 reveal 을 들고 있다가 창이 뜨면 건넨다(explorer:hello) — 창이 늦게
//     떠도 첫 화면이 비지 않는다. 이 창도 세션을 **소유하지 않는다**(PortWindow 와 같음).
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { EXPLORER_WIN_HASH, type ExplorerReveal, type ExplorerState } from '../../shared/explorerWin'

const WIDTH = 1100
const HEIGHT = 700
const MIN_WIDTH = 720
const MIN_HEIGHT = 420
// 첫 페인트 번쩍임 방지 — PortWindow 와 같은 값(토큰 --bg-canvas).
const BACKGROUND = '#1e1e20'

let win: BrowserWindow | null = null
let lastState: ExplorerState | null = null
let lastReveal: ExplorerReveal | null = null

/**
 * 열려 있으면 앞으로, 없으면 만든다. reveal 이 있으면 기억해 두고(새 창은 hello 로 받는다)
 * 이미 떠 있는 창에는 바로 보낸다. onShown 은 창이 생기고 없어질 때 본창에 알리는 자리(레일 표시).
 */
export function openExplorerWindow(onShown: (open: boolean) => void, reveal?: ExplorerReveal): void {
  if (reveal) lastReveal = reveal
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) {
      win.show()
      onShown(true)
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: '탐색기',
    backgroundColor: BACKGROUND,
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.removeMenu()
  const w = win
  // 로그오프(WM_ENDSESSION)는 before-quit 을 안 지나고 close 로 곧장 온다 — 그때 숨기면 OS 종료를
  // 붙잡는다. 본창의 같은 자리(index.ts session-end)와 같은 이유다.
  let ending = false
  w.on('session-end', () => {
    ending = true
  })
  w.on('close', (e) => {
    if (ending) return
    e.preventDefault()
    w.hide()
    onShown(false)
  })
  w.on('closed', () => {
    if (win === w) win = null
    onShown(false)
  })
  w.once('ready-to-show', () => w.show())
  onShown(true)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void w.loadURL(devUrl + '/' + EXPLORER_WIN_HASH)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: EXPLORER_WIN_HASH.slice(1) })
}

export function closeExplorerWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

export function explorerWindowContents(): Electron.WebContents | null {
  return win && !win.isDestroyed() ? win.webContents : null
}

export function setExplorerState(s: ExplorerState): void {
  lastState = s
}

/** 새 창이 뜨자마자 묻는다 — 그 전에 본창이 보낸 사본·reveal 을 놓치지 않게. */
export function explorerHello(): { state: ExplorerState | null; reveal: ExplorerReveal | null } {
  return { state: lastState, reveal: lastReveal }
}
