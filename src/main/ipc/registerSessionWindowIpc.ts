// F32 세션 창 IPC — 떼어내기 / 되돌리기.
//
// 이 모듈이 하는 일은 **소유 표시를 바꾸고 양쪽 창에 알리는 것**뿐이다. 세션(pty·SSH)은 main 에
// 살아 있으므로 옮길 프로세스가 없다 — 그래서 "떼어내기"에 재접속도, 화면 재생도 필요 없다.
// (renderer 는 새 창에서 xterm 을 만들고 `session:attach` 로 백로그를 한 번에 받아 간다 —
//  MainSessionManager 의 attached/backlog 계약이 이미 그 용도로 있다.)
//
// 창이 닫히면 그 창의 세션을 **본창으로 되돌린다**. 세션을 죽이지 않는 쪽을 기본값으로 삼은
// 이유: 창 닫기는 실수로도 일어나고, 그때 원격 작업이 통째로 끊기면 되돌릴 방법이 없다.
// (R2 에서 "닫을 때 물어보기"를 얹는다 — 그때도 기본은 되돌리기다.)
import type { BrowserWindow } from 'electron'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import { openSessionWindow, sessionWindowOf } from '../windows/SessionWindows'
import type { MainSessionManager } from '../sessions/MainSessionManager'

/** 창 이름 — 사람이 볼 일은 없지만 로그·저장값에 남으므로 짧고 유일하게. */
function newWinId(): string {
  return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
}

export function registerSessionWindowIpc(
  sessions: MainSessionManager,
  getMainWindow: () => BrowserWindow | null
): void {
  const mainWc = (): BrowserWindow['webContents'] | null => {
    try {
      const w = getMainWindow()
      return w && !w.isDestroyed() ? w.webContents : null
    } catch {
      return null
    }
  }

  /** 양쪽 창에 알린다 — 보낸 창은 탭을 지우고, 받은 창은 탭을 그린다. */
  const announce = (sessionId: string, winId: string | undefined): void => {
    const payload = winId === undefined ? { sessionId } : { sessionId, winId }
    pushSend(mainWc(), 'session:moved', payload)
    if (winId) {
      const w = sessionWindowOf(winId)
      pushSend(w ? w.webContents : null, 'session:moved', payload)
    }
  }

  /** 그 창의 세션을 전부 본창으로. 창이 닫힐 때 부른다. */
  const reclaim = (winId: string): void => {
    for (const id of sessions.sessionsOfWindow(winId)) {
      sessions.moveToWindow(id, undefined)
      pushSend(mainWc(), 'session:moved', { sessionId: id })
    }
  }

  handle('win:detach', ({ sessionId }) => {
    const meta = sessions.snapshot().find((s) => s.id === sessionId)
    if (!meta) return { ok: false as const }
    // 이미 떼어낸 세션이면 그 창을 앞으로 가져오는 것으로 족하다(창을 또 만들지 않는다).
    const already = meta.winId
    if (already && sessionWindowOf(already)) {
      openSessionWindow(already, meta.title, { onClosed: reclaim })
      return { ok: true as const, winId: already }
    }
    const winId = newWinId()
    sessions.moveToWindow(sessionId, winId)
    openSessionWindow(winId, meta.title, { onClosed: reclaim })
    announce(sessionId, winId)
    return { ok: true as const, winId }
  })

  handle('win:reattach', ({ sessionId }) => {
    if (!sessions.moveToWindow(sessionId, undefined)) return { ok: false as const }
    announce(sessionId, undefined)
    return { ok: true as const }
  })
}
