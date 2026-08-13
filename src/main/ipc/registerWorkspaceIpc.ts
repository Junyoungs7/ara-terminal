// workspace 도메인 IPC 핸들러 (계획서 §B.2). 채널명은 shared/ipc.ts 계약과 일치.
// F11 명령어 히스토리도 여기서 받는다 — userData 에 JSON 을 얹는 같은 영속 도메인이라
// registrar 를 하나 더 만들 이유가 없다(저장 파일만 다르다: workspace.json / history.json).
import { app } from 'electron'
import { handle } from './handle'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'
import type { HistoryStore } from '../history/HistoryStore'
import type { UiPrefs } from '@shared/types'

// onPrefs: F12 로거처럼 ui:setPrefs 값을 즉시 반영해야 하는 곳(main/index.ts 가 늦은 바인딩으로 넣는다).
export function registerWorkspaceIpc(
  store: WorkspaceStore,
  history: HistoryStore,
  onPrefs?: (prefs: UiPrefs) => void
): void {
  handle('workspace:load', () => store.get())
  handle('workspace:save', (snapshot) => {
    store.update(snapshot)
    return { ok: true } as const
  })
  handle('ui:setPrefs', (prefs) => {
    store.setPrefs(prefs)
    onPrefs?.(prefs)
    return { ok: true } as const
  })
  handle('ui:setGroups', ({ groups }) => {
    store.setGroups(groups)
    return { ok: true } as const
  })
  handle('ui:setWorkProfiles', ({ list }) => {
    store.setWorkProfiles(Array.isArray(list) ? list : [])
    return { ok: true } as const
  })
  handle('ui:setAiCliRecent', ({ list }) => {
    store.setAiCliRecent(Array.isArray(list) ? list : [])
    return { ok: true } as const
  })
  handle('ui:setFont', (font) => {
    store.setFont(font)
    return { ok: true } as const
  })
  handle('ui:setSidebar', (sidebar) => {
    store.setSidebar(sidebar)
    return { ok: true } as const
  })
  handle('app:getVersion', () => app.getVersion())

  // F11 명령어 히스토리. 렌더러가 보내는 값은 신뢰 경계 밖이라 HistoryStore 가 형을 확인하고
  // scope 당 상한을 강제한다. 비밀 마스킹도 HistoryStore 가 한다 — 렌더러의 프롬프트 판정(shouldRecord)은
  // 화면을 봐야 알 수 있는 것만 거르고, 명령줄에 박힌 비밀(`mysql -pSECRET`)은 여기서 지운다.
  handle('history:load', ({ scope }) => ({ entries: typeof scope === 'string' ? history.load(scope) : [] }))
  handle('history:append', ({ scope, command }) => {
    history.append(scope, command)
    return { ok: true } as const
  })
}
