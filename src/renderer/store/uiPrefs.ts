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
import { aiCliFlagsOf } from '../../shared/aiCli'
import { applyUiPrefs, prefsFrom, termPrefs } from '../terminal/termPrefs'

// R5 터미널 동작 설정 단일 소스(useFont·useSidebar 와 같은 형태):
// workspace.json ui → 하이드레이트 → 열린 xterm 즉시 반영 → ui.setPrefs 로 영속.

const DEFAULT_PREFS: UiPrefs = {
  uiScale: DEFAULT_UI_SCALE,
  ...termPrefs,
  sessionLog: DEFAULT_SESSION_LOG,
  logRetentionDays: DEFAULT_LOG_RETENTION_DAYS,
  sessionLogDir: '',
  appLogDir: '',
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModels: aiModelsOf(undefined),
  aiCompatibleBaseUrl: '',
  aiCliFlags: aiCliFlagsOf(undefined),
  araCallName: '',
  araWelcomeSeen: false,
  bootSplash: true
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
