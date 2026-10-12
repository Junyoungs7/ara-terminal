// session 도메인 IPC 핸들러 (계획서 §B.2). 채널명은 shared/ipc.ts 계약과 일치.
// 출력은 session:data:{id} 이벤트로 Uint8Array 전송. Electron IPC는 V8 직렬화로 typed array를
// 단일 복사 전달한다. postMessage transfer-list는 MessagePortMain 전용(ArrayBuffer 넣으면 크래시)이라
// 브라우저식 zero-copy transfer는 불가 — 대신 typed array 직렬화(단일 복사)로 구조적 클론 이중 복사를 회피한다.
// ponytail: Electron IPC single-copy ceiling; MessagePort 기반 zero-copy는 처리량 실측 후 Phase 2에서만 승격.
import { ipcMain, type WebContents } from 'electron'
import type { SendChannel } from '@shared/ipc'
import { handle } from './handle'
import { MainSessionManager } from '../sessions/MainSessionManager'
import { pushSend, pushMessage } from '../util/windowPush'
import { sessionWindowOf } from '../windows/SessionWindows'

// 떼어낸 창의 webContents. 파괴 레이스에선 게터 접근 자체가 던진다(main/index.ts 라우터와 같은 가드).
function ownerWc(winId: string): WebContents | null {
  try {
    return sessionWindowOf(winId)?.webContents ?? null
  } catch {
    return null
  }
}

function on<C extends SendChannel>(channel: C, fn: (payload: unknown) => void): void {
  ipcMain.on(channel, (_e, payload) => fn(payload))
}

// getWebContents: 이벤트를 보낼 현재 창(main/index.ts가 주입). 창 재생성 대비 지연 평가.
// onExit: 세션이 끝났을 때 딸린 자원을 접는 훅(F8 포워딩 리스너). main/index.ts 가 늦은 바인딩으로
//   넣는다 — 포워딩 서비스는 이 함수가 돌려주는 세션 매니저 위에 만들어지므로 아직 없다.
// onHumanInput: F23 — session:input 이 렌더러(사람 키 입력)에서 도착했다는 신호. MCP 승인 매니저가
//   이 세션의 autoAllow 를 즉시 해제하는 데 쓴다(설계 §3.3). MCP 툴 호출은 이 IPC 채널을 타지 않고
//   MainSessionManager.write() 를 직접 부르므로, 여기가 "사람이 타이핑했다"를 구분할 수 있는 유일한 지점이다.
//   같은 늦은 바인딩 패턴(forwards 와 동일 — MCP 런타임도 이 함수가 돌려주는 세션 매니저 위에 만들어진다).
// concrete MainSessionManager를 반환 — SSH 핸들러가 adopt()로 백엔드를 편입하려면 구체 타입이 필요.
export function registerSessionIpc(
  // F32: sessionId 를 주면 **그 세션을 가진 창**으로 보낸다(main/index.ts 의 라우터).
  getWebContents: (sessionId?: string) => WebContents | null,
  onExit?: (id: string) => void,
  onHumanInput?: (id: string) => void
): MainSessionManager {
  const mgr = new MainSessionManager({
    data(id, chunk) {
      // Uint8Array를 message 인자로 전달(백프레셔 메커니즘 3, 단일 복사).
      pushMessage(getWebContents(id), `session:data:${id}`, chunk)
    },
    exit(id, exitCode, signal, winId) {
      // F8: 창이 이미 죽었어도 포워딩 리스너는 반드시 접어야 한다 — 알림 전에 정리한다.
      onExit?.(id)
      // #201 B-4: `getWebContents(id)` 는 여기서 늘 본창이다(핸들이 이미 없다) — 매니저가 지우기 전에
      // 받아 둔 winId 로 창을 고른다. 그 창이 닫혔으면 라우터와 같이 본창으로 떨어진다.
      pushSend((winId && ownerWc(winId)) || getWebContents(id), `session:exit:${id}`, { id, exitCode, signal })
    },
    // F7: OSC7 cwd 변경 → SFTP 트리 자동 이동(터미널→트리 동기).
    cwd(id, cwd) {
      pushSend(getWebContents(id), `session:cwd:${id}`, { id, cwd })
    },
    // 세션이 생겼다 → 그 세션을 가진 창이 탭을 그린다. 렌더러가 만든 것도 여기를 지나지만
    // 받는 쪽 adopt 가 같은 id 를 두 번 넣지 않는다(어느 쪽이 먼저 도착해도 탭은 하나다).
    opened(meta) {
      pushSend(getWebContents(meta.id), 'session:opened', meta)
    },
    // 세션이 없어졌다 → 그 창이 탭·칸·상태점을 치운다. `opened` 와 **같은 모양**이어야 한다
    // (끄는 쪽마다 적으면 새 문이 생길 때 또 빠진다 — 1.0.8 이 만들기를 리스너 하나로 모은 이유).
    // meta 는 핸들을 지우기 전에 받은 것이라 `winId` 가 살아 있다(MainSessionManager.destroy).
    closed(meta) {
      pushSend(getWebContents(meta.id), 'session:closed', meta)
    }
  })

  handle('session:create', async (spec) => ({ id: await mgr.create(spec) }))
  handle('session:resize', ({ id, cols, rows }) => {
    mgr.resize(id, cols, rows)
    return { ok: true } as const
  })
  handle('session:destroy', ({ id }) => {
    mgr.destroy(id)
    return { ok: true } as const
  })
  handle('session:list', () => mgr.snapshot())
  handle('session:rename', ({ id, title }) => {
    mgr.rename(id, title)
    return { ok: true } as const
  })
  handle('session:setAiCli', ({ id, aiCli }) => {
    mgr.setAiCli(id, aiCli)
    return { ok: true } as const
  })
  handle('session:autoTitle', ({ id, title }) => {
    // main 이 제목을 다듬을 수 있다(tidyShellTitle) — 화면은 돌려준 값을 그린다.
    const applied = mgr.autoTitle(id, title)
    return applied === null ? { applied: false } : { applied: true, title: applied }
  })
  handle('session:attach', ({ id }) => ({ backlog: mgr.attach(id) }))

  on('session:input', (p) => {
    const { id, data } = p as { id: string; data: string }
    onHumanInput?.(id)
    mgr.write(id, data)
  })
  on('session:pause', (p) => mgr.pause((p as { id: string }).id))
  on('session:resume', (p) => mgr.resume((p as { id: string }).id))

  return mgr
}
