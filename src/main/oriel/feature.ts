// M9 R2 Oriel — 기능 틀(docs/feature-module.md)의 main 등록 함수. 링크 열기(`oriel:open`)·설치 상태(`oriel:status`).
// 아라 내장 브라우저(main/browser)는 이 라운드에서 지웠다 — 결정 :162 "브라우저는 무조건 Oriel(별도 창)".
import { shell } from 'electron'
import { handle } from '../ipc/handle'
import { orielCandidates } from '@shared/oriel'
import { araOrielRunner, createOriel, orielControlFile, orielKindOf, type Oriel } from './oriel'

/** @param setting 설정 › 에이전트의 사용할 Oriel(빈 값 = 자동 — 실행 중 > 단독 설치본 > 개발 PC 체크아웃, 경로 = 그것만). */
export function registerOrielFeature(setting: () => string): Oriel {
  const oriel = createOriel({
    // e2e 는 이 PC 의 진짜 Oriel 을 찾지 않는다(미설치로 본다) — ARA_E2E_ORIEL 로 가짜 자리를 줄 수 있다.
    candidates: () =>
      process.env['ARA_E2E'] === '1' ? (process.env['ARA_E2E_ORIEL'] ? [process.env['ARA_E2E_ORIEL']] : []) : orielCandidates(setting(), process.env['LOCALAPPDATA'] ?? null),
    openExternal: (url) => shell.openExternal(url),
    runner: (dir) => araOrielRunner(dir, process.execPath),
    kindOf: (dir) => orielKindOf(dir),
    // Oriel 0.1.4+ 직접 경로(파이프 — CLI 프로세스 없이 즉시). e2e 는 이 PC 의 진짜 Oriel 을 건드리지 않는다.
    controlFile: process.env['ARA_E2E'] === '1' ? null : orielControlFile()
  })
  // 화면(링크 Ctrl+클릭·포트 [열기]·변경 기록)에서만 오는 IPC = 사용자 동작 → 전경 허락. MCP oriel_open 은 oriel.open(url) 그대로(허락 없음).
  handle('oriel:open', async ({ url }) => {
    const r = await oriel.open(typeof url === 'string' ? url : '', { gesture: true })
    return { ok: r !== false, ...(r ? { via: r } : {}) }
  })
  handle('oriel:status', ({ force }) => oriel.status(force === true))
  return oriel
}
