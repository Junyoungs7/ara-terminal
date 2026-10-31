// 내장 브라우저 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 이 기능의 IPC 는 전부 여기서 건다.
// (2026-11 전까지 registerForwardIpc 안에 있었다. 그 파일이 지금도 이 함수를 불러 index.ts 는 그대로다.)
import type { BrowserWindow } from 'electron'
import { handle } from '../ipc/handle'
import {
  closeTab,
  closeTabByOrigin,
  createBrowserService,
  goBackActive,
  reloadActive,
  selectTab,
  type BrowserService
} from './BrowserTabs'

export function registerBrowserFeature(getMainWindow: () => BrowserWindow | null): BrowserService {
  const browser = createBrowserService(getMainWindow)
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
  return browser
}
