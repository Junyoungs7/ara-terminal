import type { SettingsSection } from '@shared/settingsIndex'

/**
 * 설정 딥링크 — 어느 화면에서든 `openSettings('ai', 'ai.key')` 로 그 섹션·항목을 연다(Orca openSettingsTarget).
 * 설정 페이지의 주인(MainArea)이 여는 함수를 넣는다. 섹션 없이 부르면 마지막에 보던 자리로 연다.
 */
export type SettingsTarget = { section: SettingsSection; item?: string }

let opener: ((target?: SettingsTarget) => void) | null = null
export const setSettingsOpener = (fn: ((target?: SettingsTarget) => void) | null): void => {
  opener = fn
}
export const openSettings = (section?: SettingsSection, item?: string): void =>
  opener?.(section ? { section, item } : undefined)
