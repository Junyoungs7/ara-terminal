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
  getWebContents: () => WebContents | null,
  onExit?: (id: string) => void,
  onHumanInput?: (id: string) => void
): MainSessionManager {
  const mgr = new MainSessionManager({
    data(id, chunk) {
      // Uint8Array를 message 인자로 전달(백프레셔 메커니즘 3, 단일 복사).
      pushMessage(getWebContents(), `session:data:${id}`, chunk)
    },
    exit(id, exitCode, signal) {
      // F8: 창이 이미 죽었어도 포워딩 리스너는 반드시 접어야 한다 — 알림 전에 정리한다.
      onExit?.(id)
      pushSend(getWebContents(), `session:exit:${id}`, { id, exitCode, signal })
    },
    // F7: OSC7 cwd 변경 → SFTP 트리 자동 이동(터미널→트리 동기).
    cwd(id, cwd) {
      pushSend(getWebContents(), `session:cwd:${id}`, { id, cwd })
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
  // F30: 조용한 AI 세션 판정용. 화면에 안 보이는 탭은 renderer 로 데이터가 안 나가므로 여기서 센다.
  handle('session:activity', () => mgr.activity())
  handle('session:rename', ({ id, title }) => {
    mgr.rename(id, title)
    return { ok: true } as const
  })
  handle('session:autoTitle', ({ id, title }) => ({ applied: mgr.autoTitle(id, title) }))
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
