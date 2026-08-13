// 창으로 나가는 모든 push(send/postMessage)가 통과하는 단일 지점 (FIX-destroyed 재발 근절).
//
// 배경: c014eea 에서 getWebContents() 접근자 + 콜사이트별 `wc && !wc.isDestroyed()` 가드를 도입했지만,
// Wave 1~5 로 push 경로가 5곳 넘게 늘면서 registerAiIpc.ts 하나가 그 가드 없이 `getWebContents()?.send()`
// 만 쓰는 우회 경로로 새어 나갔다(FIX-destroyed 조사). 창 close()~'closed' 구간에 도착한 AI 스트림 델타가
// 이미 destroyed 인 WebContents 에 send() 하면 던지고, AraSession.run() 의 catch 블록 안에서 emit.end() 가
// 가드 없이 재호출되며 두 번째 throw 가 나(가드가 없는 catch 안이라 못 잡힘) 그 throw 가 `void this.run()`
// (await/catch 없는 fire-and-forget) 을 타고 UnhandledPromiseRejection 이 된다 — 실측(FIX-destroyed-done.md)
// 상 uncaughtException 안전망은 이 경로를 못 잡는다.
//
// 그래서 이제 콜사이트가 스스로 `isDestroyed()` 를 확인하지 않는다 — 전부 이 헬퍼를 통과시키고, 여기
// 하나에서만 확인한다. isDestroyed() 접근 자체도 파괴 레이스에서 던질 수 있다는 게 기존 관행의 전제라
// (registerWindowIpc.ts 주석) 확인 + 호출 전체를 try 로 감싼다 — 파괴 후에는 조용히 무시.
import type { WebContents } from 'electron'

function safe(wc: WebContents | null | undefined, run: (wc: WebContents) => void): void {
  try {
    if (wc && !wc.isDestroyed()) run(wc)
  } catch {
    // 창 파괴 레이스 — 전송 실패는 무시한다(창이 없으니 받을 사람도 없다).
  }
}

// ipcRenderer.on 계약 — 대부분의 이벤트 push(session:exit, sftp:progress, ai:delta, mcp:* ...).
export function pushSend(wc: WebContents | null | undefined, channel: string, payload?: unknown): void {
  safe(wc, (w) => w.send(channel, payload))
}

// session:data 전용 — Uint8Array 를 단일 복사로 보내는 postMessage 경로(registerSessionIpc.ts 주석 참고).
export function pushMessage(wc: WebContents | null | undefined, channel: string, payload: unknown): void {
  safe(wc, (w) => w.postMessage(channel, payload))
}
