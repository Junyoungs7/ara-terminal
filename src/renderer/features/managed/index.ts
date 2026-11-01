// M8 관리형 서버 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 설정 화면이 그 섹션을 열 때 불러온다(진입 청크에 안 실린다).
import { lazy } from 'react'

export const ManagedServers = lazy(() => import('./ManagedServersPanel').then((m) => ({ default: m.ManagedServersPanel })))
