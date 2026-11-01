// M9 AI-10 사용량 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 상태바 사용량 칸을 처음 누를 때만 팝오버 코드를 불러온다.
import { lazy } from 'react'

export const UsagePopover = lazy(() => import('./UsagePopover').then((m) => ({ default: m.UsagePopover })))
// M13 설정 › 계정·사용량(%사용/%남음 · Gemini · 계정 여러 개 · 통계) — 설정 화면이 그 섹션을 열 때만 불러온다.
export const UsageSettings = lazy(() => import('./UsageSettingsPanel').then((m) => ({ default: m.UsageSettingsPanel })))
