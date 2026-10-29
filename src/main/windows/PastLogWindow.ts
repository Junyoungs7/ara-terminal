// 지난 세션 로그 독립 창 (2026-10-29 준영님 요청 — 사이드바엔 목록만, 내용은 창으로).
//
// ExplorerWindow.ts 를 따른다: 앱 렌더러를 재사용하고 해시(#pastlogwin)로 진입점만 바꾼다. 프레임리스
// (2.0 TitleBar), 부모 없음(다른 모니터에 띄워 두고 본다). 창은 하나 — 이미 떠 있으면 내용만 바꾸고 앞으로.
// × 는 파괴다(탐색기와 다른 점): 지킬 상태가 없다 — 다시 열면 그 로그를 다시 읽는다.
// 이 창도 세션을 소유하지 않는다. 본창이 닫히거나 앱이 끝나면 함께 정리한다(index.ts closed·quitStep).
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { PASTLOG_WIN_HASH, type PastLogTarget } from '../../shared/pastLogWin'

const WIDTH = 960
const HEIGHT = 680
const MIN_WIDTH = 520
const MIN_HEIGHT = 320
// 첫 페인트 번쩍임 방지 — PortWindow·ExplorerWindow 와 같은 값(토큰 --bg-canvas).
const BACKGROUND = '#1e1e20'

let win: BrowserWindow | null = null
let target: PastLogTarget | null = null

/** 대상을 기억하고, 떠 있으면 앞으로(내용 교체는 호출부가 push), 없으면 만든다. 이미 있던 창이면 true. */
export function openPastLogWindow(t: PastLogTarget): boolean {
  target = t
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return true
  }
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: '지난 세션',
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
  w.on('closed', () => {
    if (win === w) win = null
  })
  w.once('ready-to-show', () => w.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void w.loadURL(devUrl + '/' + PASTLOG_WIN_HASH)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: PASTLOG_WIN_HASH.slice(1) })
  return false
}

export function closePastLogWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

export function pastLogWindowContents(): Electron.WebContents | null {
  return win && !win.isDestroyed() ? win.webContents : null
}

/** 새 창이 뜨자마자 묻는다 — 만들기 전에 고른 대상을 놓치지 않게. */
export function pastLogHello(): PastLogTarget | null {
  return target
}
