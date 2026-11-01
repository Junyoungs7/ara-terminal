// M9 R2 Oriel — 기능 틀(docs/feature-module.md)의 main 등록 함수. 링크 열기(`oriel:open`)·설치 상태(`oriel:status`).
// 아라 내장 브라우저(main/browser)는 이 라운드에서 지웠다 — 결정 :162 "브라우저는 무조건 Oriel(별도 창)".
import { app, shell } from 'electron'
import { join } from 'node:path'
import { handle } from '../ipc/handle'
import { orielCandidates } from '@shared/oriel'
import { araElectronForOriel, araOrielRunner, createOriel, type Oriel } from './oriel'

/** @param setting 설정 › 에이전트의 Oriel 위치(빈 값 = 자동 — 설치본 동봉 자리·개발 PC 체크아웃). */
export function registerOrielFeature(setting: () => string): Oriel {
  const oriel = createOriel({
    // e2e 는 이 PC 의 진짜 Oriel 을 찾지 않는다(미설치로 본다) — ARA_E2E_ORIEL 로 가짜 자리를 줄 수 있다.
    candidates: () =>
      process.env['ARA_E2E'] === '1' ? (process.env['ARA_E2E_ORIEL'] ? [process.env['ARA_E2E_ORIEL']] : []) : orielCandidates(setting(), app.isPackaged ? process.resourcesPath : null),
    openExternal: (url) => shell.openExternal(url),
    // 결정(oriel-integration.md 확정): Oriel 은 아라의 Electron 으로 뜬다. 개발판 = 후보 둘(실행 중 바이너리·cwd 의 node_modules) 중 default_app 있는 것,
    // 설치본 = A.R.A.exe 가 Oriel 호스트(OR-2 안 A, main/boot.ts). CLI 자체도 아라 Electron 을 node 로(node 없는 PC).
    runner: (dir) =>
      araOrielRunner(dir, {
        execPath: process.execPath,
        devElectron: araElectronForOriel([process.execPath, join(process.cwd(), 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')]),
        resourcesPath: app.isPackaged ? process.resourcesPath : null
      })
  })
  // 화면(링크 Ctrl+클릭·포트 [열기]·변경 기록)에서만 오는 IPC = 사용자 동작 → 전경 허락. MCP oriel_open 은 oriel.open(url) 그대로(허락 없음).
  handle('oriel:open', async ({ url }) => {
    const r = await oriel.open(typeof url === 'string' ? url : '', { gesture: true })
    return { ok: r !== false, ...(r ? { via: r } : {}) }
  })
  handle('oriel:status', ({ force }) => oriel.status(force === true))
  return oriel
}
