// 도메인 IPC 핸들러의 단일 등록 지점.
// 원래 register*Ipc.ts 16개가 바이트 단위로 같은 래퍼를 한 벌씩 복사해 갖고 있었다 — 여기 하나로
// 모아 핸들러가 던진 예외를 한 자리에서 기록한다(FIX-shutdown §4: "콜사이트마다 흩지 마라").
//
// ipcMain.handle 은 핸들러가 던지면 거절을 렌더러로만 보내고 main 쪽에는 아무 흔적도 남기지 않는다.
// 그 문구는 렌더러에서 오류 카드·토스트로 그대로 화면에 뜨는데(RdpView·FileTree·LogPanel 등),
// 정작 무엇이 어디서 던졌는지 추적할 길이 없었다. 이제 스택이 userData/logs/main-error.log 에 남는다.
//
// 두 번째 인자로 **보낸 창의 이벤트**를 넘긴다(2026-08-22). 창이 여럿인 앱에서 "누가 물었나"를
// 모르면 답할 창을 고를 수 없다 — window:close 가 늘 본창을 닫고 있던 것이 그 결과다
// (떼어낸 창이 스스로 닫으려 하면 본창이 닫혔다). 쓰는 핸들러만 받으면 된다.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import { logMainError } from '../log/MainErrorLog'

export function handle<C extends InvokeChannel>(
  channel: C,
  fn: (req: InvokeReq<C>, e: IpcMainInvokeEvent) => InvokeRes<C> | Promise<InvokeRes<C>>
): void {
  ipcMain.handle(channel, async (e, req: InvokeReq<C>) => {
    try {
      return await fn(req, e)
    } catch (err) {
      logMainError(`ipc ${channel}`, err)
      throw err // 계약은 그대로 — 렌더러는 지금과 똑같이 거절을 받는다.
    }
  })
}
