// #98 자동 업데이트 IPC — electron-updater 를 여기서만 만난다(로직은 update/AutoUpdate.ts).
import { app, type WebContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { handle } from './handle'
import { pushSend } from '../util/windowPush'
import { logMainError } from '../log/MainErrorLog'
import { createAutoUpdate, type AutoUpdateService, type UpdaterLike } from '../update/AutoUpdate'

/** 처음 확인은 창이 뜨고 조금 뒤에 — 기동 순간의 네트워크·디스크를 업데이트 확인이 뺏지 않게. */
const FIRST_CHECK_MS = 20_000
/** 그 뒤로는 여섯 시간마다. 하루 종일 켜 두는 앱이라 이 정도면 당일 안에 새 버전이 닿는다. */
const EVERY_MS = 6 * 60 * 60 * 1000

export function registerUpdateIpc(getWebContents: () => WebContents | null): AutoUpdateService {
  const svc = createAutoUpdate({
    updater: autoUpdater as unknown as UpdaterLike,
    packaged: app.isPackaged,
    // 사내 서버가 옮겨 가도 다시 빌드하지 않게 — 있으면 패키지에 박힌 주소를 덮는다.
    feedUrl: process.env.ARA_UPDATE_URL?.trim() || undefined,
    emit: (state) => pushSend(getWebContents(), 'update:state', state),
    onError: (where, err) => logMainError(where, err)
  })

  handle('update:get', () => svc.state())
  handle('update:check', () => {
    svc.check()
    return { ok: true } as const
  })
  handle('update:install', () => {
    svc.install()
    return { ok: true } as const
  })

  // 타이머는 **반드시 unref** 한다 — 안 그러면 창을 다 닫고도 이벤트 루프가 살아 앱이 안 죽는다(#64).
  setTimeout(() => svc.check(), FIRST_CHECK_MS).unref()
  setInterval(() => svc.check(), EVERY_MS).unref()

  return svc
}
