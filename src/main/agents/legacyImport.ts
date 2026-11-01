// M3 S1 데이터 이전(한 번) — 옛 터미널 AI 의 workspace.json 키를 AI 작업 공간으로 옮기고 지운다.
//  · aiSessions(작업대) 로컬 줄 → 그 폴더를 프로젝트로(repos:add 와 같은 길 — git 이면 뿌리, 아니면 폴더 프로젝트, 같은 경로는 한 번).
//  · 원격 줄 → 옮길 곳이 없다(원격 에이전트 M8). 개수만 한 번 알린다.
//  · ui.aiCliFlags → 에이전트 설정이 처음 한 번 옮긴다(agents/feature.ts migrateAiCliFlags — 이 함수보다 먼저 돈다).
//  · ui.aiCliRecent(서버·폴더 이름뿐) → 버린다.
// 멱등: 옮긴 뒤 키를 지우므로 두 번째는 할 일이 없다. 옮기다 죽으면 다음 부팅에 다시 돌고, 프로젝트 추가는 같은 경로를 두 번 넣지 않는다.
// 안내는 렌더러가 부팅 때 한 번 받아 알림 센터에 올린다(agents:legacyNotice — 받으면 비운다).
import { handle } from '../ipc/handle'
import { logMainError } from '../log/MainErrorLog'
import { legacyAiSessions } from '@shared/aiSession'
import type { LegacyAiNotice } from '@shared/ipc'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'
import type { WorktreeService } from '../worktrees/service'

export async function importLegacyAi(
  ws: Pick<WorkspaceStore, 'get' | 'clearLegacyAi'>,
  addProject: WorktreeService['addProject']
): Promise<LegacyAiNotice | null> {
  const legacy = legacyAiSessions(ws.get().aiSessions)
  const projects = new Map<string, string>()
  // 없어진 폴더는 건너뛴다(addProject 가 notFound) — 지어내지 않는다.
  for (const path of legacy.local) {
    const r = await addProject(path)
    if (r.ok) projects.set(r.project.id, r.project.displayName)
  }
  ws.clearLegacyAi()
  return projects.size > 0 || legacy.remote > 0 ? { projects: [...projects.values()], remote: legacy.remote } : null
}

export function registerLegacyAiImport(ws: WorkspaceStore, addProject: WorktreeService['addProject']): void {
  let pending: Promise<LegacyAiNotice | null> = importLegacyAi(ws, addProject).catch((e: unknown) => {
    logMainError('legacy ai import', e)
    return null
  })
  handle('agents:legacyNotice', async () => {
    const n = await pending
    pending = Promise.resolve(null)
    return n
  })
}
