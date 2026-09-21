// workspace 도메인 IPC 핸들러 (계획서 §B.2). 채널명은 shared/ipc.ts 계약과 일치.
// F11 명령어 히스토리도 여기서 받는다 — userData 에 JSON 을 얹는 같은 영속 도메인이라
// registrar 를 하나 더 만들 이유가 없다(저장 파일만 다르다: workspace.json / history.json).
import { join, isAbsolute } from 'node:path'
import { app } from 'electron'
import { detachedWindowStates } from '../windows/SessionWindows'
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
    // F32 R2: 창 자리는 **여기서 main 이 붙인다.** 렌더러는 자기 창 크기는 알아도 다른 창 것은
    // 모르고, 애초에 신뢰 경계 밖 입력으로 창 좌표를 정하지 않는다(update 의 세 필드 화이트리스트와
    // 같은 원칙). 저장 시점마다 지금 떠 있는 창을 그대로 찍는다 — 창을 다 닫았으면 빈 배열이 가서
    // 옛 자리가 지워진다.
    store.setDetachedWindows(detachedWindowStates())
    return { ok: true } as const
  })
  // #128: 작업대 목록. update() 의 세 필드 화이트리스트를 넓히지 않으려고 자기 채널로 온다.
  handle('aisession:save', ({ list }) => {
    store.setAiSessions(list)
    return { ok: true } as const
  })
  handle('ui:setPrefs', (prefs) => {
    store.setPrefs(prefs)
    onPrefs?.(prefs)
    return { ok: true } as const
  })
  handle('ui:setGroups', ({ groups, order, parents }) => {
    // #193: order·parents 는 선택이다 — 안 오면 store 가 기존 값을 그대로 둔다.
    store.setGroups(Array.isArray(groups) ? groups : [], { order, parents })
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
  /**
   * 지금 **실제로 쓰이는** 기록 폴더(2026-08-23 설정). 저장값이 비어 있으면 기본 자리를 쓰는데,
   * 그 기본이 어디인지는 main 만 안다 — 화면이 "(기본) …\logs" 라고 보여 줄 수 있게 셋을 준다.
   */
  handle('app:logPaths', () => {
    const defaultDir = join(app.getPath('userData'), 'logs')
    const ui = store.get().ui
    const pick = (v: string | undefined): string => (v && isAbsolute(v) ? v : defaultDir)
    return { sessionLogDir: pick(ui.sessionLogDir), appLogDir: pick(ui.appLogDir), defaultDir }
  })

  // F11 명령어 히스토리. 렌더러가 보내는 값은 신뢰 경계 밖이라 HistoryStore 가 형을 확인하고
  // scope 당 상한을 강제한다. 비밀 마스킹도 HistoryStore 가 한다 — 렌더러의 프롬프트 판정(shouldRecord)은
  // 화면을 봐야 알 수 있는 것만 거르고, 명령줄에 박힌 비밀(`mysql -pSECRET`)은 여기서 지운다.
  handle('history:load', ({ scope }) => ({ entries: typeof scope === 'string' ? history.load(scope) : [] }))
  handle('history:append', ({ scope, command }) => {
    history.append(scope, command)
    return { ok: true } as const
  })
  // #204 [명령 기록 지우기]. 목록은 통 이름과 줄 수만 준다 — 화면이 내용을 그리지 않는다.
  handle('history:scopes', () => ({ path: history.path, scopes: history.scopes() }))
  handle('history:clear', ({ scope }) => {
    // 렌더러가 보낸 값은 신뢰 경계 밖이다. 문자열이 아니면 "전부"로 읽지 않고 아무것도 안 지운다 —
    // 잘못 온 요청이 통 하나 대신 전부를 날리는 쪽으로 기울면 안 된다.
    if (scope !== undefined && typeof scope !== 'string') return { ok: true } as const
    history.clear(scope)
    return { ok: true } as const
  })
}
