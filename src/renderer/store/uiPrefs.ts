import { useCallback, useEffect, useState } from 'react'
import {
  aiModelsOf,
  DEFAULT_AI_PROVIDER,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SESSION_LOG,
  DEFAULT_UI_SCALE,
  type UiPrefs
} from '@shared/types'
import { applyTermPrefsToAll } from '../terminal/termRegistry'
import { activityHiddenOf, activityOrderOf } from './activityBar'
import { applyUiPrefs, prefsFrom, termPrefs } from '../terminal/termPrefs'

// R5 터미널 동작 설정 단일 소스(useFont·useSidebar 와 같은 형태):
// workspace.json ui → 하이드레이트 → 열린 xterm 즉시 반영 → ui.setPrefs 로 영속.
//
// 우클릭 메뉴 스타일도 여기 있다. R4 까지는 MainArea 가 부트 스냅샷에서 따로 읽어 자기 상태로 들고
// 있었는데, 설정 창에서 바꾸면 두 벌을 맞춰야 한다 — 값의 주인을 이 훅 하나로 모은다.

const DEFAULT_PREFS: UiPrefs = {
  ctxMenuStyle: 'list',
  uiScale: DEFAULT_UI_SCALE,
  ...termPrefs,
  sessionLog: DEFAULT_SESSION_LOG,
  logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModels: aiModelsOf(undefined),
  aiCompatibleBaseUrl: '',
  activityOrder: activityOrderOf(undefined),
  activityHidden: activityHiddenOf(undefined)
}

export function useUiPrefs() {
  const [prefs, setPrefs] = useState<UiPrefs>(DEFAULT_PREFS)

  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => {
        const p = prefsFrom(snap.ui)
        applyUiPrefs(p) // 이후 만들어질 xterm 이 읽어 갈 값.
        setPrefs(p)
      })
      .catch(() => {})
  }, [])

  const update = useCallback((patch: Partial<UiPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      applyUiPrefs(next)
      applyTermPrefsToAll(next.scrollback, next.cursorStyle, next.cursorBlink)
      // 하네스(ui:setPrefs 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
      window.ev?.ui.setPrefs(next).catch(() => {})
      return next
    })
  }, [])

  return { prefs, update }
}
