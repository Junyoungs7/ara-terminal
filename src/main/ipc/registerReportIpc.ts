// 오류 신고(#206) IPC. 렌더러는 서버에 직접 닿지 않는다(CSP) — 찍기·모으기·보내기가 전부 여기다.
import { app } from 'electron'
import { release, version as osVersion } from 'node:os'
import { handle } from './handle'
import { REPORTS_API } from '@shared/links'
import { mainErrorLogPath } from '../log/MainErrorLog'
import { detachedWindowStates } from '../windows/SessionWindows'
import { buildReport, deviceId, logTail, postReport, safeSettings, sessionShape } from '../report/BugReport'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'

export function registerReportIpc(sessions: MainSessionManager, store: WorkspaceStore): void {
  /**
   * 🔴 **부른 창을 찍는다**(떼어낸 창이면 그 창). 그리고 이 호출이 **신고 창보다 먼저**다 —
   * 렌더러는 이 답을 받은 뒤에 창을 연다(BugReportModal.useBugReport). 순서가 바뀌면 신고 창이 찍힌다.
   * 찍지 못하면 null — 신고는 캡처 없이도 된다.
   */
  handle('report:prepare', async (_req, e) => {
    let capture: string | null = null
    try {
      const img = await e.sender.capturePage()
      if (!img.isEmpty()) capture = img.toPNG().toString('base64')
    } catch {
      // 창이 막 닫혔다 등 — 캡처만 빠진다
    }
    return { capture, log: logTail(mainErrorLogPath()), settings: safeSettings(store.get().ui) }
  })

  handle('report:send', (req) =>
    postReport(
      REPORTS_API,
      buildReport(req, {
        deviceId: deviceId(app.getPath('userData')),
        version: app.getVersion(),
        os: `${osVersion()} ${release()}`,
        electron: process.versions.electron ?? '',
        sessions: sessionShape(sessions.snapshot(), detachedWindowStates().length),
        settings: safeSettings(store.get().ui)
      })
    )
  )
}
