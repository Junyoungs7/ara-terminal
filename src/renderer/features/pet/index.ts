// p3-M21 펫 — 렌더러 진입점(docs/feature-module.md). 켰을 때만 덮개 청크를 불러온다.
import { lazy } from 'react'

export const PetOverlay = lazy(() => import('./PetOverlay'))
