// M14 R1 AU-01 예약 실행 띄우기 — Orca useAutomationDispatchEvents·automation-dispatch-handler 의 아라 몫. 본창만 건다(main.tsx).
// 받으면 그때 AI 작업 공간의 에이전트 저장소를 불러와(처음 한 번) 그 작업 단위에 에이전트 탭을 띄운다. 화면은 옮기지 않는다(Orca: 예약·지금 실행은 뒤에서).
import type { AutomationDispatchRequest } from '@shared/automations/automations-types'

async function onDispatch({ automation, run }: AutomationDispatchRequest): Promise<void> {
  const mark = (status: 'dispatched' | 'dispatch_failed', p: { sessionId?: string; error?: string } = {}): Promise<void> =>
    window.ev.automations.markDispatchResult({ runId: run.id, status, sessionId: p.sessionId ?? null, error: p.error ?? null })
  try {
    const { useAgentStore } = await import('../aiws/agentStore')
    const r = await useAgentStore.getState().launchAgent({ agent: automation.agentId, worktreeId: automation.workspaceId, cwd: automation.workspacePath, prompt: automation.prompt })
    await (r.ok ? mark('dispatched', { sessionId: r.sessionId }) : mark('dispatch_failed', { error: r.error }))
  } catch (e) {
    await mark('dispatch_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

export function installAutomationDispatch(): void {
  window.ev.automations.onDispatch((req) => void onDispatch(req))
  void window.ev.automations.rendererReady()
}
