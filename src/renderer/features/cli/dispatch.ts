// M14 R2 `ara` CLI — 본창이 받는 부탁 둘(main.tsx 가 본창에만 건다). 받으면 그때 AI 작업 공간 코드를 불러온다.
//  · cli:launchAgent — 그 작업 단위에 에이전트 탭(앱의 [+] 와 같은 launchAgent). 화면은 옮기지 않는다(Orca: CLI 로 띄운 것은 뒤에서).
//  · cli:worktreesChanged — CLI 가 메모·상태를 쓰거나 작업 단위를 지웠다. 이미 불러온 목록만 다시 읽는다(안 연 공간은 열 때 읽는다).
import type { CliLaunchAgentRequest } from '@shared/ipc'

async function onLaunch({ reqId, agent, worktreeId, cwd, prompt }: CliLaunchAgentRequest): Promise<void> {
  try {
    const { ensureAiwsLoaded } = await import('../aiws/store')
    // 원격 프로젝트면 그 서버에서 띄워야 한다 — launchAgent 가 프로젝트 목록에서 host 를 찾으므로 먼저 불러 둔다.
    await ensureAiwsLoaded()
    const { useAgentStore } = await import('../aiws/agentStore')
    const r = await useAgentStore.getState().launchAgent({ agent, worktreeId, cwd, ...(prompt ? { prompt } : {}) })
    await window.ev.cli.launchAgentResult(reqId, r)
  } catch (e) {
    await window.ev.cli.launchAgentResult(reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

async function onChanged(repoId: string): Promise<void> {
  const { useAiwsStore } = await import('../aiws/store')
  const s = useAiwsStore.getState()
  if (s.worktreesByRepo[repoId]) await s.fetchWorktrees(repoId)
}

export function installCliDispatch(): void {
  window.ev.cli.onLaunchAgent((req) => void onLaunch(req))
  window.ev.cli.onWorktreesChanged(({ repoId }) => void onChanged(repoId).catch(() => {}))
}
