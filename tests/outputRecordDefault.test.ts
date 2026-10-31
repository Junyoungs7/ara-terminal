// DLP: 터미널 출력이 디스크에 남는 유일한 길은 F12 세션 기록이다 — 사용자가 켜기 전에는 꺼져 있어야 하고,
// 켠 값은 그대로 따라야 한다(main 쪽 `savedUi.sessionLog ?? DEFAULT_SESSION_LOG` 도 같은 상수를 쓴다).
import { describe, it, expect } from 'vitest'
import { DEFAULT_SESSION_LOG, type UiState } from '../src/shared/types'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'

describe('터미널 출력 기록 기본값', () => {
  it('설정이 비어 있으면 꺼짐', () => {
    expect(DEFAULT_SESSION_LOG).toBe(false)
    expect(prefsFrom({} as UiState).sessionLog).toBe(false)
  })
  it('사용자가 켠 값은 존중', () => {
    expect(prefsFrom({ sessionLog: true } as UiState).sessionLog).toBe(true)
  })
})
