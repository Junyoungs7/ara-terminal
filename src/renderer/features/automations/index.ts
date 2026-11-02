// M14 R1 예약 실행·스킬·MCP 서버 — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 설정이 그 섹션을 열 때만 불러온다.
import { lazy } from 'react'

export const AutomationsSettings = lazy(() => import('./AutomationsPanel').then((m) => ({ default: m.AutomationsPanel })))
export const SkillsSettings = lazy(() => import('./SkillsPanel').then((m) => ({ default: m.SkillsPanel })))
export const McpServersSettings = lazy(() => import('./McpPanel').then((m) => ({ default: m.McpPanel })))
