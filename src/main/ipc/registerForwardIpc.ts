// W2 IPC 핸들러 — F8 포트 포워딩 + 내장 브라우저(F12 로그 폴더는 S4 에서 붙는다).
// 두 도메인이 한 registrar 인 이유: 전부 "터미널 밖으로 나가는 창구"라 스킴·호스트 게이트가 한곳에 모여야
// 리뷰가 쉽다. 채널명은 shared/ipc.ts 계약과 일치.
import { shell, type BrowserWindow } from 'electron'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { createForwardService, type ForwardService } from '../forward/PortForward'
import {
  closeTab,
  closeTabByOrigin,
  createBrowserService,
  goBackActive,
  reloadActive,
  selectTab,
  type BrowserService
} from '../browser/BrowserTabs'

// 반환값은 세션 종료 훅(stopSession)과 앱 종료 정리(stopAll)용.
export function registerForwardIpc(
  sessions: MainSessionManager,
  getMainWindow: () => BrowserWindow | null,
  // F12 로그 폴더(userData/logs). 경로는 main 이 정하고 렌더러는 "열어 달라"만 말할 수 있다.
  logDir: string
): { forwards: ForwardService; browser: BrowserService } {
  const forwards = createForwardService(
    (id) => sessions.sshClient(id),
    (id) => sessions.snapshot().find((s) => s.id === id)?.title
  )
  const browser = createBrowserService(getMainWindow)

  handle('forward:create', ({ sessionId, remotePort, exactPort }) =>
    forwards.create(sessionId, remotePort, exactPort)
  )
  handle('forward:stop', ({ id }) => {
    forwards.stop(id)
    return { ok: true } as const
  })
  handle('forward:list', () => forwards.list())
  // 진입점 스킴 검증(BrowserService 안의 will-navigate 게이트와 이중). 렌더러가 보낸 값은 신뢰하지 않는다.
  handle('browser:open', ({ url }) => ({ ok: typeof url === 'string' && browser.open(url) }))
  // 탭 조작(2026-08-21). 부르는 쪽은 우리 탭 줄뿐이지만, id 는 신뢰하지 않는다 —
  // 목록에 없는 id 면 BrowserTabs 가 조용히 무시한다.
  handle('browser:select', ({ id }) => {
    selectTab(id)
    return { ok: true } as const
  })
  handle('browser:closeTab', ({ id }) => {
    closeTab(id)
    return { ok: true } as const
  })
  // 포트 표의 [닫기] — 탭 id 대신 주소로 닫는다(그쪽은 id 를 모른다).
  handle('browser:closeOrigin', ({ origin }) => ({ ok: closeTabByOrigin(origin) }))
  handle('browser:reload', () => {
    reloadActive()
    return { ok: true } as const
  })
  handle('browser:back', () => {
    goBackActive()
    return { ok: true } as const
  })
  // F12: 로그 폴더를 탐색기로 연다. 경로 인자를 받지 않는다 — 렌더러가 임의 폴더를 열 수 없다.
  handle('sessionlog:reveal', async () => ({ ok: (await shell.openPath(logDir)) === '' }))

  return { forwards, browser }
}
