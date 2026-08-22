// F32 세션 창 IPC — 떼어내기 / 되돌리기.
//
// 이 모듈이 하는 일은 **소유 표시를 바꾸고 양쪽 창에 알리는 것**뿐이다. 세션(pty·SSH)은 main 에
// 살아 있으므로 옮길 프로세스가 없다 — 그래서 "떼어내기"에 재접속도, 화면 재생도 필요 없다.
// (renderer 는 새 창에서 xterm 을 만들고 `session:attach` 로 백로그를 한 번에 받아 간다 —
//  MainSessionManager 의 attached/backlog 계약이 이미 그 용도로 있다.)
//
// 창을 닫을 때는 **묻는다**(2026-08-22 준영님 결정 — 제보 4번 "창 닫을 때 세션 목록·확인 팝업").
// 그 창의 세션 목록을 보여 주고: 확인하면 종료, [본창으로 보내기]면 되돌리기, 취소면 그대로.
// 묻기 전의 기본값은 되돌리기였다 — 창 닫기는 실수로도 일어나고 그때 원격 작업이 통째로 끊기면
// 되돌릴 방법이 없어서다. 그 탈출구는 지금도 버튼으로 남아 있다.
import type { BrowserWindow } from 'electron'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import { forceCloseSessionWindow, openSessionWindow, sessionWindowOf } from '../windows/SessionWindows'
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

  /**
   * 양쪽 창에 알린다 — 보낸 창은 탭을 지우고, 받은 창은 탭을 그린다.
   * from 은 **떼어낸 창에서 다시 떼어낼 때**의 옛 주인이다(본창은 늘 받으므로 따로 셀 필요가 없다).
   * 안 보내면 그 창에 탭이 남는다 — 세션은 이미 떠났는데 껍데기만 남은 탭이다.
   */
  const announce = (sessionId: string, winId: string | undefined, from?: string): void => {
    const payload = winId === undefined ? { sessionId } : { sessionId, winId }
    pushSend(mainWc(), 'session:moved', payload)
    for (const id of [winId, from]) {
      if (!id) continue
      const w = sessionWindowOf(id)
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

  /**
   * 닫기 전에 그 창에 물어본다. **세션이 없으면 묻지 않는다**(빈 창을 닫는 데 확인은 방해다).
   * true = 닫기를 막았다 — 답은 win:closeConfirm 으로 온다.
   */
  const askClose = (winId: string): boolean => {
    if (sessions.sessionsOfWindow(winId).length === 0) return false
    const w = sessionWindowOf(winId)
    if (!w) return false
    pushSend(w.webContents, 'win:closeAsk', {})
    return true
  }

  /** 창 하나를 여는 데 늘 함께 가는 두 콜백 — 세 곳(떼어내기·앞으로·복원)이 같아야 한다. */
  const winOpts = { onClosed: reclaim, onCloseAsk: askClose }

  handle('win:detach', ({ sessionId, at }) => {
    const meta = sessions.snapshot().find((s) => s.id === sessionId)
    if (!meta) return { ok: false as const }
    // 이미 떼어낸 세션을 **메뉴로** 또 떼어내라 하면 그 창을 앞으로 가져오는 것으로 족하다.
    // 끌어다 놓은 것(at)은 다르다 — "저기에 두겠다"는 뜻이라 새 창을 만든다.
    const already = meta.winId
    if (already && sessionWindowOf(already) && !at) {
      openSessionWindow(already, meta.title, winOpts)
      return { ok: true as const, winId: already }
    }
    const winId = newWinId()
    sessions.moveToWindow(sessionId, winId)
    openSessionWindow(winId, meta.title, { ...winOpts, ...(at ? { at } : {}) })
    announce(sessionId, winId, already)
    return { ok: true as const, winId }
  })

  /**
   * 물어본 것에 대한 답. 어느 쪽이든 **창은 닫힌다** — 취소는 아예 여기까지 오지 않는다.
   * kill 은 세션을 죽인다: 그 뒤 sessionsOfWindow 가 비므로 'closed' 의 reclaim 은 할 일이 없다.
   */
  handle('win:closeConfirm', ({ winId, kill }) => {
    if (kill) for (const id of sessions.sessionsOfWindow(winId)) sessions.destroy(id)
    else reclaim(winId)
    forceCloseSessionWindow(winId)
    return { ok: true as const }
  })

  handle('win:reattach', ({ sessionId }) => {
    if (!sessions.moveToWindow(sessionId, undefined)) return { ok: false as const }
    announce(sessionId, undefined)
    return { ok: true as const }
  })

  /**
   * F32 R2 복원. 본창이 세션을 **다 되살린 뒤** 한 번 부른다.
   *
   * 순서가 이 핸들러의 전부다: ① 소유를 붙이고 ② 그다음 창을 연다. 뒤집으면 창이 먼저 떠서
   * 자기 세션을 못 찾고 빈 채로 남는다(그 창의 useSessions 는 뜨는 순간 한 번 훑는다).
   *
   * **세션이 하나도 안 붙은 창은 열지 않는다** — 저장된 창인데 그 안의 세션이 전부 복원에
   * 실패했을 수 있다(SSH 재접속 실패). 빈 창을 띄우고 "닫으세요" 하는 것보다 안 띄우는 게 낫다.
   */
  handle('win:restore', ({ assign, windows }) => {
    for (const a of assign) sessions.moveToWindow(a.sessionId, a.winId)
    let opened = 0
    for (const w of windows) {
      const ids = sessions.sessionsOfWindow(w.winId)
      if (ids.length === 0) continue
      const first = sessions.snapshot().find((x) => x.id === ids[0])
      openSessionWindow(w.winId, first?.title ?? '', { ...winOpts, bounds: w.bounds })
      opened += 1
    }
    return { opened }
  })
}
