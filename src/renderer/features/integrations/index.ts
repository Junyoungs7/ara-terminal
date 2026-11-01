// M15 연동(GitLab·Slack) — 기능 틀(docs/feature-module.md)의 렌더러 진입점. 설정 섹션·소스 제어가 그릴 때만 불러온다.
import { lazy } from 'react'

const load = () => import('./IntegrationsPanels')
export const GitLabSettings = lazy(() => load().then((m) => ({ default: m.GitLabSettingsPanel })))
export const SlackSettings = lazy(() => load().then((m) => ({ default: m.SlackSettingsPanel })))
export const GitLabMrList = lazy(() => load().then((m) => ({ default: m.GitLabMrList })))
export const GitLabMrCreate = lazy(() => load().then((m) => ({ default: m.GitLabMrCreate })))
