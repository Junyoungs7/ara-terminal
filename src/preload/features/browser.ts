// 내장 브라우저 — 기능 틀(docs/feature-module.md)의 preload 다리. preload/index.ts 가 api 에 펼쳐 넣는다.
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EvApi } from '@shared/ipc'
import type { BrowserTabView } from '@shared/browserWin'

export const browserBridge: Pick<EvApi, 'browser' | 'browserTabs'> = {
  // 내장 브라우저 탭 줄 전용. 이 API 는 **#browserwin 창의 최상위 프레임**만 본다 —
  // 페이지 본문은 preload 없는 WebContentsView 라 여기 닿을 수 없다.
  browserTabs: {
    select: (id: string) => ipcRenderer.invoke('browser:select', { id }),
    closeTab: (id: string) => ipcRenderer.invoke('browser:closeTab', { id }),
    closeOrigin: (origin: string) => ipcRenderer.invoke('browser:closeOrigin', { origin }),
    reload: () => ipcRenderer.invoke('browser:reload', {}),
    back: () => ipcRenderer.invoke('browser:back', {}),
    onTabs: (cb: (e: { tabs: BrowserTabView[]; activeId: string | null }) => void) => {
      const listener = (_e: IpcRendererEvent, d: { tabs: BrowserTabView[]; activeId: string | null }) => cb(d)
      ipcRenderer.on('browser:tabs', listener)
      return () => ipcRenderer.removeListener('browser:tabs', listener)
    }
  },
  // W2 F8: 내장 브라우저 창(preload 미주입 · 전용 파티션). 스킴 검증은 main 이 다시 한다.
  browser: {
    open: (url: string) => ipcRenderer.invoke('browser:open', { url })
  }
}
