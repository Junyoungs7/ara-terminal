import {
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_SCROLLBACK,
  SCHEMA_VERSION,
  type WorkspaceSnapshot
} from '@shared/types'

// 첫 실행/손상 폴백용 빈 워크스페이스 (계획서 §B.3 "안전 부팅").
export function defaultSnapshot(appVersion: string): WorkspaceSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    app: { version: appVersion },
    profiles: [],
    knownHosts: {},
    layout: { type: 'pane', sessionId: null },
    sessions: [],
    tabGroups: [],
    ui: {
      sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
      ctxMenuStyle: 'list',
      font: { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 },
      locale: 'ko',
      scrollback: DEFAULT_SCROLLBACK,
      copyOnSelect: DEFAULT_COPY_ON_SELECT
    }
  }
}
