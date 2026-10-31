// M1 라운드 2 AI 작업 공간 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. AI 작업 공간을 처음 열 때만
// 그 화면 코드를 불러온다(진입 청크에 안 실린다). 쓰는 쪽은 <Suspense> 안에 둔다.
import { lazy } from 'react'

export const AiRail = lazy(() => import('./AiSpace').then((m) => ({ default: m.AiRail })))
/** AI 작업 공간이 Shell 에 알리는 위치 — 타이틀바 crumb 과 상태바 왼쪽 글. */
export type AiwsLocation = { crumb: { server: string; path: string | null }; status: string | null }

export const AiHome = lazy(() => import('./AiSpace').then((m) => ({ default: m.AiHome })))
/** M3 설정 › AI 작업 공간 › 에이전트(감지·켜고 끄기·실행 설정). 설정 화면이 그 섹션을 열 때 불러온다. */
export const AgentSettings = lazy(() => import('./AgentSettingsPanel').then((m) => ({ default: m.AgentSettingsPanel })))
