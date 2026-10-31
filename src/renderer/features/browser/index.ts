// 내장 브라우저 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 탭 줄 창(#browserwin)을 처음 열 때만
// 그 코드를 불러온다(진입 청크에 안 실린다). 쓰는 쪽은 <Suspense> 안에 둔다.
import { lazy } from 'react'

export const BrowserTabStrip = lazy(() => import('./BrowserWindow').then((m) => ({ default: m.BrowserWindow })))
