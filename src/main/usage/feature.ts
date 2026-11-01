// M9 AI-10 사용량 — 기능 틀(docs/feature-module.md)의 main 등록 함수. IPC `usage:get`·`usage:refresh`, 창 push `usage:update`.
// 갱신(Orca service-polling·service-configuration): 시작 1초 뒤 한 번(창이 활성일 때), 창이 포커스를 받을 때 refreshPlan 대로,
// 15분마다(창이 보이고 포커스가 있을 때만). 사람이 팝오버에서 누르면 바로. 상시 폴러는 이 15분 타이머 하나뿐이다.
import { app, net, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { DEFAULT_POLL_MS } from '@shared/usage'
import { handle } from '../ipc/handle'
import { pushSend } from '../util/windowPush'
import { createUsageService, type FetchLike, type UsageService } from './service'

const STARTUP_DELAY_MS = 1000

export function registerUsageFeature(deps: {
  /** 자격 파일을 찾을 홈. e2e 는 임시 홈 — 사용자 실제 ~/.claude·~/.codex 를 읽지 않는다. */
  home: string
  /** CLAUDE_CONFIG_DIR·CODEX_HOME 을 볼 환경(e2e 는 빈 객체). */
  env: Record<string, string | undefined>
  mainWindow: () => BrowserWindow | null
  mainWc: () => WebContents | null
}): UsageService {
  const active = (): boolean => {
    const w = deps.mainWindow()
    try {
      return Boolean(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused())
    } catch {
      return false
    }
  }
  const service = createUsageService({
    claudeDir: () => deps.env['CLAUDE_CONFIG_DIR'] || join(deps.home, '.claude'),
    codexDir: () => deps.env['CODEX_HOME'] || join(deps.home, '.codex'),
    fetch: ((url, init) => net.fetch(url, init)) as FetchLike,
    push: (s) => pushSend(deps.mainWc(), 'usage:update', s),
    windowActive: active
  })
  handle('usage:get', () => service.state())
  handle('usage:refresh', () => service.refresh(true))

  app.on('browser-window-focus', (_e, w) => {
    if (w === deps.mainWindow() && active()) void service.refresh()
  })
  setTimeout(() => {
    if (active()) void service.refresh()
  }, STARTUP_DELAY_MS)
  setInterval(() => void service.poll(), DEFAULT_POLL_MS)
  return service
}
