// 2.0 앱 잠금 IPC — 상태는 AppLock 하나가 쥐고, 바뀌면 **모든 창**에 `lock:state` 를 방송한다.
// 🔴 비밀번호가 지나가는 채널이다: 요청 값을 로그·오류 문구에 싣지 않는다(handle() 은 던진 오류만 기록한다).
import { app, BrowserWindow, powerMonitor } from 'electron'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import { setBrowserLockHidden } from '../browser/BrowserTabs'
import type { AppLock } from '../secrets/AppLock'
import { isLockedState, type LockView } from '@shared/lock'
import { comboMatchesInput, lockShortcutProblem } from '@shared/keymap'

// 자동 잠금 확인 주기. PC 유휴 시간(powerMonitor)을 보므로 이 값은 "늦어도 30초 안에 잠긴다"는 오차일 뿐이다.
const AUTO_LOCK_TICK_MS = 30_000

export type LockRuntime = { view(): LockView; broadcast(): void }

export function registerLockIpc(lock: AppLock, sessionCount: () => number): LockRuntime {
  const view = (): LockView => lock.view(sessionCount())
  const broadcast = (): void => {
    const v = view()
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        pushSend(w.webContents, 'lock:state', v)
      } catch {
        /* 파괴 레이스 — 그 창은 이미 없다 */
      }
    }
  }
  lock.setOnChange(() => {
    // 브라우저 창의 원격 페이지(WebContentsView)는 HTML 덮개로 못 가린다 — 잠긴 동안 숨긴다.
    setBrowserLockHidden(isLockedState(lock.state()))
    broadcast()
  })
  setBrowserLockHidden(isLockedState(lock.state()))

  /**
   * 잠금 단축키는 **main 이 먼저 잡는다**(before-input-event) — 모든 webContents(본창·떼어낸 창·탐색기·
   * 포트·브라우저 탭 줄·**원격 페이지 뷰**·RDP)에서 같은 키가 같은 일을 하고, 그 키는 셸로 가지 않는다.
   * 잠긴 동안 DevTools 가 열리면 바로 닫는다 — 열린 콘솔에서 IPC 를 부르면 덮개를 우회한다.
   */
  app.on('web-contents-created', (_e, wc) => {
    wc.on('before-input-event', (ev, input) => {
      if (!comboMatchesInput(lock.shortcut(), input)) return
      ev.preventDefault()
      lock.lock()
    })
    wc.on('devtools-opened', () => {
      if (isLockedState(lock.state())) wc.closeDevTools()
    })
  })

  // 자동 잠금 — 설정한 분만큼 PC 가 유휴면 잠근다(끔이 기본).
  const tick = setInterval(() => {
    const min = lock.autoLockMin()
    if (min > 0 && lock.state() === 'unlocked' && powerMonitor.getSystemIdleTime() >= min * 60) lock.lock()
  }, AUTO_LOCK_TICK_MS)
  tick.unref?.()

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  handle('lock:get', () => view())
  handle('lock:lock', () => ({ ok: lock.lock() }))
  handle('lock:unlock', (r) => lock.unlock(str(r?.password)))
  handle('lock:enable', (r) => lock.enable(str(r?.password)))
  handle('lock:disable', (r) => lock.disable(str(r?.password)))
  handle('lock:change', (r) => lock.change(str(r?.oldPassword), str(r?.newPassword)))
  handle('lock:setPrefs', (r) => {
    const p = r ?? {}
    // 렌더러가 보낸 키는 신뢰 경계 밖 — 표의 규칙(셸 키·겹침·모양)을 여기서 다시 본다.
    if (typeof p.shortcut === 'string' && lockShortcutProblem(p.shortcut) !== null) return { ok: false, reason: 'weak' } as const
    return lock.setPrefs(p)
  })
  handle('lock:otpBegin', () => lock.otpBegin())
  handle('lock:otpConfirm', (r) => lock.otpConfirm(str(r?.code)))
  handle('lock:forgotVerify', (r) => lock.forgotVerify(str(r?.code)))
  handle('lock:forgotReset', (r) => lock.forgotReset(str(r?.newPassword)))
  return { view, broadcast }
}
