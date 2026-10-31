// FD-01 자원 관리자 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 상태바 [자원] 칸을 처음 열 때만
// 팝오버 코드를 불러온다(진입 청크에 안 실린다). 쓰는 쪽은 <Suspense> 안에 둔다.
import { lazy } from 'react'

export const ResourcePopover = lazy(() => import('./ResourcePopover').then((m) => ({ default: m.ResourcePopover })))
