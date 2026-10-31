// M1 라운드 2 AI 작업 공간 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. AI 작업 공간을 처음 열 때만
// 그 화면 코드를 불러온다(진입 청크에 안 실린다). 쓰는 쪽은 <Suspense> 안에 둔다.
import { lazy } from 'react'

export const AiRail = lazy(() => import('./AiSpace').then((m) => ({ default: m.AiRail })))
export const AiHome = lazy(() => import('./AiSpace').then((m) => ({ default: m.AiHome })))
