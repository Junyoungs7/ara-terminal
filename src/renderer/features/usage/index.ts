// M9 AI-10 사용량 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 상태바 사용량 칸을 처음 누를 때만 팝오버 코드를 불러온다.
import { lazy } from 'react'

export const UsagePopover = lazy(() => import('./UsagePopover').then((m) => ({ default: m.UsagePopover })))
