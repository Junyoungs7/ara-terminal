// 2.0 앱 잠금 IPC — 상태는 AppLock 하나가 쥐고, 바뀌면 **모든 창**에 `lock:state` 를 방송한다.
// 🔴 비밀번호가 지나가는 채널이다: 요청 값을 로그·오류 문구에 싣지 않는다(handle() 은 던진 오류만 기록한다).
import { BrowserWindow } from 'electron'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import type { AppLock } from '../secrets/AppLock'
import type { LockView } from '@shared/lock'

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
  lock.setOnChange(broadcast)

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  handle('lock:get', () => view())
  handle('lock:lock', () => ({ ok: lock.lock() }))
  handle('lock:unlock', (r) => lock.unlock(str(r?.password)))
  handle('lock:enable', (r) => lock.enable(str(r?.password)))
  handle('lock:disable', (r) => lock.disable(str(r?.password)))
  handle('lock:change', (r) => lock.change(str(r?.oldPassword), str(r?.newPassword)))
  handle('lock:setPrefs', (r) => lock.setPrefs(r ?? {}))
  handle('lock:otpBegin', () => lock.otpBegin())
  handle('lock:otpConfirm', (r) => lock.otpConfirm(str(r?.code)))
  handle('lock:forgotVerify', (r) => lock.forgotVerify(str(r?.code)))
  handle('lock:forgotReset', (r) => lock.forgotReset(str(r?.newPassword)))
  return { view, broadcast }
}
