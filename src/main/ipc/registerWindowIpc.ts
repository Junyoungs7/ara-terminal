// window 도메인 IPC 핸들러 (R2.6). 프레임리스 타이틀바의 신호등 버튼이 여기로 온다.
// 창은 재생성될 수 있으므로 getter 로 지연 평가하고, 파괴된 창은 조용히 무시한다
// (FIX-window-destroyed 패턴 — isDestroyed 접근 자체도 try 로 감싼다).
import { BrowserWindow, clipboard, shell } from 'electron'
import { openPortWindow } from '../windows/PortWindow'
import { handle } from './handle'
import { isSafeExternal } from '../util/safeExternal'
import { clipboardFilePaths } from '../util/clipboardFiles'

export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  const live = (): BrowserWindow | null => {
    try {
      const w = getWindow()
      return w && !w.isDestroyed() ? w : null
    } catch {
      return null
    }
  }

  // 포트 모니터 독립 창(2026-08-21). 창은 하나 — 두 번째 호출은 있는 창을 앞으로 가져온다.
  handle('portwin:open', () => {
    openPortWindow(getWindow)
    return { ok: true } as const
  })
  handle('window:minimize', () => {
    live()?.minimize()
    return { ok: true } as const
  })

  // 최대화 토글 — 현재 상태에 따라 복원/최대화. 창 크기 저장(F6)은 최대화 중엔 건너뛰므로
  // 최대화 상태로 종료해도 복원용 bounds 는 마지막 일반 크기가 남는다.
  handle('window:toggleMaximize', () => {
    const w = live()
    if (!w) return { maximized: false }
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return { maximized: w.isMaximized() }
  })

  /**
   * **부른 창을 닫는다.** 예전엔 무조건 본창을 닫았다 — 창이 본창 하나였을 때는 같은 말이었지만
   * F32 로 떼어낸 창이 생기면서 갈라졌다: 그 창의 마지막 세션이 본창으로 돌아가면 빈 창이
   * 스스로 닫으려고 이 채널을 부르는데(SessionWindow.tsx), 그게 **본창을 닫아 앱을 끝냈다.**
   * 보낸 쪽을 못 찾을 때만 본창으로 떨어뜨린다(계약을 바꾸지 않는 폴백).
   */
  handle('window:close', (_req, e) => {
    let sender: BrowserWindow | null = null
    try {
      const w = BrowserWindow.fromWebContents(e.sender)
      sender = w && !w.isDestroyed() ? w : null
    } catch {
      sender = null // 파괴 레이스 — 본창 폴백으로 간다
    }
    ;(sender ?? live())?.close()
    return { ok: true } as const
  })

  // R3.3: 터미널 안 URL 을 기본 브라우저로. 스킴 화이트리스트는 util/safeExternal(순수 함수).
  handle('app:openExternal', ({ url }) => {
    if (!isSafeExternal(url)) return { ok: false }
    void shell.openExternal(url).catch(() => {})
    return { ok: true }
  })

  // F14: 클립보드에 담긴 파일 경로. 렌더러는 OS 클립보드의 파일 형식을 볼 수 없으므로(브라우저
  // Clipboard API 는 텍스트·이미지뿐) main 이 읽어 실존 파일만 돌려준다 — app:openExternal 과
  // 같은 "렌더러가 못 하는 OS 접근을 검증해서 대신해 준다" 자리다.
  handle('clipboard:readFiles', () => ({ paths: clipboardFilePaths(clipboard) }))
}
